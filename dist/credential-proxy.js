import { createServer } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { OAuthRefresher } from './oauth-refresh.js';
export function startCredentialProxy(port, host = '127.0.0.1') {
    const secrets = readEnvFile([
        'ANTHROPIC_API_KEY',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
    ]);
    const authMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
    const staticOauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN ||
        secrets.ANTHROPIC_AUTH_TOKEN ||
        process.env._ART_OAUTH_TOKEN;
    // Enable auto-refresh only when the user did NOT pin a token explicitly
    // via env vars. If they did, respect that choice — we can't refresh an
    // opaque env-var token anyway (no refresh_token alongside it).
    const hasExplicitEnvToken = !!(secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN);
    const refresher = authMode === 'oauth' &&
        !hasExplicitEnvToken &&
        OAuthRefresher.isAvailable()
        ? new OAuthRefresher()
        : null;
    if (authMode === 'oauth') {
        logger.info({ refreshEnabled: !!refresher }, refresher
            ? 'OAuth mode with auto-refresh enabled'
            : 'OAuth mode without refresh; token will expire when its TTL runs out');
    }
    async function resolveOauthToken() {
        if (refresher) {
            try {
                return await refresher.getAccessToken();
            }
            catch (err) {
                logger.error({ err }, 'OAuth refresh failed; falling back to cached token');
                // Best-effort: return whatever we have. Upstream may 401 and that
                // will surface to the container as a normal auth failure.
                return staticOauthToken;
            }
        }
        return staticOauthToken;
    }
    const upstreamUrl = new URL(secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
    const isHttps = upstreamUrl.protocol === 'https:';
    const makeRequest = isHttps ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', async () => {
                const body = Buffer.concat(chunks);
                // Resolve OAuth token up front so we can inject on first try (and
                // force-refresh on 401 retry). For api-key mode this is a no-op.
                let oauthToken;
                if (authMode === 'oauth') {
                    oauthToken = await resolveOauthToken();
                }
                const buildHeaders = (tokenOverride) => {
                    const headers = {
                        ...req.headers,
                        host: upstreamUrl.host,
                        'content-length': body.length,
                    };
                    // Strip hop-by-hop headers that must not be forwarded by proxies
                    delete headers['connection'];
                    delete headers['keep-alive'];
                    delete headers['transfer-encoding'];
                    if (authMode === 'api-key') {
                        // API key mode: inject x-api-key on every request
                        delete headers['x-api-key'];
                        headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
                    }
                    else {
                        // OAuth mode: replace placeholder Bearer token with the real one
                        // only when the container actually sends an Authorization header
                        // (exchange request + auth probes). Post-exchange requests use
                        // x-api-key only, so they pass through without token injection.
                        if (headers['authorization']) {
                            delete headers['authorization'];
                            const tok = tokenOverride ?? oauthToken;
                            if (tok) {
                                headers['authorization'] = `Bearer ${tok}`;
                            }
                        }
                    }
                    return headers;
                };
                // Forward once; if upstream returns 401 in OAuth mode and we have a
                // refresher, force-refresh and retry exactly one more time. We must
                // buffer the upstream response for the first attempt so we can
                // discard it on 401 before streaming anything to the client.
                const forward = (headers, onResponse, onError) => {
                    const upstream = makeRequest({
                        hostname: upstreamUrl.hostname,
                        port: upstreamUrl.port || (isHttps ? 443 : 80),
                        path: req.url,
                        method: req.method,
                        headers,
                    }, onResponse);
                    upstream.on('error', onError);
                    upstream.write(body);
                    upstream.end();
                };
                const onUpstreamError = (err) => {
                    logger.error({ err, url: req.url }, 'Credential proxy upstream error');
                    if (!res.headersSent) {
                        res.writeHead(502);
                        res.end('Bad Gateway');
                    }
                };
                const pipeToClient = (upRes) => {
                    res.writeHead(upRes.statusCode, upRes.headers);
                    upRes.pipe(res);
                };
                forward(buildHeaders(), async (upRes) => {
                    // 401 in OAuth mode with refresh available → force-refresh + retry
                    if (upRes.statusCode === 401 &&
                        authMode === 'oauth' &&
                        refresher &&
                        !!req.headers['authorization']) {
                        // Drain and discard the 401 body; we're going to retry.
                        upRes.resume();
                        let fresh;
                        try {
                            fresh = await refresher.getAccessToken(true);
                        }
                        catch (err) {
                            logger.error({ err }, 'OAuth force-refresh after 401 failed');
                        }
                        if (!fresh || fresh === oauthToken) {
                            // Nothing changed — give up and proxy the original 401 response.
                            // Re-issue a throwaway upstream just to surface 401 cleanly.
                            forward(buildHeaders(), pipeToClient, onUpstreamError);
                            return;
                        }
                        logger.info({ url: req.url }, 'Retrying request with refreshed OAuth token');
                        forward(buildHeaders(fresh), pipeToClient, onUpstreamError);
                        return;
                    }
                    pipeToClient(upRes);
                }, onUpstreamError);
            });
        });
        server.listen(port, host, () => {
            const actualPort = server.address().port;
            logger.info({ port: actualPort, host, authMode }, 'Credential proxy started');
            resolve({ server, port: actualPort });
        });
        server.on('error', reject);
    });
}
/** Detect which auth mode the host is configured for. */
export function detectAuthMode() {
    const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
    return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
//# sourceMappingURL=credential-proxy.js.map