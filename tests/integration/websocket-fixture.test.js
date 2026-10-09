import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketPeer } from '../../packages/transport/WebSocketPeer.js';
import { websocketClient } from '../fixtures/WebSocketClient.js';
test('Test WS receiver distinguishes the extended-length marker from a decoded length of 127',async t=>{
    const sockets=new Set(),server=http.createServer();
    server.on('upgrade',(req,socket)=>{
        sockets.add(socket);const peer=WebSocketPeer.accept(req,socket);
        for(const size of [125,126,127,128,65535,65536])peer.sendBinary(new Uint8Array(size).fill(size&255));
        peer.sendJSON({done:true});
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));});
    const ws=await websocketClient(`http://127.0.0.1:${server.address().port}`,'http://127.0.0.1');t.after(()=>ws.socket.destroy());
    for(const size of [125,126,127,128,65535,65536]){const data=await ws.receive();assert.equal(data.length,size);assert.ok(data.every(v=>v===(size&255)));}
    assert.deepEqual(await ws.receive(),{done:true});
});
