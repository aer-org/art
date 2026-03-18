import { useState, useEffect, useRef, useCallback } from 'react';
import { useAgentChat } from '../hooks/useAgentChat.ts';
import { DocumentPanel } from './DocumentPanel.tsx';
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

function ChatHeader({ isStreaming, hasMessages, onComplete, onClose }: {
  isStreaming: boolean;
  hasMessages: boolean;
  onComplete: () => void;
  onClose: () => void;
}) {
  return (
    <div className="chat-header">
      <div className="chat-header-title">
        <span className="chat-header-icon">&#9679;</span>
        ART Agent
        <button
          className="chat-close-btn"
          onClick={onClose}
          title="Close"
        >
          &times;
        </button>
      </div>
      <div className="chat-header-phase">
        <span className="chat-phase-badge">
          {isStreaming ? 'Analyzing...' : 'Ready'}
        </span>
        {!isStreaming && hasMessages && (
          <button className="chat-complete-header-btn" onClick={onComplete}>
            Complete &rarr;
          </button>
        )}
      </div>
    </div>
  );
}

const THINKING_STEPS = [
  'Reading project structure...',
  'Analyzing dependencies...',
  'Reviewing architecture...',
  'Evaluating code quality...',
  'Writing analysis...',
];

function ThinkingState() {
  const [stepIdx, setStepIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setStepIdx((i) => (i + 1) % THINKING_STEPS.length);
    }, 3000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="chat-thinking">
      <div className="chat-thinking-orb">
        <div className="chat-thinking-ring" />
        <div className="chat-thinking-ring chat-thinking-ring--delay" />
      </div>
      <div className="chat-thinking-text">
        <div className="chat-thinking-label">Agent is working</div>
        <div className="chat-thinking-step">{THINKING_STEPS[stepIdx]}</div>
      </div>
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
  const { messages, isStreaming, error, agentRunning, sendMessage } =
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

  const handleComplete = useCallback(() => {
    onComplete();
  }, [onComplete]);

  return (
    <div className="chat-overlay">
      <div className="chat-init-layout">
        <ChatHeader
          isStreaming={isStreaming}
          hasMessages={messages.length > 0}
          onComplete={handleComplete}
          onClose={handleComplete}
        />

        <div className="chat-init-panels">
          {/* Left: ANALYSIS.md */}
          <div className="chat-init-doc-panel">
            <DocumentPanel title="ANALYSIS" path="plan/ANALYSIS.md" />
          </div>

          {/* Center: PLAN.md */}
          <div className="chat-init-doc-panel">
            <DocumentPanel title="PLAN" path="plan/PLAN.md" />
          </div>

          {/* Right: Chat */}
          <div className="chat-init-chat-panel">
            <div className="chat-messages">
              {/* Show thinking state when no real content yet */}
              {isStreaming && messages.every((m) => !m.content) && (
                <ThinkingState />
              )}
              {messages.map((m, i) => {
                // Skip empty placeholder messages while thinking
                if (!m.content && isStreaming) return null;
                return (
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
                );
              })}
              {error && <div className="chat-error">{error}</div>}
              <div ref={messagesEndRef} />
            </div>

            <div className="chat-bottom">
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
      </div>
    </div>
  );
}
