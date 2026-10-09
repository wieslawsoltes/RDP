import { gatewayEndpoint, defaultGateway, loadGatewayTargets } from './Gateway.js';
import { Profiles, sanitizeProfile, importRdp, exportRdp } from '../../packages/profiles/Profiles.js';
import { SessionView } from './SessionView.js';
import { icon, button, element, toast, download } from './ui.js';
const $ = selector => document.querySelector(selector), form = $('#connection-form'), profiles = new Profiles(), sessions = new Map();
let targets = [], selected = null, loadedGateway = null, targetRequest = null, generation = 0;
const gatewayInput = $('#gateway-url');
gatewayInput.value = defaultGateway(location.href, document.documentElement.dataset.hosting === 'static');
function clearGateway() {
    generation++;
    targetRequest?.abort();
    $('#load-targets').disabled = false;
    targets = [];
    loadedGateway = null;
    $('#password').value = $('#bridge-token').value = '';
    $('#target-id').replaceChildren();
    $('#form-message').textContent = 'Gateway changed. Paste its token and load targets again.';
}
gatewayInput.addEventListener('input', clearGateway);
const coverage = [
    ['TCP → X.224 → TLS bridge; certificate validation and allowlisted targets', 'Implemented'],
    ['CredSSP v5/v6 + NTLMv2; server binding verified before delegation', 'Implemented / unaudited'],
    ['MCS / GCC; activation gated on verified gateway licensing', 'Implemented subset'],
    ['Bitmap updates, 8/15/16/24/32-bit raw and 8/15/16/24-bit interleaved RLE', 'Implemented'],
    ['MPPC 8/64 KiB receive compression and bounded 32-bit planar decoding', 'Implemented'],
    ['Local TCP/TLS/NLA gateway and separately hosted static browser app', 'Implemented'],
    ['WebGPU compute conversion, ordered framebuffer writes and cursor composition', 'Implemented'],
    ['WebGL2 and Canvas 2D fallback compositors', 'Implemented'],
    ['Physical keyboard, Unicode, mouse, wheel; touch/pen mapped to mouse', 'Implemented'],
    ['Unicode, opt-in HTML/PNG/DIB clipboard; multi-monitor display control', 'Implemented'],
    ['Independent Windows / Windows Server interoperability qualification', 'Not completed'],
    ['CAL request/challenge/issuance/upgrade and encrypted gateway cache', 'Implemented / bounded profile'],
    ['GDI orders, RemoteFX, RDPEGFX, AVC420/444', 'Not implemented'],
    ['Kerberos, Remote Credential Guard, RD Gateway and UDP multitransport', 'Not implemented'],
    ['Opt-in PCM audio output over the reliable RDPSND channel', 'Implemented'],
    ['Bounded gateway health probes and explicit fresh-credential reconnection', 'Implemented'],
    ['Microphone, camera, native touch, USB, smart cards, drives and printers', 'Not implemented'],
    ['Clipboard file streaming, automatic session resumption and RemoteApp', 'Not implemented'],
];
for (const [name, status] of coverage) {
    const row = element('div', 'coverage-row');
    row.append(element('span', '', name), element('span', status.startsWith('Not') ? 'not' : '', status));
    $('#coverage-table').append(row);
}
function showCoverage() { $('#coverage-dialog').showModal(); }
for (const id of ['coverage-nav', 'coverage-inline'])
    $(`#${id}`).onclick = showCoverage;
for (const item of document.querySelectorAll('[data-close-dialog]'))
    item.onclick = () => $('#coverage-dialog').close();
