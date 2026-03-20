import { useState, useCallback, useRef, useEffect } from 'react';

export interface ToolActivity {
  id: string;
  name: string;
  input_preview: string;
  status: 'running' | 'done';
}

export type ChatSegment =
  | { type: 'user'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool'; tool: ToolActivity };

export interface UseAgentChatReturn {
  segments: ChatSegment[];
  isStreaming: boolean;
  error: string | null;
  agentRunning: boolean;
  sendMessage: (text: string) => void;
  closeAgent: () => Promise<void>;
  startAgent: () => Promise<void>;
}

export function useAgentChat(): UseAgentChatReturn {
  const [segments, setSegments] = useState<ChatSegment[]>([]);
  const [isStreaming, setIsStreaming] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
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
          retryDelayRef.current = 1000;
          setAgentRunning(data.agentRunning);
          if (data.agentRunning && !data.waitingForInput) {
            setIsStreaming(true);
          } else {
            setIsStreaming(false);
          }
        } else if (data.type === 'history_segment') {
          // Replay saved segment from server
          if (data.segmentType === 'user') {
            setSegments((prev) => [...prev, { type: 'user', content: data.content }]);
          } else if (data.segmentType === 'text') {
            if (data.content && data.content.trim()) {
              setSegments((prev) => [...prev, { type: 'text', content: data.content }]);
            }
          } else if (data.segmentType === 'tool') {
            setSegments((prev) => [...prev, { type: 'tool', tool: data.tool }]);
          }
        } else if (data.type === 'history_streaming') {
          // Last text segment is still being streamed
          setIsStreaming(true);
        } else if (data.type === 'history_end') {
          // History replay complete — if agent isn't actively streaming, unlock input
          if (!data.streaming) {
            setIsStreaming(false);
          }
        } else if (data.type === 'text_delta') {
          setIsStreaming(true);
          const delta = data.content;
          if (!delta) return; // skip empty deltas
          setSegments((prev) => {
            const last = prev[prev.length - 1];
            if (last && last.type === 'text') {
              const updated = [...prev];
              updated[updated.length - 1] = { type: 'text', content: last.content + delta };
              return updated;
            }
            return [...prev, { type: 'text', content: delta }];
          });
        } else if (data.type === 'tool_start') {
          setSegments((prev) => {
            const updated = [...prev];
            // Mark previous running tools as done
            for (let i = updated.length - 1; i >= 0; i--) {
              const seg = updated[i];
              if (seg.type === 'tool' && seg.tool.status === 'running') {
                updated[i] = { type: 'tool', tool: { ...seg.tool, status: 'done' } };
              }
            }
            // Push new tool segment
            updated.push({
              type: 'tool',
              tool: {
                id: data.id,
                name: data.name,
                input_preview: data.input_preview,
                status: 'running',
              },
            });
            return updated;
          });
        } else if (data.type === 'result') {
          // End of turn — mark running tools done
          setSegments((prev) => {
            const updated = [...prev];
            for (let i = updated.length - 1; i >= 0; i--) {
              const seg = updated[i];
              if (seg.type === 'tool' && seg.tool.status === 'running') {
                updated[i] = { type: 'tool', tool: { ...seg.tool, status: 'done' } };
              }
            }
            // If there's result text and no text segment captured it, add one
            if (data.content && typeof data.content === 'string') {
              const last = updated[updated.length - 1];
              if (!last || last.type !== 'text' || !last.content) {
                updated.push({ type: 'text', content: data.content });
              }
            }
            return updated;
          });
          setIsStreaming(false);
        } else if (data.type === 'ready') {
          setIsStreaming(false);
        } else if (data.type === 'agent_stopped') {
          setAgentRunning(false);
          setIsStreaming(false);
        }
      } catch {
        // ignore malformed events
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      if (!mountedRef.current) return;
      const delay = retryDelayRef.current;
      retryDelayRef.current = Math.min(delay * 2, 10000);
      setTimeout(() => {
        if (mountedRef.current) {
          setSegments([]);
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
    setSegments((prev) => [...prev, { type: 'user', content: text }]);
    setIsStreaming(true);
    setError(null);

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
    setError(null);
  }, []);

  const startAgent = useCallback(async () => {
    try {
      const resp = await fetch('/api/chat/start', { method: 'POST' });
      if (resp.ok) {
        setAgentRunning(true);
        setIsStreaming(true); // Lock input until first response arrives
      }
    } catch {
      // best effort
    }
  }, []);

  return {
    segments,
    isStreaming,
    error,
    agentRunning,
    sendMessage,
    closeAgent,
    startAgent,
  };
}
