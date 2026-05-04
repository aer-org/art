import { useEffect, useRef, useState } from 'react';
import { api, subscribeSSE } from '../lib/api.ts';

export type ChatEvent =
  | { kind: 'turn-start'; seq?: number; turnId: string; message: string; ts: number }
  | { kind: 'user-message'; seq?: number; text: string; ts: number; turnId?: string }
  | { kind: 'turn-status'; seq?: number; status: TurnLifecycle; message: string; ts: number; turnId?: string }
  | { kind: 'text-delta'; seq?: number; text: string; ts: number; turnId?: string }
  | { kind: 'thinking-delta'; seq?: number; text: string; ts: number; turnId?: string }
  | { kind: 'thinking-stop'; seq?: number; ts: number; turnId?: string }
  | { kind: 'tool-use'; seq?: number; tool: string; input: unknown; toolId: string; ts: number; turnId?: string }
  | { kind: 'tool-result'; seq?: number; toolId: string; output: string; isError: boolean; ts: number; turnId?: string }
  | { kind: 'rate-limit'; seq?: number; status: string; summary: string; ts: number; turnId?: string }
  | {
      kind: 'task-event';
      seq?: number;
      taskId: string;
      status: string;
      summary: string;
      toolUseId?: string;
      ts: number;
      turnId?: string;
    }
  | {
      kind: 'permission-request';
      seq?: number;
      permissionId: string;
      tool: string;
      command: string;
      input: unknown;
      title: string;
      description: string;
      ts: number;
      turnId?: string;
    }
  | {
      kind: 'permission-resolved';
      seq?: number;
      permissionId: string;
      decision: 'allow_once' | 'allow_project' | 'deny';
      command: string;
      ts: number;
      turnId?: string;
    }
  | { kind: 'background-task'; seq?: number; taskId: string; status: 'completed' | 'failed' | 'stopped'; summary: string; ts: number; turnId?: string }
  | { kind: 'done'; seq?: number; ts: number; cost?: number; durationMs?: number; turnId?: string }
  | { kind: 'error'; seq?: number; message: string; ts: number; turnId?: string };

export type TurnLifecycle =
  | 'accepted'
  | 'initializing'
  | 'sent'
  | 'streaming'
  | 'waiting_permission'
  | 'recovering'
  | 'done'
  | 'failed';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'error' | 'background' | 'thinking' | 'permission' | 'status';
  text: string;
  meta?: {
    tool?: string;
    input?: unknown;
    toolId?: string;
    isError?: boolean;
    taskId?: string;
    status?: string;
    open?: boolean;
    turnId?: string;
    permissionId?: string;
    command?: string;
    permissionPending?: boolean;
    permissionDecision?: 'allow_once' | 'allow_project' | 'deny';
    permissionDescription?: string;
  };
  ts: number;
}

export type ChatConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'error';

interface UseChatOptions {
  model: string;
  effort: string;
}

const REQUIRED_CHAT_PROTOCOL_VERSION = 2;

function chatProtocolError(version: number | undefined): string | null {
  if (version === REQUIRED_CHAT_PROTOCOL_VERSION) return null;
  return version === undefined
    ? 'The loaded frontend is talking to an older ART app server. Restart the ART app server so the debugger can use the robust chat protocol.'
    : `The ART app server chat protocol is ${version}, but this frontend requires ${REQUIRED_CHAT_PROTOCOL_VERSION}. Restart the ART app server.`;
}

function stringifyToolInput(input: unknown): string {
  try {
    const json = JSON.stringify(input);
    if (json) return json;
  } catch {
    // fall through
  }
  return String(input ?? '');
}

function commandFromToolInput(input: unknown): string {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const command = (input as { command?: unknown }).command;
    if (typeof command === 'string') return command;
  }
  return stringifyToolInput(input);
}

function isArtRunTool(tool: string, input: unknown): boolean {
  const haystack = `${tool}\n${commandFromToolInput(input)}\n${stringifyToolInput(input)}`;
  return /\bart\s+run\b/i.test(haystack);
}

function hasPendingPermission(messages: ChatMessage[]): boolean {
  return messages.some((message) => message.role === 'permission' && message.meta?.permissionPending);
}

