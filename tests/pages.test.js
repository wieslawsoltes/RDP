import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { buildPages } from '../tools/build-pages.js';

test('Pages build is subpath-safe and includes all browser imports but no gateway or credentials', async t => {
    const output = await mkdtemp(join(tmpdir(), 'rdp-pages-'));
    t.after(() => rm(output, { recursive: true, force: true }));
    const manifest = await buildPages(output), files = new Set(manifest.files);
    assert.ok(files.has('apps/client/session-worker.js'));
    assert.ok(files.has('apps/client/Gateway.js'));
    assert.ok(files.has('packages/render/shaders.js'));
    for (const name of files) {
        assert.ok(!/^(apps\/(bridge|gateway)|packages\/(security|transport)|tests|\.git)\//.test(name), name);
        assert.ok(!/targets\.json|\.pem$|\.key$|\.env$|render-test/.test(name), name);
        if (!name.endsWith('.js')) continue;
        const text = await readFile(join(output, name), 'utf8');
        for (const match of text.matchAll(/(?:from\s+|import\s*\(|new URL\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g)) {
            const dependency = posix.normalize(posix.join(posix.dirname(name), match[2]));
            assert.ok(files.has(dependency), `${name} -> missing ${dependency}`);
        }
    }
    const index = await readFile(join(output, 'index.html'), 'utf8');
    assert.match(index, /data-hosting="static"/);
    assert.match(index, /src="\.\/apps\/client\/app.js"/);
    assert.match(index, /Content-Security-Policy/);
    assert.ok(!/(?:src|href)="\/apps\//.test(index));
    const base = new URL('https://example.test/RDP/');
    for (const match of index.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)) {
        const url = new URL(match[1], base);
        assert.ok(url.pathname.startsWith('/RDP/'));
        await access(join(output, url.pathname.slice('/RDP/'.length)));
    }
    await assert.rejects(buildPages(output), /empty/);
});
