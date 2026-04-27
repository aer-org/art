import path from 'path';
import { loadBundleMeta, readBundleFiles, classifyFile } from '../bundle.js';
function parseArgs(args) {
    let dir = '.';
    let verbose = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--verbose' || args[i] === '-v') {
            verbose = true;
        }
        else if (!args[i].startsWith('--')) {
            dir = args[i];
        }
    }
    return { dir, verbose };
}
function lineDiff(original, current) {
    const origLines = original.split('\n');
    const currLines = current.split('\n');
    const origSet = new Set(origLines);
    const currSet = new Set(currLines);
    let added = 0;
    let removed = 0;
    for (const line of currLines) {
        if (!origSet.has(line))
            added++;
    }
    for (const line of origLines) {
        if (!currSet.has(line))
            removed++;
    }
    return { added, removed };
}
export async function diff(args) {
    const { dir: rawDir, verbose } = parseArgs(args);
    const dir = path.resolve(rawDir);
    const meta = loadBundleMeta(dir);
    if (!meta) {
        console.error(`No .art-bundle.json found in ${dir}. Pull a pipeline first with "art pull".`);
        process.exit(1);
    }
    const files = readBundleFiles(dir);
    const seenPaths = new Set();
    let hasChanges = false;
    for (const file of files) {
        seenPaths.add(file.relPath);
        const originalHash = meta.hashes[file.relPath];
        const { kind } = classifyFile(file.relPath);
        if (!originalHash) {
            console.log(`  ${file.relPath}  NEW (${kind})`);
            hasChanges = true;
            continue;
        }
        if (originalHash === file.hash) {
            console.log(`  ${file.relPath}  UNCHANGED`);
            continue;
        }
        hasChanges = true;
        // Compute a rough line diff for display
        // We don't have the original content, just the hash, so show hash change
        console.log(`  ${file.relPath}  MODIFIED`);
    }
    // Check for deleted files
    for (const relPath of Object.keys(meta.hashes)) {
        if (!seenPaths.has(relPath)) {
            console.log(`  ${relPath}  DELETED`);
            hasChanges = true;
        }
    }
    if (!hasChanges) {
        console.log('\nNo changes detected.');
    }
    else {
        console.log(`\nRemote: ${meta.remote} | Pipeline: ${meta.pipeline_name}:${meta.tag}`);
    }
}
//# sourceMappingURL=diff.js.map