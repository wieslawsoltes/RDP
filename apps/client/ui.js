export function icon(name) { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); return svg; }
export function button(label, { className = 'secondary', symbol, title = label } = {}) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = className;
    item.title = title;
    item.setAttribute('aria-label', title);
    if (symbol)
        item.append(icon(symbol));
    if (label)
        item.append(document.createTextNode(label));
    return item;
}
export function download(name, contents, type = 'application/octet-stream') { const blob = contents instanceof Blob ? contents : new Blob([contents], { type }); const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
let toastTimer;
export function toast(message) { const item = document.querySelector('#toast'); item.textContent = message; item.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { item.hidden = true; }, 6000); }
export const formatBytes = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
export function element(tag, className, text) {
    const value = document.createElement(tag);
    if (className)
        value.className = className;
    if (text !== undefined)
        value.textContent = text;
    return value;
}
