import fs from 'fs';
import pino from 'pino';

function buildLogger(): pino.Logger {
  const level = process.env.LOG_LEVEL || 'info';

  // TUI mode: send logs to file instead of terminal
  if (process.env.ART_TUI_MODE) {
    const logDir = process.env.ART_TUI_LOG_DIR;
    if (logDir) {
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = `${logDir}/engine.log`;
      return pino({ level }, pino.destination({ dest: logFile, sync: false }));
    }
  }

  return pino({
    level,
    transport: { target: 'pino-pretty', options: { colorize: true } },
  });
}

export const logger = buildLogger();

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
