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

// ── SPA 渲染抓取（真实标签页执行 JS，再注入 Readability 提取）──────────────

function looksLikeSpaShell(html, contentType) {
  if (!html) return false;
  const ct = String(contentType || '').toLowerCase();
  // 非 HTML 内容（JSON/JS/XML/媒体/纯文本）不升级渲染
  if (/(json|javascript|xml|image|font|audio|video|text\/plain)/.test(ct)) return false;
  // 没有 HTML 骨架或没有 script 的响应，不当作 SPA 空壳
  if (!/<(html|body|div|script)\b/i.test(html)) return false;
  if (!/<script\b/i.test(html)) return false;
  const stripped = String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length < 300;
}

async function forwardRender(req) {
  const opts = {
    timeout: Math.min(Math.max(Number(req.timeout) || 45, 5), 120),
    waitForSelector: String(req.wait_for_selector || ''),
    targetSelector: String(req.target_selector || ''),
    scroll: Math.min(Math.max(Number(req.scroll) || 0, 0), 20),
    format: String(req.format || 'markdown'),
  };
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: req.url, active: false });
    const tabId = tab && tab.id;
    if (tabId == null) return { id: req.id, ok: false, error: 'render: 无法创建渲染标签页' };

    // 等标签页 load 完成
    const deadline = Date.now() + opts.timeout * 1000;
    let loaded = false;
    while (Date.now() < deadline) {
      let t = null;
      try { t = await chrome.tabs.get(tabId); } catch (e) { break; }
      if (t && t.status === 'complete') { loaded = true; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!loaded) return { id: req.id, ok: false, error: 'render: 页面加载超时（' + opts.timeout + 's）' };

    // 注入提取脚本（Readability + Turndown + 提取器，同一 isolated world）
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['reader/Readability.js', 'reader/turndown.js', 'reader/content-extract.js'],
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function (o) {
        return window.__dshExtractPage ? window.__dshExtractPage(o) : Promise.resolve({ error: 'reader 脚本未安装' });
      },
      args: [opts],
    });
    const ex = results && results[0] && results[0].result;
    if (!ex) return { id: req.id, ok: false, error: 'render: 提取脚本无返回' };
    if (ex.error) return { id: req.id, ok: false, error: ex.error };
    if (!ex.text && !ex.markdown && !ex.html) {
      return { id: req.id, ok: false, error: 'render: 页面无可提取文本（可能是空白页或反爬验证页）' };
    }

    let body = '';
    if (opts.format === 'html') body = ex.html || '';
    else if (opts.format === 'text') body = ex.text || ex.markdown || '';
    else body = ex.markdown || ex.text || '';

    return {
      id: req.id,
      ok: true,
      status: 200,
      statusText: 'rendered',
      headers: { 'content-type': opts.format === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' },
      body: body,
      extra: {
        rendered: true,
        mode: 'render',
        title: ex.title || '',
        byline: ex.byline || '',
        excerpt: ex.excerpt || '',
        text: ex.text || '',
        markdown: opts.format === 'markdown' ? body : (ex.markdown || ''),
        url: ex.finalUrl || ex.url || req.url,
        htmlLength: ex.html ? ex.html.length : (ex.text ? ex.text.length : 0),
      },
    };
  } catch (e) {
    return { id: req.id, ok: false, error: 'render: ' + String((e && e.message) || e) };
  } finally {
    if (tab && tab.id != null) {
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
    }
  }
}

async function handleRequest(req) {
  const mode = String(req.mode || 'auto');
  const method = String(req.method || 'GET').toUpperCase();
  // POST 等无法用标签页渲染（浏览器导航只支持 GET），退回纯 fetch
  if (method !== 'GET') return forwardFetch(req);
  if (mode === 'render') return forwardRender(req);
  if (mode === 'fetch') return forwardFetch(req);
  // auto：先轻量 fetch，命中 SPA 空壳再升级渲染
  const r = await forwardFetch(req);
  if (r && r.ok && looksLikeSpaShell(r.body, r.headers && r.headers['content-type'])) return forwardRender(req);
  return r;
}

