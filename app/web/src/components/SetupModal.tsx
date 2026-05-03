import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  api,
  type ClaudeSetupTokenScope,
  type ClaudeSetupTokenStatus,
  type PreflightResponse,
} from '../lib/api.ts';

interface Props {
  preflight: PreflightResponse | null;
  onClose: () => void;
  onSaved: (preflight: PreflightResponse) => void;
}

function StatusLine({
  label,
  ok,
  detail,
  action,
}: {
  label: string;
  ok: boolean;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="setup-status-line">
      <span className={`setup-status-dot ${ok ? 'ok' : 'bad'}`} />
      <span className="setup-status-label">{label}</span>
      <span className="setup-status-detail">{detail ?? (ok ? 'Ready' : 'Missing')}</span>
      <span className="setup-status-action">{action}</span>
    </div>
  );
}

function setupScopeLabel(scope: ClaudeSetupTokenScope): string {
  return scope === 'debugger' ? 'Left-panel Claude OAuth' : 'ART runtime Claude OAuth';
}

function setupSystemStatus(scope: ClaudeSetupTokenScope, text: string): ClaudeSetupTokenStatus {
  return {
    scope,
    running: true,
    startedAt: new Date().toISOString(),
    output: [
      {
        stream: 'system',
        text,
        ts: new Date().toISOString(),
      },
    ],
  };
}

