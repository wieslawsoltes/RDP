import { ByteQueue } from '../binary/ByteQueue.js';
import { requireThat } from '../binary/ProtocolError.js';
/** Splits arbitrary TLS chunks into TPKT or fast-path PDUs (MS-RDPBCGR 2.2). */
export class Framer {
    constructor(onFrame, limit = 4 * 1024 * 1024) { this.queue = new ByteQueue(limit); this.onFrame = onFrame; }
    push(bytes) {
        this.queue.push(bytes);
        while (this.queue.length >= 2) {
            const q = this.queue, first = q.peek();
            let size, minimum;
            if (first === 3) {
                if (q.length < 4)
                    return;
                requireThat(q.peek(1) === 0, 'TPKT', 'Invalid TPKT reserved byte');
                size = (q.peek(2) << 8) | q.peek(3);
                minimum = 7;
            }
            else {
                requireThat((first & 3) === 0, 'FASTPATH', 'Invalid fast-path action');
                const second = q.peek(1);
                if ((second & 128) && q.length < 3)
                    return;
                size = second & 128 ? ((second & 127) << 8) | q.peek(2) : second;
                minimum = second & 128 ? 3 : 2;
            }
            requireThat(size >= minimum, 'FRAME_LENGTH', 'Invalid RDP frame length');
            if (q.length < size)
                return;
            this.onFrame(q.read(size), first === 3 ? 'tpkt' : 'fastpath');
        }
    }
    clear() { this.queue.clear(); }
}
