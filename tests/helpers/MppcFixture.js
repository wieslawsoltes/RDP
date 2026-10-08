/** Test-only token encoder, independently transcribed from the published tables.
 * No compressor or production decoder calls are used to construct vectors. */
export function mppcFixture(tokens, type = 1) {
    const bits = [];
    const write = (value, count) => { for (let i = count - 1; i >= 0; i--) bits.push(value >>> i & 1); };
    const literal = value => { write(value < 128 ? value : 0x100 | value & 127, value < 128 ? 8 : 9); };
    for (const token of tokens) {
        if (typeof token === 'string') { for (const value of new TextEncoder().encode(token)) literal(value); }
        else if (typeof token === 'number') literal(token);
        else {
            const [offset, length] = token;
            const table = type ? [[0,63,31,5,6],[64,319,30,5,8],[320,2367,14,4,11],[2368,65535,6,3,16]]
                : [[0,63,15,4,6],[64,319,14,4,8],[320,8191,6,3,13]];
            const range = table.find(([min,max]) => offset >= min && offset <= max);
            if (!range || length < 3 || length > (type ? 65535 : 8191)) throw new Error('Bad test token');
            write(range[2],range[3]); write(offset-range[0],range[4]);
            if (length === 3) write(0,1);
            else { const n = Math.floor(Math.log2(length)); write(2 ** (n-1)-1,n-1); write(0,1); write(length-2 ** n,n); }
        }
    }
    const bytes = new Uint8Array(Math.ceil(bits.length/8));
    bits.forEach((bit,i) => { bytes[i>>>3] |= bit << (7-(i&7)); });
    return bytes;
}
