import { useState, useCallback, useRef, useEffect } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface UseAgentChatReturn {
  messages: Message[];
  isStreaming: boolean;
  error: string | null;
  agentRunning: boolean;
  sendMessage: (text: string) => void;
  closeAgent: () => Promise<void>;
}

export function useAgentChat(): UseAgentChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(true); // starts streaming immediately
  const [error, setError] = useState<string | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);
  const streamingTextRef = useRef('');
  const eventSourceRef = useRef<EventSource | null>(null);

  // Connect to SSE stream on mount
  useEffect(() => {
    const es = new EventSource('/api/chat/stream');
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'connected') {
          setAgentRunning(data.agentRunning);
          if (data.agentRunning) {
            setIsStreaming(true);
            // Add initial assistant message placeholder
            setMessages((prev) => {
              if (prev.length === 0) {
                return [{ role: 'assistant', content: '' }];
              }
              return prev;
            });
          }
        } else if (data.type === 'text_delta') {
          streamingTextRef.current += data.content;
          const text = streamingTextRef.current;
          setIsStreaming(true);
          setMessages((prev) => {
            if (prev.length === 0) {
              return [{ role: 'assistant', content: text }];
            }
            const last = prev[prev.length - 1];
            if (last.role === 'assistant') {
              const updated = [...prev];
              updated[updated.length - 1] = { role: 'assistant', content: text };
              return updated;
            }
            // New assistant message after user message
            return [...prev, { role: 'assistant', content: text }];
          });
        } else if (data.type === 'result') {
          // Structured result from agent — marks end of a turn
          // If result has content and no text_delta was received, show it
          if (data.content && typeof data.content === 'string') {
            const resultText = data.content;
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'assistant' && !last.content) {
                // Replace empty placeholder with result content
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
        } else if (data.type === 'agent_stopped') {
          setAgentRunning(false);
          setIsStreaming(false);
        }
      } catch {
        // ignore malformed events
      }
    };

    es.onerror = () => {
      setError('Connection to agent lost');
      setIsStreaming(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, []);

  const sendMessage = useCallback((text: string) => {
    // Add user message to UI
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setIsStreaming(true);
    setError(null);
    streamingTextRef.current = '';

    // Send to server which writes IPC file
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

  return {
    messages,
    isStreaming,
    error,
    agentRunning,
    sendMessage,
    closeAgent,
  };
}
