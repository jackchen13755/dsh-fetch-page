const BASE = 'http://127.0.0.1:9317';

async function forwardFetch(req) {
  try {
    const method = String(req.method || 'GET').toUpperCase();
    const init = { method: method, headers: req.headers || {}, credentials: 'include' };
    if (req.body && method !== 'GET' && method !== 'HEAD') init.body = req.body;
    const r = await fetch(req.url, init);
    const text = await r.text();
    const headers = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    return { id: req.id, ok: true, status: r.status, statusText: r.statusText, headers: headers, body: text };
  } catch (e) {
    return { id: req.id, ok: false, error: String(e && e.message || e) };
  }
}

async function pollOnce() {
  let resp;
  try {
    resp = await fetch(BASE + '/pending', { signal: AbortSignal.timeout(30000) });
  } catch (e) { return; }
  let req = null;
  try { req = await resp.json(); } catch (e) { return; }
  if (!req || !req.id) return;
  const result = await forwardFetch(req);
  try {
    await fetch(BASE + '/result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    });
  } catch (e) {}
}

let running = false;
async function loop() { while (true) { await pollOnce(); } }
function start() { if (running) return; running = true; loop(); }
start();
chrome.alarms.create('forward-loop', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'forward-loop') start(); });
