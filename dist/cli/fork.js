import { resolveRemoteWithAuth } from '../remote-config.js';
import { RegistryApi } from '../registry-api.js';
function parseArgs(args) {
    let agent = '';
    let remote;
    let project;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--remote' && args[i + 1]) {
            remote = args[++i];
        }
        else if (args[i] === '--project' && args[i + 1]) {
            project = args[++i];
        }
        else if (!args[i].startsWith('--')) {
            agent = args[i];
        }
    }
    if (!agent) {
        console.error('Usage: art fork <agent> [--project <project>] [--remote <name>]');
        process.exit(1);
    }
    return { agent, remote, project };
}
export async function fork(args) {
    const { agent, remote: remoteName, project } = parseArgs(args);
    const { url, token } = resolveRemoteWithAuth(remoteName);
    const api = new RegistryApi(url, token);
    const result = await api.forkAgent(agent, project);
    console.log(`Forked "${agent}" → user scope (hash: ${result.content_hash.slice(0, 19)}…)`);
}
export async function promote(args) {
    const { agent, remote: remoteName, project } = parseArgs(args);
    const { url, token } = resolveRemoteWithAuth(remoteName);
    const api = new RegistryApi(url, token);
    const result = await api.promoteAgent(agent, project);
    console.log(`Promoted "${agent}" → shared scope (hash: ${result.content_hash.slice(0, 19)}…)`);
}
//# sourceMappingURL=fork.js.map