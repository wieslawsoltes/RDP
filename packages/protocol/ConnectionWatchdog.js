/**
 * Connection-local watchdog. Owns no timers, sockets or credentials; the worker
 * drives tick() from a monotonic clock. A pong proves gateway responsiveness,
 * never RDP-server responsiveness. Phase deadlines cannot be reset by traffic.
 */
export class ConnectionWatchdog {
    constructor({ ping, fail, health = () => {}, now = () => performance.now(),
        connectMs = 15000, secureMs = 35000, activateMs = 60000,
        intervalMs = 5000, warningMs = 10000, timeoutMs = 20000 } = {}) {
        for (const callback of [ping, fail, health, now])
            if (typeof callback !== 'function') throw new TypeError('Watchdog callbacks must be functions');
        for (const value of [connectMs, secureMs, activateMs, intervalMs, warningMs, timeoutMs])
            if (!Number.isSafeInteger(value) || value <= 0 || value > 300000)
                throw new RangeError('Invalid watchdog deadline');
        if (intervalMs > warningMs || warningMs >= timeoutMs) throw new RangeError('Invalid heartbeat timing order');
        Object.assign(this, { ping, fail, health, now, connectMs, secureMs, activateMs, intervalMs, warningMs, timeoutMs });
        this.phase = 'connecting'; this.pending = null; this.nextId = 1; this.lastNow = -Infinity;
        this.deadline = this.time() + connectMs; this.nextPing = Infinity; this.status = 'connecting';
        this.rttMs = null;
    }
    time() {
        const value = this.now();
        if (!Number.isFinite(value)) throw new TypeError('Watchdog clock must be finite');
        // The browser uses performance.now(). Also resist rollback in embedders.
        this.lastNow = Math.max(this.lastNow, value);
        return this.lastNow;
    }
    opened() {
        if (this.phase === 'closed') return false;
        if (this.phase !== 'connecting') throw new Error('Gateway is already open');
        const time = this.time();
        if (this.expired(time)) return false;
        this.phase = 'securing'; this.deadline = time + this.secureMs; this.nextPing = time;
        this.tick(); return this.phase !== 'closed';
    }
    secured() {
        if (this.phase === 'closed') return false;
        if (this.phase !== 'securing') throw new Error('Unexpected gateway security completion');
        const time = this.time();
        if (this.expired(time)) return false;
        this.phase = 'activating'; this.deadline = time + this.activateMs; return true;
    }
    activated() {
        if (this.phase === 'closed') return false;
        if (this.phase === 'active') return true;
        if (this.phase !== 'activating') throw new Error('Unexpected RDP activation');
        if (this.expired(this.time())) return false;
        this.phase = 'active'; this.deadline = Infinity; return true;
    }
    reactivating() {
        if (this.phase === 'closed') return false;
        // Repeated notifications do not extend an outstanding activation limit.
        if (this.phase === 'active') {
            this.phase = 'activating'; this.deadline = this.time() + this.activateMs;
        }
        return true;
    }
    expired(time) {
        if (time < this.deadline) return false;
        const errors = {
            connecting: ['GATEWAY_OPEN_TIMEOUT', 'The gateway WebSocket did not open. Check its address, certificate and local-network permission.'],
            securing: ['GATEWAY_SECURITY_TIMEOUT', 'The gateway did not complete the RDP security handshake.'],
            activating: ['RDP_ACTIVATION_TIMEOUT', 'The remote RDP desktop did not finish activation.'],
        };
        const [code, message] = errors[this.phase];
        this.failure(code, message); return true;
    }
    tick() {
        if (this.phase === 'closed') return;
        const time = this.time();
        if (this.expired(time) || this.phase === 'connecting') return;
        if (this.pending) {
            const age = time - this.pending.time;
            if (age >= this.timeoutMs) {
                this.failure('GATEWAY_HEARTBEAT_TIMEOUT', 'The gateway stopped answering probes. Reconnect with fresh credentials.');
            } else if (age >= this.warningMs) this.notify('unresponsive');
        } else if (time >= this.nextPing) {
            const id = this.nextId++;
            if (!Number.isSafeInteger(id)) { this.failure('GATEWAY_PROBE_LIMIT', 'Gateway probe identifier limit reached.'); return; }
            this.pending = { id, time }; this.nextPing = time + this.intervalMs;
            try { this.ping(id); }
            catch { this.failure('GATEWAY_PROBE_FAILED', 'Could not send a gateway probe.'); }
        }
    }
    pong(id) {
        if (this.phase === 'closed' || !this.pending || !Number.isSafeInteger(id) || this.pending.id !== id) return false;
        const time = this.time();
        if (this.expired(time)) return false;
        if (time - this.pending.time >= this.timeoutMs) {
            this.failure('GATEWAY_HEARTBEAT_TIMEOUT', 'The gateway probe arrived after its deadline. Reconnect with fresh credentials.');
            return false;
        }
        this.rttMs = time - this.pending.time; this.pending = null;
        this.notify('responsive'); return true;
    }
    notify(status) {
        if (this.status === status) return;
        this.status = status;
        this.health({ status, phase: this.phase, rttMs: this.rttMs });
    }
    failure(code, message) {
        if (this.phase === 'closed') return;
        this.phase = 'closed'; this.pending = null; this.nextPing = this.deadline = Infinity;
        this.notify('disconnected');
        this.fail(Object.assign(new Error(message), { code }));
    }
    close() { this.phase = 'closed'; this.pending = null; this.nextPing = this.deadline = Infinity; }
}
