import { loadRemotes, saveRemotes, deleteRemoteCredentials, } from '../remote-config.js';
export async function remote(args) {
    const subcommand = args[0];
    switch (subcommand) {
        case 'add': {
            const name = args[1];
            const url = args[2];
            if (!name || !url) {
                console.error('Usage: art remote add <name> <url>');
                process.exit(1);
            }
            const config = loadRemotes();
            if (config.remotes[name]) {
                console.error(`Remote "${name}" already exists. Remove it first with "art remote remove ${name}".`);
                process.exit(1);
            }
            const normalized = url.replace(/\/+$/, '');
            const isFirst = Object.keys(config.remotes).length === 0;
            config.remotes[name] = { url: normalized, default: isFirst || undefined };
            saveRemotes(config);
            console.log(`Added remote "${name}" → ${normalized}`);
            if (isFirst)
                console.log(`  (set as default)`);
            break;
        }
        case 'remove': {
            const name = args[1];
            if (!name) {
                console.error('Usage: art remote remove <name>');
                process.exit(1);
            }
            const config = loadRemotes();
            if (!config.remotes[name]) {
                console.error(`Remote "${name}" not found.`);
                process.exit(1);
            }
            const wasDefault = config.remotes[name].default;
            delete config.remotes[name];
            deleteRemoteCredentials(name);
            if (wasDefault) {
                const remaining = Object.keys(config.remotes);
                if (remaining.length > 0) {
                    config.remotes[remaining[0]].default = true;
                }
            }
            saveRemotes(config);
            console.log(`Removed remote "${name}"`);
            break;
        }
        case 'list': {
            const config = loadRemotes();
            const entries = Object.entries(config.remotes);
            if (entries.length === 0) {
                console.log('No remotes configured. Run "art remote add <name> <url>" to add one.');
                return;
            }
            for (const [name, r] of entries) {
                const marker = r.default ? ' (default)' : '';
                console.log(`  ${name}\t${r.url}${marker}`);
            }
            break;
        }
        case 'set-default': {
            const name = args[1];
            if (!name) {
                console.error('Usage: art remote set-default <name>');
                process.exit(1);
            }
            const config = loadRemotes();
            if (!config.remotes[name]) {
                console.error(`Remote "${name}" not found.`);
                process.exit(1);
            }
            for (const r of Object.values(config.remotes)) {
                delete r.default;
            }
            config.remotes[name].default = true;
            saveRemotes(config);
            console.log(`Default remote set to "${name}"`);
            break;
        }
        default:
            console.log(`Usage:
  art remote add <name> <url>       Register a backend endpoint
  art remote remove <name>          Remove a registered backend
  art remote list                   List configured backends
  art remote set-default <name>     Set default backend`);
            if (subcommand) {
                console.error(`\nUnknown subcommand: ${subcommand}`);
                process.exit(1);
            }
    }
}
//# sourceMappingURL=remote.js.map