export function SetupModal({ preflight, onClose, onSaved }: Props) {
  const [current, setCurrent] = useState<PreflightResponse | null>(preflight);
  const [setupTokenStatus, setSetupTokenStatus] = useState<ClaudeSetupTokenStatus | null>(null);
  const [setupTokenInput, setSetupTokenInput] = useState('');
  const [manualTokenInput, setManualTokenInput] = useState('');
  const [launchBusy, setLaunchBusy] = useState(false);
  const [inputBusy, setInputBusy] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [activeSetupScope, setActiveSetupScope] = useState<ClaudeSetupTokenScope>('runtime');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setupTerminalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.preflightForce().then(setCurrent).catch((e) => setError((e as Error).message));
    Promise.all([
      api.claudeSetupTokenStatus('runtime'),
      api.claudeSetupTokenStatus('debugger'),
    ]).then(([runtimeStatus, debuggerStatus]) => {
      const visibleStatus = debuggerStatus.running || debuggerStatus.output?.length
        ? debuggerStatus
        : runtimeStatus;
      setActiveSetupScope(visibleStatus.scope ?? 'runtime');
      setSetupTokenStatus(visibleStatus);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!setupTokenStatus?.running) return;
    const timer = window.setInterval(() => {
      void refreshSetupTokenStatus();
    }, 2000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupTokenStatus?.running]);

  useEffect(() => {
    const terminal = setupTerminalRef.current;
    if (!terminal) return;
    terminal.scrollTo({ top: terminal.scrollHeight });
  }, [setupTokenStatus?.output?.length, setupTokenStatus?.running]);

  async function refreshPreflight() {
    const refreshed = await api.preflightForce();
    setCurrent(refreshed);
    onSaved(refreshed);
    return refreshed;
  }

  async function refreshSetupTokenStatus() {
    try {
      const [status] = await Promise.all([
        api.claudeSetupTokenStatus(activeSetupScope),
        refreshPreflight(),
      ]);
      setSetupTokenStatus(status);
      if (!status.running && status.finishedAt) {
        setNotice(
          status.error
            ? `${setupScopeLabel(status.scope ?? activeSetupScope)} setup ended with an error: ${status.error}`
            : `${setupScopeLabel(status.scope ?? activeSetupScope)} setup finished. Setup status has been refreshed.`,
        );
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function launchClaudeSetupToken(scope: ClaudeSetupTokenScope) {
    setActiveSetupScope(scope);
    setSetupTokenStatus(setupSystemStatus(scope, `Launching ${setupScopeLabel(scope)} setup...\n`));
    setLaunchBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.launchClaudeSetupToken(scope);
      setSetupTokenStatus(result.status);
      await refreshPreflight();
      setNotice(
        result.status.running
          ? `${setupScopeLabel(scope)} setup started. Complete the app terminal or browser flow; this dialog will refresh while it runs.`
          : `${setupScopeLabel(scope)} setup was requested. Setup status has been refreshed.`,
      );
    } catch (e) {
      const message = (e as Error).message;
      setSetupTokenStatus({
        scope,
        running: false,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: message,
        output: [
          {
            stream: 'system',
            text: `Failed to launch ${setupScopeLabel(scope)} setup: ${message}\n`,
            ts: new Date().toISOString(),
          },
        ],
      });
      setError(message);
    } finally {
      setLaunchBusy(false);
    }
  }

  async function sendSetupTokenInput() {
    if (!setupTokenStatus?.running) return;
    setInputBusy(true);
    setError(null);
    try {
      const result = await api.sendClaudeSetupTokenInput(setupTokenInput);
      setSetupTokenStatus(result.status);
      setSetupTokenInput('');
      window.setTimeout(() => {
        void refreshSetupTokenStatus();
      }, 250);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInputBusy(false);
    }
  }

  async function saveManualToken() {
    const token = manualTokenInput.trim();
    if (!token) {
      setError('Token is required.');
      return;
    }

    setSaveBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.saveAuthToken(token);
      setCurrent(result.preflight);
      onSaved(result.preflight);
      setManualTokenInput('');
      setNotice('Saved Claude token for ART runtime and the left-panel debugger.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaveBusy(false);
    }
  }

  const auth = current?.auth;
  const setupTokenRunning = !!setupTokenStatus?.running;
  const setupTokenOutput = setupTokenStatus?.output ?? [];
  const showSetupTerminal = setupTokenRunning || setupTokenOutput.length > 0 || !!setupTokenStatus?.finishedAt;
  const setupTokenButtonDisabled = launchBusy || setupTokenRunning || current?.claude.present === false;
  const terminalScope = setupTokenStatus?.scope ?? activeSetupScope;
  const terminalTitle = `${setupScopeLabel(terminalScope)} setup terminal`;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal setup-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <strong>Initial Setup</strong>
          <button onClick={onClose}>Close</button>
        </div>
        <div className="modal-body">
          <div className="setup-status-list">
            <StatusLine
              label="ART CLI"
              ok={current?.art.present ?? false}
              detail={current?.art.version ?? current?.art.error}
            />
            <StatusLine
              label="Claude CLI"
              ok={current?.claude.present ?? false}
              detail={current?.claude.version ?? current?.claude.error}
            />
            <StatusLine
              label="Container runtime"
              ok={current?.containerRuntime.present ?? false}
              detail={current?.containerRuntime.which ?? current?.containerRuntime.error}
            />
            <StatusLine
              label="Debugger sandbox"
              ok={current?.debuggerSandbox.present ?? false}
              detail={current?.debuggerSandbox.executable ?? current?.debuggerSandbox.error}
            />
            <StatusLine
              label="Claude auth for ART runtime"
              ok={auth?.present ?? false}
              detail={auth?.source ?? auth?.error}
              action={(
                <button
                  className="primary"
                  disabled={setupTokenButtonDisabled}
                  onClick={() => void launchClaudeSetupToken('runtime')}
                >
                  {setupTokenRunning && terminalScope === 'runtime' ? 'Running...' : 'Setup'}
                </button>
              )}
            />
            <StatusLine
              label="Claude auth for left-panel chat"
              ok={auth?.chatReady ?? false}
              detail={auth?.chatSource ?? auth?.chatError}
              action={(
                <button
                  className="primary"
                  disabled={setupTokenButtonDisabled}
                  onClick={() => void launchClaudeSetupToken('debugger')}
                >
                  {setupTokenRunning && terminalScope === 'debugger' ? 'Running...' : 'Setup'}
                </button>
              )}
            />
          </div>

          <div className="setup-auth-box">
            <div className="setup-action-header">
              <strong>Manual Token</strong>
              <span>{auth?.source ?? auth?.chatSource ?? 'not saved'}</span>
            </div>
            <div className="setup-copy">
              Paste a token from <code>claude setup-token</code> or <code>CLAUDE_CODE_OAUTH_TOKEN</code>.
            </div>
            <div className="setup-token-row">
              <input
                type="password"
                value={manualTokenInput}
                onChange={(e) => setManualTokenInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveManualToken();
                }}
                placeholder="Claude token"
                autoComplete="off"
                disabled={saveBusy}
              />
              <button
                className="primary"
                disabled={saveBusy || !manualTokenInput.trim()}
                onClick={() => void saveManualToken()}
              >
                {saveBusy ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>

          {showSetupTerminal && (
            <div className="setup-terminal">
              <div className="setup-terminal-header">
                <strong>{terminalTitle}</strong>
                <span>{setupTokenRunning ? 'Running' : 'Stopped'}</span>
              </div>
              <div className="setup-terminal-output" ref={setupTerminalRef}>
                {setupTokenOutput.length === 0 && (
                  <span className="system">Starting Claude setup...</span>
                )}
                {setupTokenOutput.map((chunk, index) => (
                  <span key={`${chunk.ts}-${index}`} className={chunk.stream}>
                    {chunk.text}
                  </span>
                ))}
              </div>
              <div className="setup-terminal-input">
                <input
                  type="password"
                  value={setupTokenInput}
                  onChange={(e) => setSetupTokenInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void sendSetupTokenInput();
                  }}
                  placeholder="Terminal input"
                  autoComplete="off"
                  disabled={!setupTokenRunning || inputBusy}
                />
                <button disabled={!setupTokenRunning || inputBusy} onClick={() => void sendSetupTokenInput()}>
                  Enter
                </button>
              </div>
            </div>
          )}

          {notice && <div className="banner info setup-banner">{notice}</div>}
          {error && <div className="banner setup-banner">{error}</div>}
        </div>
      </div>
    </div>
  );
}
