import { useState, useEffect, useRef, useCallback } from 'react';
import { useSSEChat } from '../hooks/useSSEChat.ts';
import './ChatOnboarding.css';

// ── Suggestion parser: strip [SUGGESTION]...[/SUGGESTION] from display text ──

function stripSuggestionTags(text: string): string {
  return text.replace(/\[SUGGESTION\](.*?)\[\/SUGGESTION\]/gs, '**$1**');
}

// ── Simple markdown-ish rendering ──

function renderMarkdown(text: string): string {
  const stripped = stripSuggestionTags(text);
  return stripped
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>');
}

// ── Components ──

function ChatHeader({ phase }: { phase: string | null }) {
  const phaseLabel = phase === 'analysis' ? 'Analysis' : phase === 'direction' ? 'Direction' : 'Complete';
  const step = phase === 'analysis' ? 1 : phase === 'direction' ? 2 : 3;

  return (
    <div className="chat-header">
      <div className="chat-header-title">
        <span className="chat-header-icon">&#9679;</span>
        ART Onboarding
      </div>
      <div className="chat-header-phase">
        <div className="chat-phase-steps">
          <span className={`chat-phase-step ${step >= 1 ? 'chat-phase-step--active' : ''}`}>1. Analysis</span>
          <span className="chat-phase-arrow">&rarr;</span>
          <span className={`chat-phase-step ${step >= 2 ? 'chat-phase-step--active' : ''}`}>2. Direction</span>
          <span className="chat-phase-arrow">&rarr;</span>
          <span className={`chat-phase-step ${step >= 3 ? 'chat-phase-step--active' : ''}`}>3. Pipeline</span>
        </div>
        <span className="chat-phase-badge">{phaseLabel}</span>
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

function MessageBubble({ role, content, isStreaming }: {
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

function SuggestionChips({ suggestions, onSelect }: {
  suggestions: string[];
  onSelect: (text: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="chat-suggestions">
      {suggestions.map((s, i) => (
        <button
          key={i}
          className="chat-suggestion-chip"
          onClick={() => onSelect(s)}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

// ── Main Component ──

export function ChatOnboarding({ onComplete }: { onComplete: () => void }) {
  const {
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
  } = useSSEChat();

  const [input, setInput] = useState('');
  const [initialized, setInitialized] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Check auth on mount
  useEffect(() => {
    checkState();
  }, [checkState]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming, suggestions]);

  // Auto-init when auth is available
  useEffect(() => {
    if (hasAuth && !initialized) {
      setInitialized(true);
      initChat();
    }
  }, [hasAuth, initialized, initChat]);

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

  const handleSuggestionSelect = useCallback(
    (text: string) => {
      if (isStreaming) return;
      sendMessage(text);
    },
    [isStreaming, sendMessage],
  );

  const handleContinue = useCallback(async () => {
    const result = await advancePhase();
    if (result.phase === 'direction') {
      // Start direction phase — user should send a message or pick a suggestion
    } else if (result.phase === 'complete') {
      onComplete();
    }
  }, [advancePhase, onComplete]);

  // Fallback: no auth
  if (hasAuth === false) {
    return null; // Let App.tsx fall back to static Onboarding
  }

  // Loading state
  if (hasAuth === null) {
    return (
      <div className="chat-overlay">
        <div className="chat-loading">Checking configuration...</div>
      </div>
    );
  }

  const showContinue = !isStreaming && messages.length > 0;

  return (
    <div className="chat-overlay">
      <div className="chat-container">
        <ChatHeader phase={phase} />

        <div className="chat-messages">
          {messages.map((m, i) => (
            <MessageBubble
              key={i}
              role={m.role}
              content={m.content}
              isStreaming={isStreaming && i === messages.length - 1 && m.role === 'assistant'}
            />
          ))}
          {isStreaming && messages.length > 0 && messages[messages.length - 1].role === 'user' && (
            <div className="chat-message chat-message--assistant">
              <div className="chat-message-avatar">AI</div>
              <TypingIndicator />
            </div>
          )}
          {error && (
            <div className="chat-error">
              {error}
            </div>
          )}
          <SuggestionChips suggestions={suggestions} onSelect={handleSuggestionSelect} />
          <div ref={messagesEndRef} />
        </div>

        <div className="chat-bottom">
          {showContinue && (
            <button className="chat-continue-btn" onClick={handleContinue}>
              {phase === 'analysis' ? 'Save Analysis & Continue →' : 'Save Plan & Finish →'}
            </button>
          )}
          <div className="chat-input-row">
            <textarea
              ref={inputRef}
              className="chat-input"
              placeholder={isStreaming ? 'Waiting for response...' : 'Type a message...'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isStreaming}
              rows={1}
            />
            <button
              className="chat-send-btn"
              onClick={handleSend}
              disabled={isStreaming || !input.trim()}
            >
              &#9654;
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
