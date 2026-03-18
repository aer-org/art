import { useState, useEffect, useRef, useCallback } from 'react';
import { useAgentChat } from '../hooks/useAgentChat.ts';
import './ChatOnboarding.css';

// ── Simple markdown-ish rendering ──

function renderMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>');
}

// ── Components ──

function ChatHeader() {
  return (
    <div className="chat-header">
      <div className="chat-header-title">
        <span className="chat-header-icon">&#9679;</span>
        ART Agent
      </div>
      <div className="chat-header-phase">
        <span className="chat-phase-badge">Analyzing</span>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="chat-typing">
      <span className="chat-typing-dot" />
      <span className="chat-typing-dot" />
      <span className="chat-typing-dot" />
    </div>
  );
}

function MessageBubble({
  role,
  content,
  isStreaming,
}: {
  role: 'user' | 'assistant';
  content: string;
  isStreaming?: boolean;
}) {
  return (
    <div className={`chat-message chat-message--${role}`}>
      <div className="chat-message-avatar">
        {role === 'assistant' ? 'AI' : 'You'}
      </div>
      <div className="chat-message-bubble">
        <div
          className="chat-message-text"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
        />
        {isStreaming && <span className="chat-cursor" />}
      </div>
    </div>
  );
}

// ── Main Component ──

export function AgentChat({ onComplete }: { onComplete: () => void }) {
  const { messages, isStreaming, error, agentRunning, sendMessage, closeAgent } =
    useAgentChat();

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput('');
    sendMessage(text);
  }, [input, isStreaming, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleComplete = useCallback(async () => {
    await closeAgent();
    onComplete();
  }, [closeAgent, onComplete]);

  return (
    <div className="chat-overlay">
      <div className="chat-container">
        <ChatHeader />

        <div className="chat-messages">
          {messages.map((m, i) => (
            <MessageBubble
              key={i}
              role={m.role}
              content={m.content}
              isStreaming={
                isStreaming &&
                i === messages.length - 1 &&
                m.role === 'assistant'
              }
            />
          ))}
          {isStreaming &&
            (messages.length === 0 ||
              messages[messages.length - 1].role === 'user') && (
              <div className="chat-message chat-message--assistant">
                <div className="chat-message-avatar">AI</div>
                <div className="chat-message-bubble">
                  <span className="chat-typing-label">쓰는 중</span>
                  <TypingIndicator />
                </div>
              </div>
            )}
          {error && <div className="chat-error">{error}</div>}
          <div ref={messagesEndRef} />
        </div>

        <div className="chat-bottom">
          {!isStreaming && messages.length > 0 && (
            <button className="chat-continue-btn" onClick={handleComplete}>
              Complete &rarr;
            </button>
          )}
          <div className="chat-input-row">
            <textarea
              className="chat-input"
              placeholder={
                isStreaming ? 'Waiting for response...' : 'Type a message...'
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isStreaming || !agentRunning}
              rows={1}
            />
            <button
              className="chat-send-btn"
              onClick={handleSend}
              disabled={isStreaming || !input.trim() || !agentRunning}
            >
              &#9654;
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
