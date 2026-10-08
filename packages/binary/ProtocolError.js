/** A controlled, serializable failure. Never embed credentials or raw wire data. */
export class ProtocolError extends Error {
    constructor(code, message, offset = undefined) {
        super(message);
        this.name = 'ProtocolError';
        this.code = code;
        this.offset = offset;
    }
    toJSON() { return { code: this.code, message: this.message, offset: this.offset }; }
}
export function requireThat(condition, code, message, offset) {
    if (!condition)
        throw new ProtocolError(code, message, offset);
}
export function checkedSize(value, maximum, label = 'Length') {
    requireThat(Number.isSafeInteger(value) && value >= 0 && value <= maximum, 'LIMIT', `${label} is outside the supported resource limit`);
    return value;
}
