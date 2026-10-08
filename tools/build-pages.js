import { readdir, readFile, mkdir, writeFile, copyFile, rm, lstat } from 'node:fs/promises';
import { resolve, join, dirname, extname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const browserPackages = ['binary', 'channels', 'codecs', 'input', 'lab', 'profiles', 'protocol', 'render'];
const allowedExtensions = new Set(['.html', '.js', '.css', '.svg', '.png', '.ico', '.wgsl']);
const csp = "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:* http://[::1]:* ws://localhost:* ws://127.0.0.1:* ws://[::1]:*; object-src 'none'; base-uri 'none'; form-action 'self'";

/** Explicitly stage browser-only files. Never copy a repository root to Pages. */
export async function buildPages(output = join(root, 'dist/pages')) {
    output = resolve(output);
    if (output === root || root.startsWith(output + sep)) throw new Error('Output cannot replace source or its ancestors');
    await mkdir(output, { recursive: true });
    if ((await lstat(output)).isSymbolicLink()) throw new Error('Symlink output is forbidden');
    if ((await readdir(output)).length) throw new Error('Pages output must be empty; remove dist/pages before rebuilding');
    const files = [];
    async function stage(dir) {
        for (const entry of (await readdir(join(root, dir), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.startsWith('.') || entry.name.startsWith('render-test')) continue;
            const name = `${dir}/${entry.name}`;
            if (entry.isSymbolicLink()) throw new Error(`Symlink in browser source: ${name}`);
            if (entry.isDirectory()) { await stage(name); continue; }
            if (!entry.isFile() || !allowedExtensions.has(extname(name))) continue;
            const bytes = await readFile(join(root, name));
            if (bytes.length > 16 * 1024 * 1024) throw new Error(`Oversized browser asset: ${name}`);
            if (name.endsWith('.js') && /\b(?:from\s*|import\s*\()['"]node:/.test(bytes.toString()))
                throw new Error(`Node-only import in browser module: ${name}`);
            await mkdir(dirname(join(output, name)), { recursive: true });
            if (name.endsWith('.html')) {
                const html = bytes.toString().replace('<html lang="en"', '<html data-hosting="static" lang="en"')
                    .replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
                await writeFile(join(output, name), html);
            } else await writeFile(join(output, name), bytes);
            files.push(name);
        }
    }
    await stage('apps/client');
    for (const dir of browserPackages) await stage(`packages/${dir}`);
    let html = await readFile(join(output, 'apps/client/index.html'), 'utf8');
    html = html.replace('href="./styles.css"', 'href="./apps/client/styles.css"')
        .replace('src="./app.js"', 'src="./apps/client/app.js"')
        .replace('href="./gateway.html"', 'href="./apps/client/gateway.html"');
    await writeFile(join(output, 'index.html'), html);
    await writeFile(join(output, '.nojekyll'), '');
    await copyFile(join(root, 'LICENSE'), join(output, 'LICENSE'));
    const sha = /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA || '') ? process.env.GITHUB_SHA : 'local';
    const manifest = { version: 1, commit: sha, hosting: 'static-browser-client', gateway: 'runs separately on the user machine', files: ['index.html', '.nojekyll', 'LICENSE', ...files].sort() };
    await writeFile(join(output, 'build.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const output = join(root, 'dist/pages');
    for (const candidate of [join(root, 'dist'), output])
        if ((await lstat(candidate).catch(() => null))?.isSymbolicLink()) throw new Error('Symlink output is forbidden');
    await rm(output, { recursive: true, force: true });
    const result = await buildPages(output);
    console.log(`Staged ${result.files.length} browser-only files in ${relative(root, output)} (${result.commit})`);
}
