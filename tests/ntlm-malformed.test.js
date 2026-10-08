import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAvPairs } from '../packages/security/NtlmV2.js';
import { ProtocolError } from '../packages/binary/ProtocolError.js';
import { Writer } from '../packages/binary/Writer.js';

test('NTLM AV input requires a terminator and reports controlled protocol errors', () => {
    for (const bytes of [new Uint8Array(), new Writer().u16le(1).u16le(0).finish()]) {
        assert.throws(() => parseAvPairs(bytes), error =>
            error instanceof ProtocolError && error.code === 'NTLM_AV_TERMINATOR');
    }
    assert.equal(parseAvPairs(new Uint8Array(4)).size, 0);
    for (let size = 1; size < 4; size++)
        assert.throws(() => parseAvPairs(new Uint8Array(size)), ProtocolError);
});
