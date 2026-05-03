import type { FastifyInstance } from 'fastify';

import { projectState } from '../project-state.ts';
import {
  chatController,
  CHAT_PROTOCOL_VERSION,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  EFFORT_OPTIONS,
  MODEL_OPTIONS,
  type ChatEvent,
  type ChatPermissionDecision,
  type Effort,
} from '../chat-controller.ts';

interface SendBody {
  chatId?: string;
  message: string;
}

interface CancelBody {
  chatId: string;
}

interface PermissionBody {
  chatId: string;
  permissionId: string;
  decision: ChatPermissionDecision;
}

interface EventsQuery {
  chatId: string;
}

interface SessionBody {
  model?: string;
  effort?: Effort;
}

interface SettingsBody {
  chatId: string;
  model?: string;
  effort?: Effort;
}

function isSessionCurrent(chatId: string): { ok: true } | { ok: false; status: number; error: string } {
  const session = chatController.get(chatId);
  if (!session) return { ok: false, status: 404, error: 'unknown chatId' };
  const project = projectState.current;
  if (!project) return { ok: false, status: 409, error: 'No project loaded.' };
  if (project.projectDir !== session.projectDir) {
    return {
      ok: false,
      status: 409,
      error: 'This debugger session belongs to a different loaded project. Start a new chat session.',
    };
  }
  return { ok: true };
}

export function registerChatRoutes(app: FastifyInstance): void {
  app.get('/api/chat/options', async () => ({
    chatProtocolVersion: CHAT_PROTOCOL_VERSION,
    models: MODEL_OPTIONS,
    efforts: EFFORT_OPTIONS,
    defaults: { model: DEFAULT_MODEL, effort: DEFAULT_EFFORT },
  }));

  app.post<{ Body: SessionBody }>('/api/chat/session', async (req, reply) => {
    const project = projectState.current;
    if (!project) return reply.code(400).send({ error: 'No project loaded.' });
    const session = chatController.create(project.projectDir, {
      model: req.body?.model,
      effort: req.body?.effort,
    });
    return {
      chatId: session.id,
      model: session.model,
      effort: session.effort,
      chatProtocolVersion: CHAT_PROTOCOL_VERSION,
    };
  });

  app.post<{ Body: SettingsBody }>('/api/chat/settings', async (req, reply) => {
    if (!req.body?.chatId) return reply.code(400).send({ error: 'chatId required' });
    const current = isSessionCurrent(req.body.chatId);
    if (!current.ok) return reply.code(current.status).send({ error: current.error });
    const session = chatController.setSettings(req.body.chatId, {
      model: req.body.model,
      effort: req.body.effort,
    });
    if (!session) return reply.code(404).send({ error: 'unknown chatId' });
    return { ok: true, model: session.model, effort: session.effort, chatProtocolVersion: CHAT_PROTOCOL_VERSION };
  });

  app.post<{ Body: SendBody }>('/api/chat', async (req, reply) => {
    const { chatId, message } = req.body ?? ({} as SendBody);
    if (!chatId) return reply.code(400).send({ error: 'chatId required' });
    if (!message || typeof message !== 'string') return reply.code(400).send({ error: 'message required' });
    const current = isSessionCurrent(chatId);
    if (!current.ok) return reply.code(current.status).send({ error: current.error });
    try {
      const result = chatController.acceptTurn(chatId, message);
      reply.raw.once('finish', () => {
        setImmediate(() => {
          chatController.startAcceptedTurn(chatId, result.turnId, message);
        });
      });
      return { ok: true, turnId: result.turnId, chatProtocolVersion: CHAT_PROTOCOL_VERSION };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post<{ Body: CancelBody }>('/api/chat/cancel', async (req, reply) => {
    if (!req.body?.chatId) return reply.code(400).send({ error: 'chatId required' });
    chatController.cancel(req.body.chatId);
    return { ok: true };
  });

  app.post<{ Body: PermissionBody }>('/api/chat/permission', async (req, reply) => {
    const { chatId, permissionId, decision } = req.body ?? ({} as PermissionBody);
    if (!chatId) return reply.code(400).send({ error: 'chatId required' });
    if (!permissionId) return reply.code(400).send({ error: 'permissionId required' });
    if (!['allow_once', 'allow_project', 'deny'].includes(decision)) {
      return reply.code(400).send({ error: 'invalid permission decision' });
    }
    const current = isSessionCurrent(chatId);
    if (!current.ok) return reply.code(current.status).send({ error: current.error });
    const result = chatController.resolvePermission(chatId, permissionId, decision);
    if (!result.ok) return reply.code(404).send({ error: result.error });
    return { ok: true };
  });

  app.get<{ Querystring: EventsQuery }>('/api/chat/events', (req, reply) => {
    const chatId = req.query.chatId;
    if (!chatId) return reply.code(400).send({ error: 'chatId required' });
    const current = isSessionCurrent(chatId);
    if (!current.ok) return reply.code(current.status).send({ error: current.error });
    const session = chatController.get(chatId);
    if (!session) return reply.code(404).send({ error: 'unknown chatId' });

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const send = (event: string, data: unknown) => {
      if (reply.raw.destroyed) return;
      reply.raw.write(`event: ${event}\n`);
      const seq = (data as { seq?: unknown })?.seq;
      if (typeof seq === 'number') reply.raw.write(`id: ${seq}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Replay history so reconnects don't lose context
    for (const event of session.history) send('event', event);

    const onEvent = (payload: { chatId: string; event: ChatEvent }) => {
      if (payload.chatId !== chatId) return;
      send('event', payload.event);
    };
    chatController.on('event', onEvent);

    const heartbeat = setInterval(() => {
      if (reply.raw.destroyed) return;
      reply.raw.write(': heartbeat\n\n');
    }, 15000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      chatController.off('event', onEvent);
    });
  });
}
