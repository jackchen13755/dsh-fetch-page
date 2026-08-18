const BASE = 'http://127.0.0.1:9317';
const DSH_URL = 'http://127.0.0.1:3080';

const VERSION_ALARM = 'dsh-version-check';
const UPDATE_POLL_ALARM = 'dsh-update-poll';
const UPDATE_NOTIFICATION_ID = 'dsh-update';
const CHECK_INTERVAL_MINUTES = 6 * 60;
const POLL_INTERVAL_MINUTES = 0.5;

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
chrome.alarms.create(VERSION_ALARM, { periodInMinutes: CHECK_INTERVAL_MINUTES });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'forward-loop') { start(); updateIcon(); }
  else if (a.name === VERSION_ALARM) { checkForUpdates(false); }
  else if (a.name === UPDATE_POLL_ALARM) { pollUpdateStatus(); }
});
updateIcon();

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
function notify(title, message, ok) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL(ok === false ? 'icon-stopped.png' : 'icon-running.png'),
      title: title,
      message: message,
    });
  } catch (e) {}
}

// 根据 DSH 是否在运行切换图标颜色（绿=运行，灰=停止）
async function updateIcon() {
  try {
    const s = await ctl('status');
    const path = (s.ok && s.running) ? 'icon-running.png' : 'icon-stopped.png';
    chrome.action.setIcon({ path: { 128: path } });
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
  else { notify('启动失败', r.error || '未知错误', false); flashBadge(false); }
  updateIcon();
});

// ── DSH 版本检查 / 更新 ──────────────────────────────────────────────────

function formatVersion(v) {
  if (!v) return '未知';
  if (v.packageVersion && v.shortCommit) return v.packageVersion + ' (' + v.shortCommit + ')';
  return v.packageVersion || v.shortCommit || v.commit || '未知';
}

// 重建右键菜单：第一项固定展示当前版本；有更新时“下载并重建”才可点。
function rebuildContextMenus(info) {
  const hasUpdate = !!(info && info.hasUpdate);
  const currentLabel = formatVersion(info && info.current);
  const latestLabel = formatVersion(info && info.latest);
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'dsh-version',
      title: '当前 DSH 版本: ' + currentLabel,
      contexts: ['action'],
      enabled: false,
    });
    chrome.contextMenus.create({ id: 'dsh-check-update', title: '检查 DSH 更新', contexts: ['action'] });
    chrome.contextMenus.create({
      id: 'dsh-update',
      title: hasUpdate ? '下载并重建 DSH (' + latestLabel + ')' : '下载并重建 DSH',
      contexts: ['action'],
      enabled: hasUpdate,
    });
    chrome.contextMenus.create({ id: 'dsh-sep', type: 'separator', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'dsh-restart', title: '重启 DSH', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'dsh-stop', title: '停止 DSH', contexts: ['action'] });
  });
}

async function checkForUpdates(manual) {
  let info;
  try {
    const r = await fetch(BASE + '/update-check', { signal: AbortSignal.timeout(120000) });
    info = await r.json();
  } catch (e) {
    if (manual) notify('检查失败', '无法连接本地守护进程', false);
    return;
  }
  if (!info || !info.ok) {
    if (manual) notify('检查失败', (info && info.error) || '未知错误', false);
    return;
  }

  const currentLabel = formatVersion(info.current);
  const latestLabel = formatVersion(info.latest);
  chrome.action.setTitle({
    title: 'DSH 控制\n当前版本: ' + currentLabel + (info.hasUpdate ? '\n有新版本: ' + latestLabel : ''),
  });
  rebuildContextMenus(info);

  if (info.hasUpdate) {
    const key = (info.latest && (info.latest.commit || info.latest.packageVersion)) || 'update';
    chrome.storage.local.get({ notifiedUpdateKey: '' }, (data) => {
      if (data.notifiedUpdateKey === key) return;
      chrome.notifications.create(UPDATE_NOTIFICATION_ID, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon-running.png'),
        title: 'DSH 有新版本',
        message: '当前 ' + currentLabel + ' → 最新 ' + latestLabel +
          '（落后 ' + (info.behind || '?') + ' 个提交）\n点击“下载并重建”，本地插件/设置不会被覆盖。',
        priority: 2,
        requireInteraction: true,
        buttons: [{ title: '下载并重建' }, { title: '稍后' }],
      });
      chrome.storage.local.set({ notifiedUpdateKey: key });
    });
    try {
      chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
      chrome.action.setBadgeText({ text: '新' });
    } catch (e) {}
  } else {
    try { chrome.action.setBadgeText({ text: '' }); } catch (e) {}
  }

  if (manual) {
    notify('版本检查完成', info.hasUpdate ? '发现新版本 ' + latestLabel : '当前已是最新版本 ' + currentLabel, true);
  }
}

