import path from 'path';
import { resolveRemoteWithAuth } from '../remote-config.js';
import { RegistryApi } from '../registry-api.js';
import { loadBundleMeta, readBundleFiles, classifyFile, } from '../bundle.js';
function parseArgs(args) {
    let dir = '.';
    let remote;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--remote' && args[i + 1]) {
            remote = args[++i];
        }
        else if (!args[i].startsWith('--')) {
            dir = args[i];
        }
    }
    return { dir, remote };
}
export async function push(args) {
    const { dir: rawDir, remote: remoteName } = parseArgs(args);
    const dir = path.resolve(rawDir);
    const meta = loadBundleMeta(dir);
    if (!meta) {
        console.error(`No .art-bundle.json found in ${dir}. Pull a pipeline first with "art pull".`);
        process.exit(1);
    }
    const effectiveRemote = remoteName ?? meta.remote;
    const { name: rName, url, token } = resolveRemoteWithAuth(effectiveRemote);
    const api = new RegistryApi(url, token);
    const files = readBundleFiles(dir);
    const counts = { agents: 0, pipelines: 0, dockerfiles: 0, templates: 0, unchanged: 0 };
    for (const file of files) {
        const originalHash = meta.hashes[file.relPath];
        const { kind, name } = classifyFile(file.relPath);
        if (originalHash && originalHash === file.hash) {
            console.log(`  ${file.relPath}  unchanged → skip`);
            counts.unchanged++;
            continue;
        }
        const label = originalHash ? 'changed' : 'new';
        switch (kind) {
            case 'agent':
                await api.pushAgent({
                    name,
                    system_prompt: file.content,
                    project: meta.project,
                });
                console.log(`  ${file.relPath}  ${label} → pushed`);
                counts.agents++;
                break;
            case 'pipeline': {
                const config = JSON.parse(file.content);
                await api.pushPipeline({
                    name: meta.pipeline_name,
                    config,
                    project: meta.project,
                });
                console.log(`  ${file.relPath}  ${label} → pushed`);
                counts.pipelines++;
                break;
            }
            case 'template': {
                const config = JSON.parse(file.content);
                await api.pushTemplate({
                    name,
                    config,
                    pipeline_name: meta.pipeline_name,
                    project: meta.project,
                });
                console.log(`  ${file.relPath}  ${label} → pushed`);
                counts.templates++;
                break;
            }
            case 'dockerfile':
                await api.pushDockerfile({
                    image_name: name,
                    content: file.content,
                });
                console.log(`  ${file.relPath}  ${label} → pushed`);
                counts.dockerfiles++;
                break;
            default:
                console.log(`  ${file.relPath}  skipped (unknown type)`);
        }
    }
    const parts = [];
    if (counts.agents > 0)
        parts.push(`${counts.agents} agent${counts.agents > 1 ? 's' : ''}`);
    if (counts.pipelines > 0)
        parts.push(`${counts.pipelines} pipeline${counts.pipelines > 1 ? 's' : ''}`);
    if (counts.templates > 0)
        parts.push(`${counts.templates} template${counts.templates > 1 ? 's' : ''}`);
    if (counts.dockerfiles > 0)
        parts.push(`${counts.dockerfiles} dockerfile${counts.dockerfiles > 1 ? 's' : ''}`);
    if (parts.length === 0) {
        console.log(`\nNothing to push — all files unchanged.`);
    }
    else {
        console.log(`\n✓ Published to ${rName}: ${parts.join(', ')} updated`);
    }
}
//# sourceMappingURL=push.js.map