function showOverview() {
    selected = null;
    $('#overview').hidden = false;
    $('#sessions').hidden = true;
    $('#overview-tab').classList.add('active');
    $('#page-title').textContent = 'Overview';
    for (const session of sessions.values())
        session.select(false);
    $('#sidebar').classList.remove('open');
}
function selectSession(id) {
    selected = id;
    $('#overview').hidden = true;
    $('#sessions').hidden = false;
    $('#overview-tab').classList.remove('active');
    for (const session of sessions.values())
        session.select(session.id === id);
    const session = sessions.get(id);
    $('#page-title').textContent = session.mode === 'lab' ? 'Protocol Lab' : session.options.name;
    $('#sidebar').classList.remove('open');
}
function closeSession(session) {
    session.close();
    sessions.delete(session.id);
    if (selected === session.id) {
        const last = [...sessions.keys()].at(-1);
        if (last)
            selectSession(last);
        else
            showOverview();
    }
    $('#global-status').textContent = sessions.size ? `${sessions.size} open session${sessions.size === 1 ? '' : 's'}` : 'Ready';
}
function openSession(mode, options) {
    if (sessions.size >= 4) {
        toast('This build permits four open session tabs. Close a session before opening another.');
        return;
    }
    let session;
    session = new SessionView({ mode, options, password: mode === 'lab' ? '' : $('#password').value, token: mode === 'lab' ? '' : $('#bridge-token').value, onClose: closeSession, onReconnect: reconnectSession, onSelect: () => selectSession(session.id) });
    $('#password').value = '';
    sessions.set(session.id, session);
    $('#session-tabs').append(session.tab);
    $('#sessions').append(session.root);
    selectSession(session.id);
    $('#global-status').textContent = `${sessions.size} open session${sessions.size === 1 ? '' : 's'}`;
}
function reconnectSession(session) {
    // Reconnection is a new, explicit authentication, never stored-password retry.
    // In particular, do not restore gatewayUrl from a profile or remote event.
    const profile = sanitizeProfile(session.options);
    closeSession(session);
    clearGateway();
    fillProfile(profile);
    $('#form-message').textContent = 'Reconnect with fresh credentials. Verify the gateway address, paste its token, load its targets and enter your password again.';
    gatewayInput.focus();
}
function currentProfile() { return sanitizeProfile({ ...Object.fromEntries(new FormData(form)), clipboard: $('#clipboard').checked, richClipboard: $('#rich-clipboard').checked, resize: $('#resize').checked, audio: $('#audio').checked }); }
function fillProfile(profile) {
    showOverview();
    const p = sanitizeProfile(profile);
    for (const [key, value] of Object.entries(p)) {
        const control = form.elements.namedItem(key);
        if (!control)
            continue;
        if (control.type === 'checkbox')
            control.checked = value;
        else
            control.value = value;
    }
    $('#password').value = '';
    if (p.targetId && !targets.some(target => target.id === p.targetId)) {
        const option = element('option', '', `${p.targetId} · load targets to verify`);
        option.value = p.targetId;
        $('#target-id').append(option);
        $('#target-id').value = p.targetId;
    }
    $('#form-message').textContent = 'Connection metadata loaded. Enter the bridge token and load its target allowlist before connecting.';
}
function renderProfiles() {
    $('#profile-list').replaceChildren();
    $('#profile-count').textContent = profiles.items.length;
    if (!profiles.items.length) {
        $('#profile-list').append(element('p', 'muted empty-small', 'Your connections, kept on this device. Passwords are never saved.'));
        return;
    }
    for (const profile of profiles.items) {
        const row = element('div', 'profile-item'), open = button('', { className: 'profile-button', symbol: 'monitor', title: `Load ${profile.name}` }), labels = element('span');
        labels.append(element('strong', '', profile.name), element('small', '', profile.targetId || 'Target not selected'));
        open.append(labels);
        open.onclick = () => fillProfile(profile);
        const remove = button('', { className: 'icon-button profile-delete', symbol: 'close', title: `Remove saved profile ${profile.name}` });
        remove.onclick = () => {
            try {
                profiles.remove(profile.id);
                renderProfiles();
            }
            catch (error) {
                toast(error.message);
            }
        };
        row.append(open, remove);
        $('#profile-list').append(row);
    }
}
$('#save-profile').onclick = () => {
    try {
        const saved = profiles.save(currentProfile());
        $('#profile-id').value = saved.id;
        renderProfiles();
        toast('Profile saved on this device. No password or bridge token was stored.');
    }
    catch (error) {
        toast(error.message);
    }
};
$('#load-targets').onclick = async () => {
    const token = $('#bridge-token').value;
    if (token.length < 24) {
        $('#form-message').textContent = 'Paste the access token printed by the running bridge.';
        return;
    }
    const control = $('#load-targets'), requestId = ++generation;
    targetRequest?.abort();
    const request = targetRequest = new AbortController();
    const timer = setTimeout(() => request.abort(), 10000);
    control.disabled = true;
    targets = [];
    loadedGateway = null;
    try {
        const endpoint = gatewayEndpoint(gatewayInput.value);
        const receivedTargets = await loadGatewayTargets(endpoint, token, { signal: request.signal });
        if (requestId !== generation) return;
        targets = receivedTargets;
        loadedGateway = endpoint;
        const previous = $('#target-id').value;
        $('#target-id').replaceChildren();
        if (!targets.length) {
            const option = element('option', '', 'No targets configured on bridge');
            option.value = '';
            $('#target-id').append(option);
        }
        for (const target of targets) {
            const option = element('option', '', `${target.name || target.id} · ${target.id}`);
            option.value = target.id;
            $('#target-id').append(option);
        }
        if (targets.some(target => target.id === previous))
            $('#target-id').value = previous;
        updateSecurity();
        $('#form-message').textContent = targets.length ? `${targets.length} allowlisted target${targets.length === 1 ? '' : 's'} loaded.` : 'Add your RDP host to targets.json and restart the bridge. The local protocol lab is available without a server.';
    }
    catch (error) {
        if (requestId === generation)
            $('#form-message').textContent = `${error.message} Verify the gateway is running, its TLS certificate is trusted, this page's exact origin is allowed, and browser Local Network Access permission is granted. The gateway setup page includes a same-origin fallback.`;
    }
    finally {
        clearTimeout(timer);
        if (requestId === generation) control.disabled = false;
    }
};
function updateSecurity() {
    const target = targets.find(value => value.id === $('#target-id').value), option = $('#security option[value="tls"]');
    option.disabled = !target?.allowTlsOnly;
    if (option.disabled)
        $('#security').value = 'nla';
}
$('#target-id').onchange = updateSecurity;
form.onsubmit = event => {
    event.preventDefault();
    const profile = currentProfile();
    if (!loadedGateway || loadedGateway.origin !== gatewayEndpoint(gatewayInput.value).origin || !targets.some(target => target.id === profile.targetId)) {
        $('#form-message').textContent = 'Load and select an administrator-configured bridge target first.';
        return;
    }
    if ($('#bridge-token').value.length < 24) {
        $('#form-message').textContent = 'Bridge access token is required.';
        return;
    }
    if (profile.security === 'tls' && !targets.find(target => target.id === profile.targetId).allowTlsOnly) {
        $('#form-message').textContent = 'TLS-only authentication is not permitted for this target.';
        return;
    }
    openSession('remote', { ...profile, gatewayUrl: loadedGateway.websocket });
};
function startLab() { openSession('lab', sanitizeProfile({ name: 'Protocol Lab', width: 1280, height: 800, bpp: 24, backend: $('#backend').value, clipboard: true, richClipboard: $('#rich-clipboard').checked, resize: true })); }
$('#start-lab').onclick = startLab;
$('#lab-nav').onclick = startLab;
function newConnection() { showOverview(); form.reset(); gatewayInput.value = defaultGateway(location.href, document.documentElement.dataset.hosting === 'static'); clearGateway(); $('#profile-id').value = ''; $('#form-message').textContent = ''; $('#connection-name').focus(); }
for (const id of ['new-connection', 'tab-add'])
    $(`#${id}`).onclick = newConnection;