async function startUpdate() {
  let r;
  try {
    r = await (await fetch(BASE + '/update', { method: 'POST', signal: AbortSignal.timeout(10000) })).json();
  } catch (e) {
    notify('更新失败', '无法连接本地守护进程', false);
    return;
  }
  if (!r || !r.ok || !r.started) {
    notify('更新失败', (r && r.error) || '未知错误', false);
    return;
  }
  notify('开始更新', '正在拉取最新 DSH 并重新构建，本地插件/设置会保留。', true);
  chrome.alarms.create(UPDATE_POLL_ALARM, { periodInMinutes: POLL_INTERVAL_MINUTES });
  pollUpdateStatus();
}

async function pollUpdateStatus() {
  let s;
  try {
    s = await (await fetch(BASE + '/update-status', { signal: AbortSignal.timeout(10000) })).json();
  } catch (e) { return; }
  if (!s || (s.state !== 'completed' && s.state !== 'failed')) return;
  chrome.alarms.clear(UPDATE_POLL_ALARM);
  if (s.state === 'completed') {
    notify('DSH 更新完成', s.message || '更新完成，本地插件/设置已保留', true);
  } else {
    notify('DSH 更新失败', s.error || s.message || '更新失败', false);
  }
  checkForUpdates(false);
  updateIcon();
}

// 首次加载先建菜单（版本未知），随后立即检查一次版本。
rebuildContextMenus(null);
checkForUpdates(false);

// 通知按钮：点击“下载并重建”触发更新；“稍后”只关闭。
chrome.notifications.onButtonClicked.addListener((id, btnIndex) => {
  if (id !== UPDATE_NOTIFICATION_ID) return;
  chrome.notifications.clear(id);
  if (btnIndex === 0) startUpdate();
});
chrome.notifications.onClicked.addListener((id) => {
  if (id !== UPDATE_NOTIFICATION_ID) return;
  chrome.notifications.clear(id);
  startUpdate();
});

// 右键菜单：版本检查 / 更新 / 重启 / 停止
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'dsh-check-update') {
    checkForUpdates(true);
  } else if (info.menuItemId === 'dsh-update') {
    startUpdate();
  } else if (info.menuItemId === 'dsh-restart') {
    const r = await ctl('restart');
    if (r.ok) {
      notify('重启成功', 'DSH 已重启' + (r.pid ? ' · PID ' + r.pid : ''));
      flashBadge(true);
      openPage();
    } else {
      notify('重启失败', r.error || '未知错误', false);
      flashBadge(false);
    }
    updateIcon();
  } else if (info.menuItemId === 'dsh-stop') {
    const r = await ctl('stop');
    if (r.ok) { notify('已停止', 'DSH 已停止'); flashBadge(true); }
    else { notify('停止失败', r.error || '未知错误', false); flashBadge(false); }
    updateIcon();
  }
});

// ── Figma WS 静默捕获（Kiwi 帧 → ~/Downloads/figma_ws）──────────────────

const FIGMA_WS_PREFIX = 'figma_ws';

function b64ToDataUrl(b64) { return `data:application/octet-stream;base64,${b64}`; }
function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

async function saveFigmaCapture(payload) {
  const ts = payload.ts || Date.now();
  const manifest = {
    ts,
    url: payload.url || '',
    title: payload.title || '',
    schemaFile: payload.schema ? `frame_0000_recv_${payload.schema.size}b.bin` : null,
    schemaSize: payload.schema ? payload.schema.size : 0,
    dataFile: `frame_0001_recv_${payload.data.size}b.bin`,
    dataSize: payload.data.size,
  };
  const tasks = [];
  if (payload.schema) {
    tasks.push(chrome.downloads.download({
      url: b64ToDataUrl(payload.schema.b64),
      filename: `${FIGMA_WS_PREFIX}/${manifest.schemaFile}`,
      saveAs: false,
    }));
  }
  tasks.push(chrome.downloads.download({
    url: b64ToDataUrl(payload.data.b64),
    filename: `${FIGMA_WS_PREFIX}/${manifest.dataFile}`,
    saveAs: false,
  }));
  tasks.push(chrome.downloads.download({
    url: `data:application/json;base64,${utf8ToB64(JSON.stringify(manifest, null, 2))}`,
    filename: `${FIGMA_WS_PREFIX}/last_capture.json`,
    saveAs: false,
  }));
  const results = await Promise.allSettled(tasks);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length) {
    throw new Error(`保存失败 ${failed.length}/${results.length}: ${failed[0].reason?.message || failed[0].reason}`);
  }
  try { await chrome.storage.local.set({ lastFigmaCapture: manifest }); } catch (_) {}
  return manifest;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'figma-ws-capture' && msg.payload && msg.payload.data) {
    saveFigmaCapture(msg.payload)
      .then(() => { flashBadge(true); sendResponse({ ok: true }); })
      .catch((e) => {
        flashBadge(false);
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      });
    return true; // 异步响应
  }
  return false;
});
