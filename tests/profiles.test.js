import test from 'node:test';
import assert from 'node:assert/strict';
import { Profiles, sanitizeProfile, importRdp, exportRdp } from '../packages/profiles/Profiles.js';
import { scanCode, chord } from '../packages/input/ScanCodes.js';
test('Profiles persist explicit metadata only, never credentials or bridge tokens', () => {
    let serialized;
    const storage = { getItem: () => null, setItem: (_, value) => { serialized = value; } };
    const profiles = new Profiles(storage);
    const profile = profiles.save({ name: 'test', password: 'DO_NOT_PERSIST', token: 'TOKEN_NOT_PERSIST', secret: { nested: 'bad' }, width: 1280, height: 800 });
    assert.ok(profile.id);
    assert.ok(!serialized.includes('DO_NOT_PERSIST'));
    assert.ok(!serialized.includes('TOKEN_NOT_PERSIST'));
    assert.ok(!serialized.includes('secret'));
    profiles.remove(profile.id);
    assert.equal(serialized, '[]');
});
test('Malformed storage and imported dimensions are constrained', () => {
    assert.deepEqual(new Profiles({ getItem: () => '{broken' }).items, []);
    const p = sanitizeProfile({ width: 8192, height: 8192, bpp: 64, backend: 'javascript:evil', security: 'rdp', name: 'a\r\nb\0' });
    assert.equal(p.width, 1280);
    assert.equal(p.bpp, 24);
    assert.equal(p.backend, 'auto');
    assert.equal(p.security, 'nla');
    assert.equal(p.name, 'ab');
});
test('.rdp import never turns file addresses or password blobs into trusted targets', () => {
    const result = importRdp('full address:s:host.example:3389\r\nusername:s:User\r\npassword 51:b:DEADBEEF\r\ngatewayhostname:s:evil\r\ndesktopwidth:i:1600\r\nredirectclipboard:i:0');
    assert.equal(result.address, 'host.example:3389');
    assert.equal(result.profile.targetId, '');
    assert.equal(result.profile.width, 1600);
    assert.equal(result.profile.clipboard, false);
    assert.ok(result.ignored.includes('password 51'));
    const exported = exportRdp({ ...result.profile, password: 'secret' });
    assert.ok(!exported.includes('DEADBEEF'));
    assert.ok(!exported.includes('secret'));
    assert.ok(!exported.includes('full address:s:'));
});
test('Physical keys and extended shortcuts produce balanced down/up events', () => {
    assert.deepEqual(scanCode('KeyA'), { type: 'key', code: 0x1e, up: false });
    assert.equal(scanCode('ControlRight').extended, true);
    assert.equal(scanCode('Pause').extended1, true);
    assert.equal(scanCode('Unknown'), null);
    const events = chord(['ControlLeft', 'AltLeft', 'Delete']);
    assert.equal(events.length, 6);
    assert.equal(events[2].extended, true);
    assert.equal(events[3].up, true);
    assert.deepEqual(events.map(e => e.code), [29, 56, 83, 83, 56, 29]);
});
