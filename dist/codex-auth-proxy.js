import { createServer } from 'http';
import { CodexExternalAuthManager } from './codex-external-auth.js';
import { logger } from './logger.js';
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8').trim();
            if (!raw) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            }
            catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}
function writeJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}
export function startCodexAuthProxy(port, host = '127.0.0.1') {
    const authManager = new CodexExternalAuthManager();
    return new Promise((resolve, reject) => {
        const server = createServer(async (req, res) => {
            try {
                if (req.method !== 'POST') {
                    writeJson(res, 405, { error: 'Method not allowed' });
                    return;
                }
                if (req.url === '/login') {
                    const login = authManager.getExternalLogin();
                    writeJson(res, 200, login);
                    return;
                }
                if (req.url === '/refresh') {
                    await readJsonBody(req);
                    const login = await authManager.refreshExternalLogin();
                    writeJson(res, 200, login);
                    return;
                }
                writeJson(res, 404, { error: 'Not found' });
            }
            catch (error) {
                logger.error({ err: error, url: req.url }, 'Codex auth proxy error');
                writeJson(res, 500, {
                    error: error instanceof Error ? error.message : 'Internal server error',
                });
            }
        });
        server.listen(port, host, () => {
            const actualPort = server.address().port;
            logger.info({ port: actualPort, host }, 'Codex auth proxy started');
            resolve({ server, port: actualPort });
        });
        server.on('error', reject);
    });
}
//# sourceMappingURL=codex-auth-proxy.js.map