export function useChat(projectDir: string | null, options: UseChatOptions) {
  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ChatConnectionState>('idle');
  const [latestStatus, setLatestStatus] = useState<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const activeTurnIdRef = useRef<string | null>(null);
  const seenEventSeqsRef = useRef<Set<number>>(new Set());

  function setActiveTurn(turnId: string | null) {
    activeTurnIdRef.current = turnId;
    setActiveTurnId(turnId);
  }

  // (Re)create chat session when the loaded project changes.
  useEffect(() => {
    setChatId(null);
    setMessages([]);
    messagesRef.current = [];
    seenEventSeqsRef.current = new Set();
    setActiveTurn(null);
    setLatestStatus(null);
    setConnectionState('idle');
    if (!projectDir) return;
    api.chatSession({ model: options.model, effort: options.effort })
      .then((r) => {
        const protocolError = chatProtocolError(r.chatProtocolVersion);
        if (protocolError) {
          pushMessage({ role: 'error', text: protocolError, ts: Date.now() });
          setLatestStatus('Restart ART app server.');
          setConnectionState('error');
          return;
        }
        setChatId(r.chatId);
      })
      .catch((e) => {
        pushMessage({ role: 'error', text: (e as Error).message, ts: Date.now() });
        setConnectionState('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectDir]);

  // Push setting changes to the active session without losing history.
  useEffect(() => {
    if (!chatId) return;
    api.chatSettings(chatId, { model: options.model, effort: options.effort }).catch(() => {});
  }, [chatId, options.model, options.effort]);

  useEffect(() => {
    if (!chatId) return;
    setConnectionState('connecting');
    const dispose = subscribeSSE(
      `/api/chat/events?chatId=${encodeURIComponent(chatId)}`,
      {
        event: (raw) => handleEvent(raw),
      },
      {
        onOpen: () => setConnectionState('open'),
        onError: () => {
          setConnectionState((current) => (current === 'idle' ? 'error' : 'reconnecting'));
        },
      },
    );
    return () => {
      dispose();
      setConnectionState('idle');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);

  function pushMessage(msg: ChatMessage) {
    messagesRef.current = [...messagesRef.current, msg];
    setMessages([...messagesRef.current]);
  }

  function closeOpenThinking() {
    const last = messagesRef.current[messagesRef.current.length - 1];
    if (last?.role === 'thinking' && last.meta?.open) {
      messagesRef.current = [
        ...messagesRef.current.slice(0, -1),
        { ...last, meta: { ...last.meta, open: false } },
      ];
    }
  }

  function handleEvent(raw: ChatEvent) {
    if (typeof raw.seq === 'number') {
      if (seenEventSeqsRef.current.has(raw.seq)) return;
      seenEventSeqsRef.current.add(raw.seq);
    }

    switch (raw.kind) {
      case 'turn-start': {
        setActiveTurn(raw.turnId);
        setLatestStatus('Debugger turn accepted.');
        return;
      }
      case 'turn-status': {
        setLatestStatus(raw.message);
        if (raw.status === 'failed' || raw.status === 'done') {
          closeOpenThinking();
        }
        pushMessage({
          role: 'status',
          text: raw.message,
          meta: { turnId: raw.turnId, status: raw.status },
          ts: raw.ts,
        });
        return;
      }
      case 'user-message': {
        const last = messagesRef.current[messagesRef.current.length - 1];
        if (last?.role === 'user' && last.text === raw.text) return;
        pushMessage({ role: 'user', text: raw.text, meta: { turnId: raw.turnId }, ts: raw.ts });
        return;
      }
      case 'thinking-delta': {
        const last = messagesRef.current[messagesRef.current.length - 1];
        if (last?.role === 'thinking' && last.meta?.open) {
          messagesRef.current = [
            ...messagesRef.current.slice(0, -1),
            { ...last, text: last.text + raw.text },
          ];
          setMessages([...messagesRef.current]);
        } else {
          pushMessage({ role: 'thinking', text: raw.text, meta: { open: true, turnId: raw.turnId }, ts: raw.ts });
        }
        return;
      }
      case 'thinking-stop': {
        closeOpenThinking();
        setMessages([...messagesRef.current]);
        return;
      }
      case 'text-delta': {
        closeOpenThinking();
        const last = messagesRef.current[messagesRef.current.length - 1];
        if (last?.role === 'assistant') {
          messagesRef.current = [
            ...messagesRef.current.slice(0, -1),
            { ...last, text: last.text + raw.text },
          ];
        } else {
          messagesRef.current = [...messagesRef.current, { role: 'assistant', text: raw.text, meta: { turnId: raw.turnId }, ts: raw.ts }];
        }
        setMessages([...messagesRef.current]);
        return;
      }
      case 'tool-use': {
        closeOpenThinking();
        const argsPreview = stringifyToolInput(raw.input).slice(0, 200);
        const runningArt = isArtRunTool(raw.tool, raw.input);
        pushMessage({
          role: 'tool',
          text: runningArt
            ? 'Running tool: art run for this project...'
            : `🔧 ${raw.tool}: ${argsPreview}`,
          meta: { tool: raw.tool, input: raw.input, toolId: raw.toolId, turnId: raw.turnId },
          ts: raw.ts,
        });
        return;
      }
      case 'rate-limit': {
        pushMessage({
          role: 'status',
          text: `Claude rate limit: ${raw.summary}`,
          meta: { status: raw.status, turnId: raw.turnId },
          ts: raw.ts,
        });
        return;
      }
      case 'task-event': {
        closeOpenThinking();
        pushMessage({
          role: 'background',
          text: `background task ${raw.status}: ${raw.summary}`.slice(0, 240),
          meta: { taskId: raw.taskId, status: raw.status, toolId: raw.toolUseId, turnId: raw.turnId },
          ts: raw.ts,
        });
        return;
      }
      case 'tool-result': {
        pushMessage({
          role: 'tool',
          text: `↳ ${raw.isError ? '❌' : '✅'} ${raw.output.slice(0, 200)}`,
          meta: { toolId: raw.toolId, isError: raw.isError, turnId: raw.turnId },
          ts: raw.ts,
        });
        return;
      }
      case 'permission-request': {
        closeOpenThinking();
        setLatestStatus('Waiting for execution permission.');
        pushMessage({
          role: 'permission',
          text: raw.title,
          meta: {
            permissionId: raw.permissionId,
            command: raw.command,
            permissionPending: true,
            permissionDescription: raw.description,
            tool: raw.tool,
            input: raw.input,
            turnId: raw.turnId,
          },
          ts: raw.ts,
        });
        return;
      }
      case 'permission-resolved': {
        messagesRef.current = messagesRef.current.map((message) => {
          if (message.role !== 'permission' || message.meta?.permissionId !== raw.permissionId) return message;
          return {
            ...message,
            text:
              raw.decision === 'allow_project'
                ? 'Execution allowed for this project'
                : raw.decision === 'allow_once'
                  ? 'Execution allowed once'
                  : 'Execution denied',
            meta: {
              ...message.meta,
              command: raw.command,
              permissionPending: false,
              permissionDecision: raw.decision,
              turnId: raw.turnId,
            },
          };
        });
        setMessages([...messagesRef.current]);
        setLatestStatus(
          raw.decision === 'deny'
            ? 'Execution denied; returning control to Claude.'
            : 'Execution allowed; waiting for tool result.',
        );
        return;
      }
      case 'background-task': {
        closeOpenThinking();
        const icon = raw.status === 'completed' ? '✅' : raw.status === 'failed' ? '❌' : '⏹';
        pushMessage({
          role: 'background',
          text: `${icon} background task ${raw.status}: ${raw.summary}`.slice(0, 240),
          meta: { taskId: raw.taskId, status: raw.status, turnId: raw.turnId },
          ts: raw.ts,
        });
        return;
      }
      case 'done': {
        closeOpenThinking();
        setMessages([...messagesRef.current]);
        setLatestStatus('Ready');
        const active = activeTurnIdRef.current;
        if (!raw.turnId || !active || active === raw.turnId || active.startsWith('local:')) {
          setActiveTurn(null);
        }
        return;
      }
      case 'error': {
        closeOpenThinking();
        pushMessage({ role: 'error', text: raw.message, meta: { turnId: raw.turnId }, ts: raw.ts });
        setLatestStatus(raw.message);
        const active = activeTurnIdRef.current;
        if (!raw.turnId || !active || active === raw.turnId || active.startsWith('local:')) {
          setActiveTurn(null);
        }
        return;
      }
    }
  }

  async function send(message: string) {
    if (!chatId) return;
    if (connectionState !== 'open') {
      pushMessage({ role: 'error', text: 'Debugger event stream is not connected yet. Try again when it reconnects.', ts: Date.now() });
      return;
    }
    pushMessage({ role: 'user', text: message, ts: Date.now() });
    const localTurnId = `local:${Date.now()}`;
    setActiveTurn(localTurnId);
    setLatestStatus('Sending message to debugger...');
    try {
      const result = await api.chatSend(chatId, message);
      if (activeTurnIdRef.current === localTurnId) {
        setActiveTurn(result.turnId);
      }
    } catch (e) {
      pushMessage({ role: 'error', text: (e as Error).message, ts: Date.now() });
      setLatestStatus((e as Error).message);
      setActiveTurn(null);
    }
  }

  function cancel() {
    if (chatId) api.chatCancel(chatId).catch(() => {});
    setLatestStatus('Cancelling debugger turn...');
    setActiveTurn(null);
  }

  async function respondPermission(permissionId: string, decision: 'allow_once' | 'allow_project' | 'deny') {
    if (!chatId) return;
    try {
      await api.chatPermission(chatId, permissionId, decision);
    } catch (e) {
      pushMessage({ role: 'error', text: (e as Error).message, ts: Date.now() });
    }
  }

  const busy = activeTurnId !== null || hasPendingPermission(messages);
  return { chatId, messages, busy, connectionState, latestStatus, send, cancel, respondPermission };
}
