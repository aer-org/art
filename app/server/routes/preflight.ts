import type { FastifyInstance } from 'fastify';
import {
  authStatus,
  type ClaudeSetupTokenScope,
  claudeSetupTokenStatus,
  launchClaudeSetupToken,
  preflight,
  saveAuthToken,
  writeClaudeSetupTokenInput,
} from '../preflight.ts';
import { projectState } from '../project-state.ts';

interface SaveTokenBody {
  token?: string;
}

interface SetupTokenInputBody {
  input?: string;
}

interface SetupTokenLaunchBody {
  scope?: ClaudeSetupTokenScope;
}

function setupScope(value: unknown): ClaudeSetupTokenScope {
  return value === 'debugger' ? 'debugger' : 'runtime';
}

export function registerPreflightRoutes(app: FastifyInstance): void {
  app.get('/api/preflight', async (req) => {
    const force = (req.query as { force?: string })?.force === '1';
    return preflight(force, projectState.current?.projectDir);
  });

  app.get('/api/setup/auth', async () => {
    return authStatus(projectState.current?.projectDir);
  });

  app.get('/api/setup/claude-token', async (req) => {
    const scope = setupScope((req.query as { scope?: string })?.scope);
    return claudeSetupTokenStatus(scope);
  });

  app.post<{ Body: SetupTokenLaunchBody }>('/api/setup/claude-token', async (req, reply) => {
    const scope = setupScope(req.body?.scope);
    const status = launchClaudeSetupToken(scope, projectState.current?.projectDir);
    if (status.running && status.scope && status.scope !== scope) {
      return reply.code(409).send({
        error: `${status.scope === 'debugger' ? 'Left-panel' : 'ART runtime'} Claude OAuth setup is already running.`,
        status,
      });
    }
    if (status.error && !status.running && !status.pid) {
      return reply.code(500).send({ error: status.error, status });
    }
    return { ok: true, status };
  });

  app.post<{ Body: SetupTokenInputBody }>('/api/setup/claude-token/input', async (req, reply) => {
    const input = req.body?.input;
    if (typeof input !== 'string') return reply.code(400).send({ error: 'input required' });
    try {
      return { ok: true, status: writeClaudeSetupTokenInput(input) };
    } catch (e) {
      return reply.code(409).send({ error: (e as Error).message, status: claudeSetupTokenStatus() });
    }
  });

  app.post<{ Body: SaveTokenBody }>('/api/setup/auth-token', async (req, reply) => {
    const token = req.body?.token;
    if (typeof token !== 'string') return reply.code(400).send({ error: 'token required' });
    const status = saveAuthToken(token);
    if (!status.present) return reply.code(400).send({ error: status.error ?? 'invalid token' });
    return {
      ok: true,
      auth: status,
      preflight: await preflight(true, projectState.current?.projectDir),
    };
  });
}
