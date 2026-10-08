import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules')
            continue;
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory())
            await walk(path);
        else if (path.endsWith('.js')) {
            const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
            if (result.status)
                process.exit(result.status);
        }
    }
}
await walk('.');
console.log('JavaScript syntax: OK');
