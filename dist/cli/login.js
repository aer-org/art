import readline from 'readline';
import { RegistryClient, RegistryError, credentialsPath, loadCredentials, saveCredentials, } from '../registry-client.js';
const DEFAULT_SERVER = 'http://localhost:8787';
async function readTokenFromStdinOrPrompt() {
    if (!process.stdin.isTTY) {
        const chunks = [];
        for await (const chunk of process.stdin)
            chunks.push(chunk);
        return Buffer.concat(chunks).toString('utf8').trim();
    }
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const answer = await new Promise((resolve) => rl.question('Token: ', resolve));
    rl.close();
    return answer.trim();
}
async function promptLine(prompt, fallback) {
    if (!process.stdin.isTTY)
        return fallback;
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    const answer = await new Promise((resolve) => rl.question(`${prompt} [${fallback}]: `, resolve));
    rl.close();
    return answer.trim() || fallback;
}
export async function login(args) {
    const serverIdx = args.indexOf('--server');
    const serverFlag = serverIdx !== -1 ? args[serverIdx + 1] : undefined;
    const envToken = process.env.ART_TOKEN;
    const existing = loadCredentials();
    const server = serverFlag ??
        (await promptLine('Server URL', existing?.server ?? DEFAULT_SERVER));
    const token = envToken ?? (await readTokenFromStdinOrPrompt());
    if (!token) {
        console.error('No token provided.');
        process.exit(1);
    }
    const creds = {
        server,
        token,
        scope: 'read',
        saved_at: new Date().toISOString(),
    };
    const client = new RegistryClient(creds);
    try {
        const info = await client.whoami();
        creds.scope = info.scope;
        saveCredentials(creds);
        console.log(`Logged in to ${server} (scope=${info.scope}, label=${info.label ?? 'none'})`);
        console.log(`Credentials saved to ${credentialsPath()}`);
    }
    catch (e) {
        if (e instanceof RegistryError) {
            console.error(`Login failed: ${e.message}`);
        }
        else {
            console.error(`Login failed: ${e.message}`);
        }
        process.exit(1);
    }
}
//# sourceMappingURL=login.js.map