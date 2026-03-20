import { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatSegment, ToolActivity, UseAgentChatReturn } from '../hooks/useAgentChat.ts';
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
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>');
}

// ── Tool icon mapping ──

const TOOL_ICONS: Record<string, string> = {
  Bash: '\u25b6',     // ▶
  Read: '\ud83d\udcc4', // 📄
  Write: '\u270f\ufe0f', // ✏️
  Edit: '\u270f\ufe0f',  // ✏️
  Grep: '\ud83d\udd0d', // 🔍
  Glob: '\ud83d\udcc2', // 📂
};

// ── Components ──

function ChatHeader({ isStreaming, hasContent, onComplete }: {
  isStreaming: boolean;
  hasContent: boolean;
  onComplete: () => void;
}) {
  return (
    <div className="chat-header">
      <div className="chat-header-title">
        <span className="chat-header-icon">&#9679;</span>
        ART Agent
      </div>
      <div className="chat-header-phase">
        <span className="chat-phase-badge">
          {isStreaming ? 'Analyzing...' : 'Ready'}
        </span>
        <button className="chat-complete-header-btn" onClick={onComplete}>
          Complete &rarr;
        </button>
      </div>
    </div>
  );
}

const THINKING_STEPS = [
  'Waking agent up...',
  'Reading project structure...',
  'Analyzing dependencies...',
  'Reviewing architecture...',
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

function ToolCard({ tool }: { tool: ToolActivity }) {
  const icon = TOOL_ICONS[tool.name] || '\u2699\ufe0f'; // ⚙️ default
  return (
    <div className={`chat-tool-card ${tool.status === 'running' ? 'chat-tool-card--running' : ''}`}>
      <span className="chat-tool-icon">{icon}</span>
      <span className="chat-tool-name">{tool.name}</span>
      <span className="chat-tool-preview">{tool.input_preview}</span>
      {tool.status === 'running' && <span className="chat-tool-spinner" />}
    </div>
  );
}

function ToolGroup({ tools }: { tools: ToolActivity[] }) {
  return (
    <div className="chat-tool-group">
      {tools.map((t) =>
        t.status === 'running' ? (
          <ToolCard key={t.id} tool={t} />
        ) : (
          <div key={t.id} className="chat-tool-done">
            <span className="chat-tool-icon">{TOOL_ICONS[t.name] || '\u2699\ufe0f'}</span>
            <span className="chat-tool-name">{t.name}</span>
            <span className="chat-tool-preview">{t.input_preview}</span>
          </div>
        ),
      )}
    </div>
  );
}

type RenderItem =
  | { kind: 'user'; content: string }
  | { kind: 'text'; content: string; isLast: boolean }
  | { kind: 'tools'; tools: ToolActivity[] };

function groupSegments(segments: ChatSegment[], isStreaming: boolean): RenderItem[] {
  const items: RenderItem[] = [];
  let toolBuf: ToolActivity[] = [];

  const flushTools = () => {
    if (toolBuf.length > 0) {
      items.push({ kind: 'tools', tools: toolBuf });
      toolBuf = [];
    }
  };

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'tool') {
      toolBuf.push(seg.tool);
    } else {
      flushTools();
      if (seg.type === 'user') {
        items.push({ kind: 'user', content: seg.content });
      } else if (seg.type === 'text') {
        if (!seg.content.trim()) continue; // skip empty text segments
        const isLast = i === segments.length - 1;
        items.push({ kind: 'text', content: seg.content, isLast: isLast && isStreaming });
      }
    }
  }
  flushTools();
  return items;
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="chat-message chat-message--user">
      <div className="chat-message-avatar">You</div>
      <div className="chat-message-bubble">
        <div
          className="chat-message-text"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
        />
      </div>
    </div>
  );
}

function TextBubble({ content, isStreaming }: { content: string; isStreaming?: boolean }) {
  return (
    <div className="chat-message chat-message--assistant">
      <div className="chat-message-avatar">AI</div>
      <div className="chat-message-bubble">
        {content && (
          <div
            className="chat-message-text"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
          />
        )}
        {isStreaming && <span className="chat-cursor" />}
      </div>
    </div>
  );
}

// ── Main Component ──

interface AgentChatProps {
  onComplete: () => void;
  chat: UseAgentChatReturn;
}

export function AgentChat({ onComplete, chat }: AgentChatProps) {
  const { segments, isStreaming, error, agentRunning, sendMessage, closeAgent } = chat;

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [segments, isStreaming]);

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

  const hasRealContent = segments.some((s) => s.type === 'text' || s.type === 'tool');

  return (
    <div className="chat-overlay">
      <div className="chat-init-layout">
        <ChatHeader
          isStreaming={isStreaming}
          hasContent={segments.length > 0}
          onComplete={handleComplete}
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
              {isStreaming && !hasRealContent && (
                <ThinkingState />
              )}
              {groupSegments(segments, isStreaming).map((item, i) => {
                if (item.kind === 'user') {
                  return <UserBubble key={i} content={item.content} />;
                }
                if (item.kind === 'text') {
                  return (
                    <TextBubble
                      key={i}
                      content={item.content}
                      isStreaming={item.isLast}
                    />
                  );
                }
                if (item.kind === 'tools') {
                  return <ToolGroup key={i} tools={item.tools} />;
                }
                return null;
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