$('#home-nav').onclick = showOverview;
$('#overview-tab').onclick = showOverview;
$('.brand').onclick = event => { event.preventDefault(); showOverview(); };
$('#sidebar-toggle').onclick = () => $('#sidebar').classList.toggle('open');
$('#theme-toggle').onclick = () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try {
        localStorage.setItem('lrdp.theme', theme);
    }
    catch { }
};
try {
    document.documentElement.dataset.theme = localStorage.getItem('lrdp.theme') === 'light' ? 'light' : 'dark';
}
catch { }
for (const [selector, present, yes, no] of [['#cap-gpu', !!navigator.gpu, 'API exposed', 'Not exposed'], ['#cap-secure', isSecureContext, 'Secure', 'Unavailable'], ['#cap-clip', !!navigator.clipboard, 'Permission required', 'Not exposed'], ['#cap-worker', typeof Worker !== 'undefined', 'Available', 'Unavailable']]) {
    $(selector).textContent = present ? yes : no;
    $(selector).classList.toggle('off', !present);
}
$('#import-profile').onclick = () => $('#rdp-file').click();
$('#rdp-file').onchange = async (event) => {
    try {
        const file = event.target.files?.[0];
        if (!file)
            return;
        if (file.size > 131072)
            throw new Error('.rdp file is too large');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
        const imported = importRdp(new TextDecoder(encoding, { fatal: true }).decode(bytes));
        fillProfile(imported.profile);
        $('#form-message').textContent = `Imported metadata${imported.address ? ` for ${imported.address}` : ''}. Map this host to an allowlisted target. Credentials and unsupported settings were ignored.`;
    }
    catch (error) {
        toast(error.message);
    }
    finally {
        event.target.value = '';
    }
};
const exportButton = button('', { className: 'icon-button', symbol: 'download', title: 'Export current .rdp metadata without credentials or target DNS address' });
exportButton.onclick = () => { download('connection.rdp', exportRdp(currentProfile()), 'text/plain'); toast('Exported metadata. Add a full address before using this file in another RDP client.'); };
$('.side-section').append(exportButton);
window.addEventListener('beforeunload', event => {
    if ([...sessions.values()].some(session => session.mode === 'remote' && !['closed', 'failed'].includes(session.state))) {
        event.preventDefault();
        event.returnValue = '';
    }
});
renderProfiles();
showOverview();
