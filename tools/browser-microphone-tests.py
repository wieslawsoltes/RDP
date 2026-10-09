"""Synthetic microphone -> real Chromium capture/worklet -> worker -> WS/TLS/NLA.

Only a generated WAV is captured. Browser permission is granted by the test
context; normal origin, CSP, mixed-content and certificate policies stay on.
This does not qualify physical microphones or independent Windows servers.
"""
from __future__ import annotations
import functools
import http.server
import json
import math
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
import wave
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PAGE = 'http://127.0.0.1:8799/RDP/'
START = 'Start microphone capture for this remote session'
STOP = 'Stop microphone capture and release the device'

PROBE = '''(() => {
    const probe = globalThis.micProbe = { requests: 0, contexts: [], tracks: [],
        transferred: 0, acknowledgements: 0, pending: new Set(), maxPending: 0, detachFailures: 0 };
    const Context = globalThis.AudioContext;
    globalThis.AudioContext = class extends Context {
        constructor(...args) { super(...args); probe.contexts.push(this); }
    };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (...args) => {
        probe.requests++;
        return capture(...args).then(stream => { probe.tracks.push(...stream.getTracks()); return stream; });
    };
    const post = Worker.prototype.postMessage;
    const observed = new WeakSet();
    const key = m => `${m.requestId}:${m.captureId}:${m.id}`;
    Worker.prototype.postMessage = function(message, ...rest) {
        if (!observed.has(this)) {
            observed.add(this);
            this.addEventListener('message', ({data}) => {
                if (data.type === 'microphone-consumed') {
                    probe.pending.delete(key(data)); probe.acknowledgements++;
                }
            });
        }
        if (message.type === 'microphone-data') {
            probe.pending.add(key(message)); probe.maxPending = Math.max(probe.maxPending, probe.pending.size);
        }
        const result = post.call(this, message, ...rest);
        if (message.type === 'microphone-data') {
            probe.transferred++;
            if (message.planes.some(p => p.byteLength !== 0)) probe.detachFailures++;
        }
        return result;
    };
})();'''


