import readline from 'readline';

import { RegistryApi } from '../registry-api.js';
import { RegistryError, saveCredentials } from '../registry-client.js';
import {
  resolveRemote,
  saveRemoteCredentials,
  loadRemotes,
  getDefaultRemote,
} from '../remote-config.js';

const DEFAULT_SERVER = 'https://aerclaw.com';

function promptText(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptPassword(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return promptText(question);
  }
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (ch: Buffer) => {
      const code = ch[0];
      if (code === 13 || code === 10) {
        // Enter
        stdin.setRawMode(wasRaw);
        stdin.removeListener('data', onData);
        stdin.pause();
        process.stdout.write('\n');
        resolve(buf);
      } else if (code === 3) {
        // Ctrl-C
        stdin.setRawMode(wasRaw);
        stdin.pause();
        process.exit(130);
      } else if (code === 127 || code === 8) {
        // Backspace
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (code >= 32) {
        // Printable
        buf += ch.toString('utf8');
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

export async function login(args: string[]): Promise<void> {
  const remoteIdx = args.indexOf('--remote');
  const remoteFlag = remoteIdx !== -1 ? args[remoteIdx + 1] : undefined;
  const tokenMode = args.includes('--token');

  const remotes = loadRemotes();
  const hasRemotes = Object.keys(remotes.remotes).length > 0;

  let serverUrl: string;
  let remoteName: string | undefined;

  if (hasRemotes) {
    const resolved = resolveRemote(remoteFlag);
    remoteName = resolved.name;
    serverUrl = resolved.remote.url;
  } else {
    const def = getDefaultRemote();
    serverUrl = def?.remote.url ?? DEFAULT_SERVER;
  }

  if (tokenMode) {
    const token = process.env.ART_TOKEN ?? (await promptText('Token: '));
    if (!token) {
      console.error('No token provided.');
      process.exit(1);
    }
    await saveTokenCredentials(serverUrl, token, remoteName);
    return;
  }

  const username = await promptText('Username: ');
  if (!username) {
    console.error('No username provided.');
    process.exit(1);
  }

  const password = await promptPassword('Password: ');
  if (!password) {
    console.error('No password provided.');
    process.exit(1);
  }

  try {
    const result = await RegistryApi.login(serverUrl, username, password);
    const expiresDate = new Date(result.expires_at).toLocaleDateString();

    saveCredentials({
      server: serverUrl,
      token: result.token,
      scope: 'write',
      saved_at: new Date().toISOString(),
    });

    if (remoteName) {
      saveRemoteCredentials(remoteName, {
        token: result.token,
        scope: 'write',
        username,
        saved_at: new Date().toISOString(),
      });
      console.log(
        `✓ Logged in as ${username} to ${remoteName} (${serverUrl}) — expires ${expiresDate}`,
      );
    } else {
      console.log(
        `✓ Logged in as ${username} (${serverUrl}) — expires ${expiresDate}`,
      );
    }
  } catch (e) {
    if (e instanceof RegistryError) {
      console.error(`Login failed: ${e.message}`);
    } else {
      console.error(`Login failed: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

export async function signup(args: string[]): Promise<void> {
  const remoteIdx = args.indexOf('--remote');
  const remoteFlag = remoteIdx !== -1 ? args[remoteIdx + 1] : undefined;

  const remotes = loadRemotes();
  const hasRemotes = Object.keys(remotes.remotes).length > 0;

  let serverUrl: string;

  if (hasRemotes) {
    const resolved = resolveRemote(remoteFlag);
    serverUrl = resolved.remote.url;
  } else {
    const def = getDefaultRemote();
    serverUrl = def?.remote.url ?? DEFAULT_SERVER;
  }

  const username = await promptText('Username: ');
  if (!username) {
    console.error('No username provided.');
    process.exit(1);
  }

  const password = await promptPassword('Password (min 8 chars): ');
  if (!password) {
    console.error('No password provided.');
    process.exit(1);
  }

  const confirm = await promptPassword('Confirm password: ');
  if (password !== confirm) {
    console.error('Passwords do not match.');
    process.exit(1);
  }

  try {
    const result = await RegistryApi.signup(serverUrl, username, password);
    console.log(`✓ Account created: ${result.username}`);
    console.log(`  Run 'art login' to sign in.`);
  } catch (e) {
    if (e instanceof RegistryError) {
      console.error(`Signup failed: ${e.message}`);
    } else {
      console.error(`Signup failed: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}

async function saveTokenCredentials(
  serverUrl: string,
  token: string,
  remoteName?: string,
): Promise<void> {
  const api = new RegistryApi(serverUrl, token);
  try {
    const info = await api.whoami();
    saveCredentials({
      server: serverUrl,
      token,
      scope: info.scope,
      saved_at: new Date().toISOString(),
    });

    if (remoteName) {
      saveRemoteCredentials(remoteName, {
        token,
        scope: info.scope,
        username: (info as unknown as { username?: string }).username,
        saved_at: new Date().toISOString(),
      });
    }

    console.log(
      `✓ Logged in with token — scope=${info.scope}, label=${info.label ?? 'none'}`,
    );
  } catch (e) {
    if (e instanceof RegistryError) {
      console.error(`Login failed: ${e.message}`);
    } else {
      console.error(`Login failed: ${(e as Error).message}`);
    }
    process.exit(1);
  }
}
