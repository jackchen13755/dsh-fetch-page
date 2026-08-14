const BASE = 'http://127.0.0.1:9317';
const DSH_URL = 'http://127.0.0.1:3080';

// ── 请求转发（浏览器带 Cookie 抓取）──────────────────────────────────────

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

// ── 启动时确保守护进程运行：经 native messaging 唤起 host 的 ensureDaemon ──
// 扩展加载/唤醒时轻量唤起一次；daemon 已在运行则 no-op。host 缺失或未注册时
// 静默降级，daemon 仍由 launchd / fetch_page 的 ensureDaemon 兜底启动。
try {
  chrome.runtime.sendNativeMessage('com.dsh.control', { action: 'status' }, () => {
    void chrome.runtime.lastError;
  });
} catch (e) {}

chrome.alarms.create('forward-loop', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'forward-loop') start(); });

// ── DSH 生命周期控制 ─────────────────────────────────────────────────────

async function ctl(action) {
  try {
    const r = await fetch(BASE + '/' + action, { method: action === 'status' ? 'GET' : 'POST' });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// 已有 DSH 页面则定位（激活并聚焦）该标签页，否则新建标签页。
function openPage() {
  chrome.tabs.query({}, (tabs) => {
    const found = tabs.find((t) => t.url && t.url.startsWith(DSH_URL));
    if (found) {
      chrome.tabs.update(found.id, { active: true });
      chrome.windows.update(found.windowId, { focused: true });
    } else {
      chrome.tabs.create({ url: DSH_URL });
    }
  });
}

// 左键点击图标：已启动 → 直接打开页面；未启动 → 启动后打开。
chrome.action.onClicked.addListener(async () => {
  const s = await ctl('status');
  if (s.ok && s.running) {
    openPage();
    return;
  }
  const r = await ctl('start');
  if (r.ok) openPage();
});

// 右键图标：重启 / 停止（幂等重建，兼容 service worker 重启）。
chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({ id: 'dsh-restart', title: '重启 DSH', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'dsh-stop', title: '停止 DSH', contexts: ['action'] });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'dsh-restart') {
    const r = await ctl('restart');
    if (r.ok) openPage();
  } else if (info.menuItemId === 'dsh-stop') {
    await ctl('stop');
  }
});
