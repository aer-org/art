import readline from 'readline';

import { registerChannel } from './registry.js';
import type { Channel, NewMessage } from '../types.js';
import type { ChannelOpts } from './registry.js';

const TUI_JID_PREFIX = 'art://';

function createTuiChannel(opts: ChannelOpts): Channel | null {
  if (!process.env.ART_TUI_MODE) return null;

  const jid = process.env.ART_TUI_JID || 'art://local';
  let rl: readline.Interface | null = null;
  let connected = false;

  return {
    name: 'tui',

    async connect(): Promise<void> {
      rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '\n> ',
      });

      // Register chat metadata
      opts.onChatMetadata(
        jid,
        new Date().toISOString(),
        'art-tui',
        'tui',
        false,
      );

      rl.on('line', (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) {
          rl?.prompt();
          return;
        }

        const msg: NewMessage = {
          id: `tui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: jid,
          sender: 'user',
          sender_name: 'User',
          content: trimmed,
          timestamp: new Date().toISOString(),
          is_from_me: true,
        };
        opts.onMessage(jid, msg);
      });

      rl.on('close', () => {
        connected = false;
      });

      connected = true;

      // Auto-start pipeline
      const autoMsg: NewMessage = {
        id: `tui-${Date.now()}-auto`,
        chat_jid: jid,
        sender: 'user',
        sender_name: 'User',
        content: '구현 시작',
        timestamp: new Date().toISOString(),
        is_from_me: true,
      };
      opts.onMessage(jid, autoMsg);
    },

    async sendMessage(_jid: string, text: string): Promise<void> {
      // Clear the prompt line, print response, re-prompt
      if (rl) {
        process.stdout.write('\r\x1b[K'); // clear current line
      }
      console.log(`\n${text}`);
      rl?.prompt();
    },

    isConnected(): boolean {
      return connected;
    },

    ownsJid(testJid: string): boolean {
      return testJid.startsWith(TUI_JID_PREFIX);
    },

    async disconnect(): Promise<void> {
      rl?.close();
      connected = false;
    },

    async setTyping(_jid: string, isTyping: boolean): Promise<void> {
      if (isTyping) {
        process.stdout.write('\r\x1b[K⏳ thinking...');
      } else {
        process.stdout.write('\r\x1b[K');
      }
    },
  };
}

registerChannel('tui', createTuiChannel);
