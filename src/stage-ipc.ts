import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';

export interface StageIpcHostMessage {
  type: 'message';
  text: string;
  timestamp: string;
}

export interface StageIpcOutboundMessage {
  type: string;
  text?: string;
  chatJid?: string;
  sender?: string;
  groupFolder?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export class StageIpcEndpoint {
  readonly rootDir: string;
  readonly inputDir: string;
  readonly messagesDir: string;
  readonly tasksDir: string;

  constructor(readonly folder: string) {
    this.rootDir = resolveGroupIpcPath(folder);
    this.inputDir = path.join(this.rootDir, 'input');
    this.messagesDir = path.join(this.rootDir, 'messages');
    this.tasksDir = path.join(this.rootDir, 'tasks');
    fs.mkdirSync(this.inputDir, { recursive: true });
    fs.mkdirSync(this.messagesDir, { recursive: true });
    fs.mkdirSync(this.tasksDir, { recursive: true });
  }

  clearCloseSentinel(): void {
    try {
      fs.unlinkSync(path.join(this.inputDir, '_close'));
    } catch {
      // It is fine when there is no stale close sentinel.
    }
  }

  sendToContainer(text: string): void {
    const message: StageIpcHostMessage = {
      type: 'message',
      text,
      timestamp: new Date().toISOString(),
    };
    this.writeJson(this.inputDir, message);
    logger.debug(
      { folder: this.folder, textLen: text.length },
      'Sent IPC message to stage container',
    );
  }

  closeContainerInput(): void {
    try {
      fs.writeFileSync(path.join(this.inputDir, '_close'), '');
    } catch {
      // Container may already be gone.
    }
  }

  drainFromContainer(): StageIpcOutboundMessage[] {
    let files: string[];
    try {
      files = fs
        .readdirSync(this.messagesDir)
        .filter((file) => file.endsWith('.json'))
        .sort();
    } catch {
      return [];
    }

    const messages: StageIpcOutboundMessage[] = [];
    for (const file of files) {
      const filepath = path.join(this.messagesDir, file);
      try {
        const raw = fs.readFileSync(filepath, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (isOutboundMessage(parsed)) {
          messages.push(parsed);
        } else {
          logger.warn(
            { filepath },
            'Ignoring malformed stage IPC outbound message',
          );
        }
      } catch (err) {
        logger.warn(
          { filepath, err },
          'Failed to read stage IPC outbound message',
        );
      } finally {
        try {
          fs.unlinkSync(filepath);
        } catch {
          // Another reader may already have consumed it.
        }
      }
    }
    return messages;
  }

  writeFromContainer(message: StageIpcOutboundMessage): void {
    this.writeJson(this.messagesDir, {
      ...message,
      timestamp: message.timestamp ?? new Date().toISOString(),
    });
  }

  private writeJson(dir: string, message: unknown): void {
    const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
    const filepath = path.join(dir, filename);
    const tmpPath = `${filepath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(message));
    fs.renameSync(tmpPath, filepath);
  }
}

export function createStageIpcEndpoint(folder: string): StageIpcEndpoint {
  return new StageIpcEndpoint(folder);
}

function isOutboundMessage(value: unknown): value is StageIpcOutboundMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof (value as { type: unknown }).type === 'string'
  );
}
