"""Real Chromium Web Audio + worker + gateway + RDPSND fixture, not physical speakers."""
from __future__ import annotations
import functools
import http.server
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]

def main() -> None:
    subprocess.run(['npm', 'run', 'build:pages'], cwd=ROOT, check=True)
    with tempfile.TemporaryDirectory(prefix='rdp-audio-') as temporary:
        temp = Path(temporary)
        shutil.copytree(ROOT / 'dist/pages', temp / 'RDP')
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(temp))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 8799), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with (temp / 'gateway.log').open('w+') as log:
            gateway = subprocess.Popen(['node', 'tests/fixtures/GatewayBrowser.js'], cwd=ROOT, env={**os.environ, 'RDP_AUDIO_FIXTURE': '1'}, stdout=log, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 10
                while True:
                    if gateway.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read())
                    try:
                        with socket.create_connection(('127.0.0.1', 8798), timeout=0.25):
                            break
                    except OSError:
                        if time.monotonic() >= deadline: raise RuntimeError('Gateway fixture startup timed out')
                        time.sleep(0.05)
                with sync_playwright() as playwright:
                    executable = os.environ.get('CHROMIUM') or shutil.which('google-chrome') or shutil.which('chromium')
                    browser = playwright.chromium.launch(headless=True, executable_path=executable)
                    try:
                        page = browser.new_page(viewport={'width': 1440, 'height': 1100})
                        errors = []
                        page.on('pageerror', lambda error: errors.append(str(error)))
                        page.add_init_script('''(() => {
                            const probe = globalThis.audioProbe = { contexts: [], starts: [], consumed: [] };
                            const Context = globalThis.AudioContext;
                            globalThis.AudioContext = class extends Context {
                                constructor(...args) { super(...args); probe.contexts.push(this); }
                            };
                            const start = AudioBufferSourceNode.prototype.start;
                            AudioBufferSourceNode.prototype.start = function(...args) {
                                probe.starts.push({ channels: this.buffer.numberOfChannels, frames: this.buffer.length,
                                    rate: this.buffer.sampleRate, left: this.buffer.getChannelData(0)[0],
                                    right: this.buffer.numberOfChannels > 1 ? this.buffer.getChannelData(1)[0] : null });
                                return start.apply(this, args);
                            };
                            const post = Worker.prototype.postMessage;
                            Worker.prototype.postMessage = function(message, ...rest) {
                                if (message.type === 'audio-consumed') probe.consumed.push({ id: message.id, disposition: message.disposition });
                                return post.call(this, message, ...rest);
                            };
                        })();''')
                        page.goto('http://127.0.0.1:8799/RDP/')
                        expect(page.locator('#gateway-url')).to_have_value('http://127.0.0.1:8787')
                        page.locator('#gateway-url').fill('http://127.0.0.1:8798')
                        page.locator('#bridge-token').fill('browser-fixture-token-0123456789abcdef')
                        page.locator('#load-targets').click()
                        expect(page.locator('#form-message')).to_contain_text('1 allowlisted target', timeout=15000)
                        expect(page.locator('#target-id')).to_have_value('fixture')
                        page.locator('#backend').select_option('canvas')
                        page.locator('#username').fill('User')
                        page.locator('#domain').fill('LAB')
                        page.locator('#password').fill('Password')
                        page.locator('details').filter(has=page.locator('#audio')).locator('summary').click()
                        expect(page.locator('#audio')).not_to_be_checked()
                        page.locator('#audio').check()
                        page.locator('#connect-button').click()
                        expect(page.locator('.session-foot')).to_contain_text('active', timeout=15000)
                        expect(page.locator('#password')).to_have_value('')
                        def wait_log(text: str, count: int = 1) -> None:
                            deadline = time.monotonic() + 10
                            while True:
                                log.flush(); log.seek(0); output = log.read()
                                if output.count(text) >= count: return
                                if time.monotonic() >= deadline: raise AssertionError(output)
                                page.wait_for_timeout(50)
                        def wait_probe(expression: str) -> None:
                            # Poll a function using the automation protocol, not
                            # string eval inside the page's CSP-constrained RAF.
                            deadline = time.monotonic() + 15
                            while not page.evaluate('() => (' + expression + ')'):
                                if time.monotonic() >= deadline:
                                    probe = page.evaluate('() => ({starts: audioProbe.starts, consumed: audioProbe.consumed, states: audioProbe.contexts.map(c => c.state)})')
                                    raise AssertionError({'condition': expression, 'probe': probe, 'pageErrors': errors})
                                page.wait_for_timeout(25)
                        wait_log('AUDIO_READY')
                        canvas = page.locator('.screen-host canvas')
                        # Remote audio must not automatically create a browser audio device.
                        canvas.focus(); canvas.press('a')
                        wait_probe('audioProbe.consumed.length === 2')
                        assert page.evaluate('() => audioProbe.contexts.length') == 0
                        assert page.evaluate('() => audioProbe.starts.length') == 0
                        assert page.evaluate('() => audioProbe.consumed.every(x => x.disposition === "dropped")')
                        wait_log('AUDIO_CONFIRM', 2)
                        page.get_by_role('button', name='Allow PCM audio playback for this session', exact=True).click()
                        wait_probe('audioProbe.contexts.length === 1 && audioProbe.contexts[0].state === "running"')
                        canvas.focus(); canvas.press('a')
                        wait_probe('audioProbe.consumed.filter(x => x.disposition === "played").length === 2')
                        starts = page.evaluate('() => audioProbe.starts')
                        assert len(starts) == 2, starts
                        assert all(x == {'channels': 2, 'frames': 4800, 'rate': 48000, 'left': 0.5, 'right': -0.5} for x in starts), starts
                        wait_log('AUDIO_CONFIRM', 4)
                        page.get_by_label('Remote sound volume').evaluate("el => { el.value = '25'; el.dispatchEvent(new Event('input', {bubbles:true})); }")
                        page.get_by_role('button', name='Stop queued audio and mute this session', exact=True).click()
                        canvas.focus(); canvas.press('a')
                        wait_probe('audioProbe.consumed.length === 6')
                        assert page.evaluate('() => audioProbe.starts.length') == 2
                        assert page.evaluate('() => audioProbe.consumed.slice(4).every(x => x.disposition === "dropped")')
                        wait_log('AUDIO_CONFIRM', 6)
                        page.get_by_role('button', name='Disconnect and close session', exact=True).click()
                        wait_probe('audioProbe.contexts[0].state === "closed"')
                        assert not errors, errors
                        print(json.dumps({'pcm': 'stereo 48 kHz 16-bit', 'waveInfoAndWave2': True,
                            'browserWebAudioPlayed': 2, 'mutedOrNotEnabledDropped': 4, 'serverConfirmations': 6,
                            'workerTransfers': True, 'sampleValuesExact': True, 'noAutomaticAudioContext': True,
                            'closeReleasesDevice': True, 'pageErrors': errors,
                            'scope': 'Chromium Web Audio, loopback WS/TLS/NLA and co-developed RDP peer; not physical speakers, public HTTPS-to-loopback or Windows qualification'}, indent=2))
                    finally:
                        browser.close()
            finally:
                gateway.terminate()
                try: gateway.wait(timeout=5)
                except subprocess.TimeoutExpired: gateway.kill(); gateway.wait()
                server.shutdown()
                server.server_close()

if __name__ == '__main__':
    main()
