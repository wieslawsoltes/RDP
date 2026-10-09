// Fault injection stays in test code, never in gateway configuration or Pages.
import { BridgeSession } from '../../apps/bridge/BridgeSession.js';
const original = BridgeSession.prototype.message;
let connection = 0;
BridgeSession.prototype.message = function (value, binary) {
    if (!binary) {
        const control = JSON.parse(value);
        if (this.state === 'authentication' && control.type === 'connect') this.dropTestPongs = connection++ === 0;
        if (this.dropTestPongs && control.type === 'ping') return;
    }
    return original.call(this, value, binary);
};
await import('./GatewayBrowser.js');
