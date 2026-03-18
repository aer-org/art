import { useState, useCallback, useRef } from 'react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatState {
  hasAuth: boolean;
  phase: string | null;
  messageCount: number;
}

interface UseSSEChatReturn {
  messages: Message[];
  isStreaming: boolean;
  suggestions: string[];
  error: string | null;
  phase: string | null;
  hasAuth: boolean | null;
  initChat: () => void;
  sendMessage: (text: string) => void;
  advancePhase: () => Promise<{ ok: boolean; phase: string }>;
  checkState: () => Promise<void>;
}

function parseSSELines(text: string): string[] {
  return text
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => {
      const dataLine = chunk
        .split('\n')
        .find((l) => l.startsWith('data: '));
      return dataLine ? dataLine.slice(6) : '';
    })
    .filter(Boolean);
}

export function useSSEChat(): UseSSEChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [hasAuth, setHasAuth] = useState<boolean | null>(null);
  const streamingTextRef = useRef('');

  const checkState = useCallback(async () => {
    try {
      const resp = await fetch('/api/chat/state');
      const state: ChatState = await resp.json();
      setHasAuth(state.hasAuth);
      setPhase(state.phase);
    } catch {
      setHasAuth(false);
    }
  }, []);

  const processStream = useCallback(
    async (response: Response, appendToAssistant: boolean) => {
      if (!response.ok || !response.body) {
        const text = await response.text();
        setError(text || `HTTP ${response.status}`);
        setIsStreaming(false);
        return;
      }

      setIsStreaming(true);
      setError(null);
      setSuggestions([]);
      streamingTextRef.current = '';

      if (appendToAssistant) {
        setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = parseSSELines(buffer);

        // Keep only the incomplete tail in buffer
        const lastDoubleNewline = buffer.lastIndexOf('\n\n');
        if (lastDoubleNewline !== -1) {
          buffer = buffer.slice(lastDoubleNewline + 2);
        }

        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'text_delta') {
              streamingTextRef.current += event.content;
              const text = streamingTextRef.current;
              setMessages((prev) => {
                const updated = [...prev];
                updated[updated.length - 1] = {
                  role: 'assistant',
                  content: text,
                };
                return updated;
              });
            } else if (event.type === 'suggestions') {
              setSuggestions(event.items);
            } else if (event.type === 'done') {
              // Final text — already accumulated via deltas
            } else if (event.type === 'error') {
              setError(event.message);
            }
          } catch {
            // ignore malformed JSON
          }
        }
      }

      setIsStreaming(false);
    },
    [],
  );

  const initChat = useCallback(() => {
    setMessages([]);
    setSuggestions([]);

    fetch('/api/chat/init', { method: 'POST' }).then((resp) => {
      setPhase('analysis');
      processStream(resp, true);
    }).catch((err) => {
      setError(err.message);
    });
  }, [processStream]);

  const sendMessage = useCallback(
    (text: string) => {
      setMessages((prev) => [...prev, { role: 'user', content: text }]);
      setSuggestions([]);

      fetch('/api/chat/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      }).then((resp) => {
        processStream(resp, true);
      }).catch((err) => {
        setError(err.message);
      });
    },
    [processStream],
  );

  const advancePhase = useCallback(async () => {
    const resp = await fetch('/api/chat/advance', { method: 'POST' });
    const result = await resp.json();
    if (result.ok) {
      setPhase(result.phase === 'complete' ? null : result.phase);
      if (result.phase === 'direction') {
        // Reset messages for new phase, keep old ones visible
        setSuggestions([]);
      }
    }
    return result;
  }, []);

  return {
    messages,
    isStreaming,
    suggestions,
    error,
    phase,
    hasAuth,
    initChat,
    sendMessage,
    advancePhase,
    checkState,
  };
}
