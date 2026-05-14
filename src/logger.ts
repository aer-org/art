/**
 * Thin logging shim — replaces the prior pino-based logger.
 *
 * Two behaviors per call:
 * 1. If a RunRecorder is active (set via setActiveRecorder), the event is
 *    appended to runs/<id>/events.jsonl.
 * 2. warn / error / fatal also print one line to stderr so an operator
 *    notices things going wrong even before they tail a log.
 * info and debug are archive-only (no stderr noise).
 *
 * The pino-compatible call shape `logger.info(obj, message)` or
 * `logger.info(message)` is preserved so existing call sites need no edit.
 */
import { getActiveRecorder, type EventLevel } from './run-recorder.js';

type LogMethod = (
  objOrMessage: Record<string, unknown> | string,
  message?: string,
) => void;

interface Logger {
  debug: LogMethod;
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
  fatal: LogMethod;
}

function emit(
  level: EventLevel | 'fatal',
  objOrMessage: Record<string, unknown> | string,
  message?: string,
): void {
  let data: Record<string, unknown> | undefined;
  let msg: string | undefined;
  if (typeof objOrMessage === 'string') {
    msg = objOrMessage;
  } else {
    data = objOrMessage;
    msg = message;
  }

  const recorderLevel: EventLevel = level === 'fatal' ? 'error' : level;
  const recorder = getActiveRecorder();
  if (recorder) {
    recorder.event({
      level: recorderLevel,
      type: `log.${level}`,
      message: msg,
      data,
    });
  }

  if (level === 'warn' || level === 'error' || level === 'fatal') {
    const prefix = `[${level}]`;
    if (msg && data) {
      console.error(prefix, msg, data);
    } else if (msg) {
      console.error(prefix, msg);
    } else if (data) {
      console.error(prefix, data);
    }
  }
}

export const logger: Logger = {
  debug: (obj, message) => emit('debug', obj, message),
  info: (obj, message) => emit('info', obj, message),
  warn: (obj, message) => emit('warn', obj, message),
  error: (obj, message) => emit('error', obj, message),
  fatal: (obj, message) => emit('fatal', obj, message),
};

// Route uncaught errors to stderr (no recorder dependency — these happen
// before/around recorder lifecycle).
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err);
  const recorder = getActiveRecorder();
  recorder?.event({
    level: 'error',
    type: 'process.uncaughtException',
    message: err.message,
    data: { stack: err.stack },
  });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[error] Unhandled rejection:', reason);
  const recorder = getActiveRecorder();
  recorder?.event({
    level: 'error',
    type: 'process.unhandledRejection',
    message: reason instanceof Error ? reason.message : String(reason),
    data: reason instanceof Error ? { stack: reason.stack } : { value: reason },
  });
});
