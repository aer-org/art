import { useEffect, useRef, useState } from 'react';
import { MarkdownMessage } from './MarkdownMessage.tsx';
import { useChat, type ChatConnectionState, type ChatMessage } from '../hooks/useChat.ts';
import { api, type ChatOptions } from '../lib/api.ts';

function ThinkingBubble({ message }: { message: ChatMessage }) {
  const open = !!message.meta?.open;
  const [expanded, setExpanded] = useState(false);
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    if (!open) {
      setExpanded(false);
      setDotCount(3);
      return;
    }

    setDotCount(1);
    const timer = window.setInterval(() => {
      setDotCount((value) => (value >= 3 ? 1 : value + 1));
    }, 500);
    return () => window.clearInterval(timer);
  }, [open]);

  const label = open ? `Thinking${'.'.repeat(dotCount)}` : 'Thinking...';

  return (
    <div className={`chat-message thinking${open ? ' live' : ''}${expanded ? ' expanded' : ' collapsed'}`}>
      <button
        type="button"
        className="thinking-header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="chevron">{expanded ? '▾' : '▸'}</span>
        <span className="label">{label}</span>
      </button>
      {expanded && (
        <div className="thinking-body">
          {message.text}
          {open && <span className="cursor">▍</span>}
        </div>
      )}
    </div>
  );
}

function hasLiveThinking(messages: ChatMessage[]): boolean {
  return messages.some((message) => message.role === 'thinking' && message.meta?.open);
}

function hasPendingPermission(messages: ChatMessage[]): boolean {
  return messages.some((message) => message.role === 'permission' && message.meta?.permissionPending);
}

function PermissionMessage({
  message,
  onDecision,
}: {
  message: ChatMessage;
  onDecision: (permissionId: string, decision: 'allow_once' | 'allow_project' | 'deny') => void;
}) {
  const permissionId = message.meta?.permissionId;
  const pending = !!message.meta?.permissionPending && !!permissionId;
  const command = message.meta?.command ?? '';
  const decision = message.meta?.permissionDecision;

  return (
    <div className={`chat-message permission${pending ? ' pending' : ''}`}>
      <div className="permission-title">{message.text}</div>
      {message.meta?.permissionDescription && (
        <div className="permission-description">{message.meta.permissionDescription}</div>
      )}
      {command && <pre className="permission-command">{command}</pre>}
      {pending ? (
        <div className="permission-actions">
          <button className="primary" onClick={() => onDecision(permissionId, 'allow_once')}>
            Yes
          </button>
          <button onClick={() => onDecision(permissionId, 'allow_project')}>
            Yes, and allow this command for this project directory
          </button>
          <button className="danger" onClick={() => onDecision(permissionId, 'deny')}>
            No
          </button>
        </div>
      ) : (
        <div className="permission-description">
          {decision === 'allow_project'
            ? 'Allowed for this project directory.'
            : decision === 'allow_once'
              ? 'Allowed once.'
              : 'Denied.'}
        </div>
      )}
    </div>
  );
}

function connectionLabel(state: ChatConnectionState): string {
  switch (state) {
    case 'connecting':
      return 'Connecting...';
    case 'open':
      return 'Ready';
    case 'reconnecting':
      return 'Reconnecting stream...';
    case 'error':
      return 'Debugger stream offline';
    case 'idle':
    default:
      return 'Waiting for debugger...';
  }
}

interface Props {
  projectDir: string | null;
}

export function ChatPanel({ projectDir }: Props) {
  const [options, setOptions] = useState<ChatOptions | null>(null);
  const [model, setModel] = useState<string>('claude-opus-4-6');
  const [effort, setEffort] = useState<string>('max');

  useEffect(() => {
    api.chatOptions().then((opts) => {
      setOptions(opts);
      setModel(opts.defaults.model);
      setEffort(opts.defaults.effort);
    }).catch(() => {});
  }, []);

  const { chatId, messages, busy, connectionState, latestStatus, send, cancel, respondPermission } = useChat(projectDir, { model, effort });
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  function submit() {
    const m = draft.trim();
    if (!m || busy || !chatId) return;
    void send(m);
    setDraft('');
  }

  const streamReady = connectionState === 'open';
  const disabled = !projectDir || !chatId || !streamReady;
  const actionDisabled = busy ? !chatId : disabled || !draft.trim();
  const waitingForPermission = hasPendingPermission(messages);
  const showSyntheticThinking = busy && !waitingForPermission && !hasLiveThinking(messages);

  function handleAction() {
    if (busy) {
      cancel();
      return;
    }
    submit();
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span>Debugger</span>
        <span className="indicator">
          {disabled
            ? !projectDir
              ? 'Load a project to start'
              : connectionLabel(connectionState)
            : busy
              ? waitingForPermission
                ? 'Waiting for permission...'
                : latestStatus ?? 'Waiting for debugger...'
              : 'Ready'}
        </span>
      </div>
      <div className="chat-settings">
        <label>
          Model
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={busy}>
            {(options?.models ?? [
              { id: 'claude-opus-4-6', label: 'Opus 4.6' },
              { id: 'claude-opus-4-7', label: 'Opus 4.7' },
              { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
            ]).map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
        <label>
          Effort
          <select value={effort} onChange={(e) => setEffort(e.target.value)} disabled={busy}>
            {(options?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max']).map((e) => (
              <option key={e} value={e}>{e}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div style={{ color: 'var(--fg-dim)', fontSize: 13 }}>
            Ask about the pipeline. The debugger can run it and read logs itself —
            try “run the pipeline and tell me what failed”.
          </div>
        )}
        {messages.map((m, i) =>
          m.role === 'thinking'
            ? <ThinkingBubble key={i} message={m} />
            : m.role === 'permission'
              ? <PermissionMessage key={i} message={m} onDecision={(id, decision) => void respondPermission(id, decision)} />
            : m.role === 'status'
              ? <div key={i} className="chat-message status">{m.text}</div>
            : (
              <div key={i} className={`chat-message ${m.role}${m.role === 'assistant' ? ' markdown' : ''}`}>
                {m.role === 'assistant' ? <MarkdownMessage text={m.text} /> : m.text}
              </div>
            )
        )}
        {showSyntheticThinking && (
          <ThinkingBubble
            message={{
              role: 'thinking',
              text: latestStatus ?? 'Waiting for the debugger session...',
              meta: { open: true },
              ts: Date.now(),
            }}
          />
        )}
      </div>
      <div className="chat-input">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            const isComposing = e.nativeEvent.isComposing || e.key === 'Process';
            if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={disabled ? connectionLabel(connectionState) : 'Message (Enter to send, Shift+Enter for newline)'}
          disabled={disabled || busy}
        />
        <button
          className={busy ? 'danger chat-action' : 'primary chat-action'}
          disabled={actionDisabled}
          onClick={handleAction}
          title={busy ? 'Stop the active debugger response' : 'Send message'}
        >
          {busy ? 'Stop' : 'Send'}
        </button>
      </div>
    </div>
  );
}