def main() -> None:
    subprocess.run(['npm', 'run', 'build:pages'], cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory(prefix='rdp-microphone-') as temporary:
        temp = Path(temporary)
        # Looping deterministic mono-equivalent stereo tone, not ambient audio.
        wav = temp / 'input.wav'
        with wave.open(str(wav), 'wb') as output:
            output.setnchannels(2); output.setsampwidth(2); output.setframerate(48000)
            output.writeframes(b''.join(struct.pack('<hh', *([round(12000 * math.sin(i * math.tau * 440 / 48000))] * 2))
                                       for i in range(48000 * 4)))
        shutil.copytree(ROOT / 'dist/pages', temp / 'RDP')
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(temp))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 8799), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with (temp / 'gateway.log').open('w+') as log:
            gateway = subprocess.Popen(['node', 'tests/fixtures/GatewayBrowser.js'], cwd=ROOT,
                env={**os.environ, 'RDP_MICROPHONE_FIXTURE': '1'}, stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 15
                while True:
                    if gateway.poll() is not None:
                        log.seek(0); raise RuntimeError(log.read())
                    try:
                        with socket.create_connection(('127.0.0.1', 8798), timeout=0.25): break
                    except OSError:
                        if time.monotonic() >= deadline: raise RuntimeError('Gateway fixture startup timed out')
                        time.sleep(0.05)
                with sync_playwright() as playwright:
                    executable = os.environ.get('CHROMIUM') or shutil.which('google-chrome') or shutil.which('chromium')
                    browser = playwright.chromium.launch(headless=True, executable_path=executable,
                        args=['--use-fake-device-for-media-stream', f'--use-file-for-fake-audio-capture={wav}'])
                    try:
                        context = browser.new_context(viewport={'width': 1440, 'height': 1100})
                        page = context.new_page(); errors = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.add_init_script(PROBE)
                        page.goto(PAGE)
                        expect(page.locator('#microphone')).not_to_be_checked()
                        page.locator('#gateway-url').fill('http://127.0.0.1:8798')
                        page.locator('#bridge-token').fill('browser-fixture-token-0123456789abcdef')
                        page.locator('#load-targets').click()
                        expect(page.locator('#form-message')).to_contain_text('1 allowlisted target', timeout=15000)
                        page.locator('#backend').select_option('canvas')
                        page.locator('#connection-name').fill('Microphone fixture')
                        page.locator('#username').fill('User'); page.locator('#domain').fill('LAB')
                        page.locator('#password').fill('Password')
                        page.locator('details').filter(has=page.locator('#microphone')).locator('summary').click()
                        page.locator('#microphone').check(); page.locator('#resize').uncheck()
                        page.locator('#connect-button').click()
                        expect(page.locator('.session-foot')).to_contain_text('active', timeout=15000)
                        status = page.get_by_role('status', name='Microphone status', exact=True)
                        expect(status).to_have_text('Mic: start requested')
                        assert page.evaluate('() => micProbe.requests') == 0
                        assert page.evaluate('() => micProbe.contexts.length') == 0
                        canvas = page.locator('.screen-host canvas')

                        def output() -> str:
                            log.flush(); log.seek(0); return log.read()

                        def barrier() -> dict:
                            previous = output().count('MIC_BARRIER ')
                            canvas.focus(); canvas.press('b')
                            deadline = time.monotonic() + 10
                            while output().count('MIC_BARRIER ') <= previous:
                                if time.monotonic() >= deadline: raise AssertionError(output())
                                page.wait_for_timeout(25)
                            return json.loads(output().split('MIC_BARRIER ')[-1].splitlines()[0])

                        def wait_probe(expression: str) -> None:
                            deadline = time.monotonic() + 15
                            while not page.evaluate('() => (' + expression + ')'):
                                if time.monotonic() >= deadline:
                                    raise AssertionError({'condition': expression, 'status': status.text_content(), 'errors': errors})
                                page.wait_for_timeout(25)

                        def wait_packets(index: int, minimum: int) -> dict:
                            deadline = time.monotonic() + 15
                            while True:
                                value = barrier()
                                if value['counts'][index] >= minimum: return value
                                if time.monotonic() >= deadline: raise AssertionError(value)
                                page.wait_for_timeout(50)

                        assert barrier()['total'] == 0
                        # Controlled test permission, still no capture until the button action.
                        context.grant_permissions(['microphone'], origin='http://127.0.0.1:8799')
                        page.get_by_role('button', name=START, exact=True).click()
                        expect(status).to_have_text('Mic: recording', timeout=15000)
                        first = wait_packets(0, 8)
                        assert first['openReplies'] == 1 and first['nonzero'] > 0, first
                        assert 0.05 < first['rms'][0] < 0.8, first
                        assert page.evaluate('() => micProbe.requests') == 1
                        assert page.evaluate('() => micProbe.detachFailures') == 0
                        assert 0 < page.evaluate('() => micProbe.maxPending') <= 4

                        page.get_by_role('button', name=STOP, exact=True).click()
                        expect(status).to_have_text('Mic: off')
                        wait_probe('micProbe.contexts.every(c => c.state === "closed") && micProbe.tracks.every(t => t.readyState === "ended")')
                        stopped = barrier(); page.wait_for_timeout(150)
                        assert barrier()['total'] == stopped['total']
                        page.get_by_role('button', name=START, exact=True).click()
                        expect(status).to_have_text('Mic: recording')
                        resumed = wait_packets(0, stopped['counts'][0] + 5)
                        assert resumed['openReplies'] == 1, resumed

                        canvas.focus(); canvas.press('f')
                        changed = wait_packets(1, 6)
                        assert 0.05 < changed['rms'][1] < 0.8, changed
                        assert page.evaluate('() => micProbe.requests') == 2
                        canvas.focus(); canvas.press('x')
                        expect(status).to_have_text('Mic: channel closed')
                        wait_probe('micProbe.tracks.every(t => t.readyState === "ended")')
                        expect(page.get_by_role('button', name=START, exact=True)).to_be_disabled()
                        canvas.focus(); canvas.press('n')
                        expect(status).to_have_text('Mic: start requested')
                        before_reopen = barrier(); page.wait_for_timeout(150)
                        assert barrier()['total'] == before_reopen['total']
                        assert page.evaluate('() => micProbe.requests') == 2
                        page.get_by_role('button', name=START, exact=True).click()
                        expect(status).to_have_text('Mic: recording')
                        reopened = wait_packets(0, before_reopen['counts'][0] + 5)
                        assert reopened['openReplies'] == 2, reopened
                        page.get_by_role('button', name='Overview', exact=True).click()
                        wait_probe('micProbe.tracks.every(t => t.readyState === "ended")')
                        page.get_by_role('button', name='Microphone fixture', exact=True).click()
                        expect(status).to_have_text('Mic: session hidden')
                        assert page.evaluate('() => micProbe.requests') == 3
                        page.get_by_role('button', name=START, exact=True).click()
                        expect(status).to_have_text('Mic: recording')
                        wait_packets(0, reopened['counts'][0] + 5)
                        final = barrier()
                        page.get_by_role('button', name='Disconnect and close session', exact=True).click()
                        wait_probe('micProbe.contexts.every(c => c.state === "closed") && micProbe.tracks.every(t => t.readyState === "ended")')
                        assert not errors, errors
                        print(json.dumps({'syntheticMicrophone': True, 'explicitPermissionAndStart': True,
                            'realAudioWorklet': True, 'realWorkerTransfers': True, 'wsTlsNlaAndDvc': True,
                            'wireFormats': ['48000 Hz stereo PCM16', '16000 Hz mono PCM16'],
                            'capturedPackets': final['total'], 'stopRestartAndChannelRecreation': True,
                            'hiddenSessionStopsCapture': True, 'closeReleasesTracksAndContexts': True,
                            'maximumPendingChunks': page.evaluate('() => micProbe.maxPending'),
                            'pageErrors': errors,
                            'scope': 'Chromium with synthetic capture media and controlled permission; co-developed peer, not physical microphone/Windows/public HTTPS-to-loopback qualification'}, indent=2))
                    finally:
                        browser.close()
            finally:
                gateway.terminate()
                try: gateway.wait(timeout=5)
                except subprocess.TimeoutExpired: gateway.kill(); gateway.wait()
                server.shutdown(); server.server_close()

if __name__ == '__main__':
    main()
