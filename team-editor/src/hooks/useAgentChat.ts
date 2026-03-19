import { useState, useCallback, useRef, useEffect } from 'react';

export interface ToolActivity {
  id: string;
  name: string;
  input_preview: string;
  status: 'running' | 'done';
}

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolActivity[];
}

export interface UseAgentChatReturn {
  messages: Message[];
  isStreaming: boolean;
  error: string | null;
  agentRunning: boolean;
  sendMessage: (text: string) => void;
  closeAgent: () => Promise<void>;
  startAgent: () => Promise<void>;
}

export function useAgentChat(): UseAgentChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(true); // starts streaming immediately
  const [error, setError] = useState<string | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const streamingTextRef = useRef('');
  const streamingToolsRef = useRef<ToolActivity[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryDelayRef = useRef(1000);
  const mountedRef = useRef(true);

  const connectSSE = useCallback(() => {
    if (!mountedRef.current) return;
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource('/api/chat/stream');
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'connected') {
          retryDelayRef.current = 1000; // reset backoff on successful connect
          setAgentRunning(data.agentRunning);
          if (data.agentRunning) {
            setIsStreaming(true);
          }
        } else if (data.type === 'history_message') {
          // Replay saved history
          setMessages((prev) => [...prev, {
            role: data.role,
            content: data.content,
            tools: data.tools,
          }]);
        } else if (data.type === 'history_partial') {
          // In-progress assistant content from before reconnect
          streamingTextRef.current = data.content || '';
          streamingToolsRef.current = data.tools || [];
          const text = streamingTextRef.current;
          const tools = [...streamingToolsRef.current];
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              const updated = [...prev];
              updated[updated.length - 1] = { role: 'assistant', content: text, tools };
              return updated;
            }
            return [...prev, { role: 'assistant', content: text, tools }];
          });
          setIsStreaming(true);
        } else if (data.type === 'history_end') {
          // History replay complete, now in live mode
        } else if (data.type === 'text_delta') {
          streamingTextRef.current += data.content;
          const text = streamingTextRef.current;
          const tools = [...streamingToolsRef.current];
          setIsStreaming(true);
          setMessages((prev) => {
            if (prev.length === 0) {
              return [{ role: 'assistant', content: text, tools: tools.length > 0 ? tools : undefined }];
            }
            const last = prev[prev.length - 1];
            if (last.role === 'assistant') {
              const updated = [...prev];
              updated[updated.length - 1] = { role: 'assistant', content: text, tools: tools.length > 0 ? tools : undefined };
              return updated;
            }
            return [...prev, { role: 'assistant', content: text, tools: tools.length > 0 ? tools : undefined }];
          });
        } else if (data.type === 'tool_start') {
          // Mark previous running tools as done
          for (const t of streamingToolsRef.current) {
            if (t.status === 'running') t.status = 'done';
          }
          streamingToolsRef.current.push({
            id: data.id,
            name: data.name,
            input_preview: data.input_preview,
            status: 'running',
          });
          const tools = [...streamingToolsRef.current];
          const text = streamingTextRef.current;
          setMessages((prev) => {
            if (prev.length === 0) {
              return [{ role: 'assistant', content: text, tools }];
            }
            const last = prev[prev.length - 1];
            if (last.role === 'assistant') {
              const updated = [...prev];
              updated[updated.length - 1] = { role: 'assistant', content: text, tools };
              return updated;
            }
            return [...prev, { role: 'assistant', content: text, tools }];
          });
        } else if (data.type === 'result') {
          // Structured result from agent — marks end of a turn
          if (data.content && typeof data.content === 'string') {
            const resultText = data.content;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant' && !last.content) {
                const updated = [...prev];
                updated[updated.length - 1] = { role: 'assistant', content: resultText };
                return updated;
              }
              if (!last || last.role === 'user') {
                return [...prev, { role: 'assistant', content: resultText }];
              }
              return prev;
            });
          }
          setIsStreaming(false);
          streamingTextRef.current = '';
          streamingToolsRef.current = [];
        } else if (data.type === 'agent_stopped') {
          setAgentRunning(false);
          setIsStreaming(false);
          streamingTextRef.current = '';
          streamingToolsRef.current = [];
        }
      } catch {
        // ignore malformed events
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      if (!mountedRef.current) return;
      // Exponential backoff reconnect
      const delay = retryDelayRef.current;
      retryDelayRef.current = Math.min(delay * 2, 10000);
      setTimeout(() => {
        if (mountedRef.current) {
          // Clear messages before reconnect — server will replay history
          setMessages([]);
          streamingTextRef.current = '';
          streamingToolsRef.current = [];
          connectSSE();
        }
      }, delay);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connectSSE();
    return () => {
      mountedRef.current = false;
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [connectSSE]);

  const sendMessage = useCallback((text: string) => {
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setIsStreaming(true);
    setError(null);
    streamingTextRef.current = '';
    streamingToolsRef.current = [];

    fetch('/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    }).catch((err) => {
      setError(err.message);
      setIsStreaming(false);
    });
  }, []);

  const closeAgent = useCallback(async () => {
    try {
      await fetch('/api/chat/close', { method: 'POST' });
    } catch {
      // best effort
    }
    setAgentRunning(false);
    setIsStreaming(false);
  }, []);

  const startAgent = useCallback(async () => {
    try {
      const resp = await fetch('/api/chat/start', { method: 'POST' });
      if (resp.ok) {
        setAgentRunning(true);
        setIsStreaming(true);
      }
    } catch {
      // best effort
    }
  }, []);

  return {
    messages,
    isStreaming,
    error,
    agentRunning,
    sendMessage,
    closeAgent,
    startAgent,
  };
}