async function pollOnce() {
  let resp;
  try {
    resp = await fetch(BASE + '/pending', { signal: AbortSignal.timeout(30000) });
  } catch (e) { return; }
  let req = null;
  try { req = await resp.json(); } catch (e) { return; }
  if (!req || !req.id) return;
  const result = await handleRequest(req);
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

async function getLifecycle() {
  try {
    const r = await fetch(BASE + '/lifecycle', { signal: AbortSignal.timeout(5000) });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

async function getLogs(name, lines) {
  try {
    const q = new URLSearchParams({ name: name || 'dsh', lines: String(lines || 300) });
    const r = await fetch(BASE + '/logs?' + q.toString(), { signal: AbortSignal.timeout(5000) });
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
      iconUrl: chrome.runtime.getURL(ok === false ? 'icon-stopped.png' : 'icon-running-blue.png'),
      title: title,
      message: message,
    });
  } catch (e) {}
}

// 根据 DSH 是否在运行切换图标颜色（绿=运行，灰=停止）
async function updateIcon() {
  try {
    const s = await ctl('status');
    const path = (s.ok && s.running) ? 'icon-running-blue.png' : 'icon-stopped.png';
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

// 已有 DSH 页面则定位（激活并聚焦）该标签页并刷新，否则新建标签页。
function openPage() {
  chrome.tabs.query({}, (tabs) => {
    const found = tabs.find((t) => t.url && t.url.startsWith(DSH_URL));
    if (found) {
      chrome.tabs.update(found.id, { active: true });
      chrome.windows.update(found.windowId, { focused: true });
      try { chrome.tabs.reload(found.id); } catch (e) {}
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

// ── Popup 消息（状态 / 生命周期 / 控制 / 日志）──────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  const types = ['getStatus', 'getLifecycle', 'start', 'stop', 'restart', 'openPage', 'getLogs', 'getVersionInfo', 'checkUpdate', 'checkUpdateSilent', 'startUpdate', 'getUpdateStatus'];
  if (!types.includes(msg.type)) return false;
  const run = async () => {
    switch (msg.type) {
      case 'getStatus': return ctl('status');
      case 'getLifecycle': return getLifecycle();
      case 'start': { const r = await ctl('start'); updateIcon(); return r; }
      case 'stop': { const r = await ctl('stop'); updateIcon(); return r; }
      case 'restart': { const r = await ctl('restart'); updateIcon(); return r; }
      case 'openPage': openPage(); return { ok: true };
      case 'getLogs': return getLogs(msg.name, msg.lines);
      case 'getVersionInfo': return versionInfo || { ok: false, error: '尚未检查更新' };
      case 'checkUpdate': return checkForUpdates(true);
      case 'checkUpdateSilent': return checkForUpdates(false);
      case 'startUpdate': return startUpdate();
      case 'getUpdateStatus': return getUpdateStatus();
    }
  };
  run().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

// ── DSH 版本检查 / 更新 ──────────────────────────────────────────────────

function formatVersion(v) {
  if (!v) return '未知';
  if (v.packageVersion && v.shortCommit) return v.packageVersion + ' (' + v.shortCommit + ')';
  return v.packageVersion || v.shortCommit || v.commit || '未知';
}

// 版本检查结果缓存（popup 经 getVersionInfo 读取）。
let versionInfo = null;

// 重建右键菜单：版本检查/更新已迁移到 popup，这里只保留重启/停止。
function rebuildContextMenus() {
  chrome.contextMenus.removeAll(() => {
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
    const failed = { ok: false, error: '无法连接本地守护进程' };
    versionInfo = failed;
    if (manual) notify('检查失败', failed.error, false);
    return failed;
  }
  if (!info || !info.ok) {
    const failed = { ok: false, error: (info && info.error) || '未知错误' };
    versionInfo = failed;
    if (manual) notify('检查失败', failed.error, false);
    return failed;
  }

  versionInfo = info;
  const currentLabel = formatVersion(info.current);
  const latestLabel = formatVersion(info.latest);
  chrome.action.setTitle({
    title: 'DSH 控制\n当前版本: ' + currentLabel + (info.hasUpdate ? '\n有新版本: ' + latestLabel : ''),
  });

  if (info.hasUpdate) {
    const key = (info.latest && (info.latest.commit || info.latest.packageVersion)) || 'update';
    chrome.storage.local.get({ notifiedUpdateKey: '' }, (data) => {
      if (data.notifiedUpdateKey === key) return;
      chrome.notifications.create(UPDATE_NOTIFICATION_ID, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon-running-blue.png'),
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
  return info;
}

async function getUpdateStatus() {
  try {
    const r = await fetch(BASE + '/update-status', { signal: AbortSignal.timeout(10000) });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

async function startUpdate() {
  let r;
  try {
    r = await (await fetch(BASE + '/update', { method: 'POST', signal: AbortSignal.timeout(10000) })).json();
  } catch (e) {
    const failed = { ok: false, error: '无法连接本地守护进程' };
    notify('更新失败', failed.error, false);
    return failed;
  }
  if (!r || !r.ok || !r.started) {
    const failed = { ok: false, error: (r && r.error) || '未知错误' };
    notify('更新失败', failed.error, false);
    return failed;
  }
  notify('开始更新', '正在拉取最新 DSH 并重新构建，本地插件/设置会保留。', true);
  chrome.alarms.create(UPDATE_POLL_ALARM, { periodInMinutes: POLL_INTERVAL_MINUTES });
  pollUpdateStatus();
  return { ok: true, started: true };
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

// 首次加载先建菜单（重启/停止），随后立即检查一次版本供 popup 显示。
rebuildContextMenus();
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

// 右键菜单：重启 / 停止（版本检查与更新已迁移到 popup）
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId === 'dsh-restart') {
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

const STORE = chrome.storage.session || chrome.storage.local;

/** 捕获到帧：只存内存/会话存储 + 徽标提示，不自动下载。 */
async function storeFigmaCapture(payload) {
  await STORE.set({ figmaWsPending: payload });
  try { await chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' }); } catch (_) {}
  try { await chrome.action.setBadgeText({ text: '1' }); } catch (_) {}
  return { stored: true };
}

async function getPendingFigmaCapture() {
  const s = await STORE.get('figmaWsPending');
  return s.figmaWsPending || null;
}

async function clearPendingFigmaCapture() {
  await STORE.remove('figmaWsPending');
  try { await chrome.action.setBadgeText({ text: '' }); } catch (_) {}
}

/** 点击下载按钮时才真正写入 ~/Downloads/figma_ws/。 */
async function downloadFigmaCapture(payload) {
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
      conflictAction: 'overwrite',
    }));
  }
  tasks.push(chrome.downloads.download({
    url: b64ToDataUrl(payload.data.b64),
    filename: `${FIGMA_WS_PREFIX}/${manifest.dataFile}`,
    saveAs: false,
    conflictAction: 'overwrite',
  }));
  tasks.push(chrome.downloads.download({
    url: `data:application/json;base64,${utf8ToB64(JSON.stringify(manifest, null, 2))}`,
    filename: `${FIGMA_WS_PREFIX}/last_capture.json`,
    saveAs: false,
    conflictAction: 'overwrite',
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
    storeFigmaCapture(msg.payload)
      .then(() => sendResponse({ ok: true, stored: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true; // 异步响应
  }
  if (msg && msg.type === 'figma-ws-download') {
    getPendingFigmaCapture()
      .then(async (payload) => {
        if (!payload) throw new Error('暂无待下载的 Figma 帧（先打开 Figma 页面等待捕获）');
        const manifest = await downloadFigmaCapture(payload);
        await clearPendingFigmaCapture();
        flashBadge(true);
        sendResponse({ ok: true, manifest });
      })
      .catch((e) => {
        flashBadge(false);
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      });
    return true; // 异步响应
  }
  return false;
});
