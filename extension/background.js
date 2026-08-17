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

// 系统通知 + 图标角标反馈
function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon.png'),
      title: title,
      message: message,
    });
  } catch (e) {}
}

function flashBadge(ok) {
  try {
    chrome.action.setBadgeBackgroundColor({ color: ok ? '#188038' : '#d93025' });
    chrome.action.setBadgeText({ text: ok ? '成功' : '失败' });
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  } catch (e) {}
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
  else { notify('启动失败', r.error || '未知错误'); flashBadge(false); }
});

// 右键图标：重启 / 停止（幂等重建，兼容 service worker 重启）。
chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({ id: 'dsh-restart', title: '重启 DSH', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'dsh-stop', title: '停止 DSH', contexts: ['action'] });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'dsh-restart') {
    const r = await ctl('restart');
    if (r.ok) {
      notify('重启成功', 'DSH 已重启' + (r.pid ? ' · PID ' + r.pid : ''));
      flashBadge(true);
      openPage();
    } else {
      notify('重启失败', r.error || '未知错误');
      flashBadge(false);
    }
  } else if (info.menuItemId === 'dsh-stop') {
    const r = await ctl('stop');
    if (r.ok) { notify('已停止', 'DSH 已停止'); flashBadge(true); }
    else { notify('停止失败', r.error || '未知错误'); flashBadge(false); }
  }
});
