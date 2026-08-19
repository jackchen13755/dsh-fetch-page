// DSH 控制 popup：状态 / 启动进度条 / 控制按钮 / 错误日志
const $ = (id) => document.getElementById(id);

let pollTimer = null;
let busy = false;

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: '无响应' });
      }
    });
  });
}

// 后台 service worker 未就绪/旧版本时，sendMessage 会报端口关闭
function isPortClosed(err) {
  return /port closed|Receiving end does not exist|message port/i.test(String(err || ''));
}

function setPill(text, cls) {
  const el = $('statusPill');
  el.textContent = text;
  el.className = 'pill' + (cls ? ' ' + cls : '');
}

function setStatus(text, cls) {
  const el = $('statusText');
  el.textContent = text;
  el.className = 'status-text' + (cls ? ' ' + cls : '');
}

function setProgress(pct, state, label) {
  const bar = $('progressBar');
  const box = $('progress');
  bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  box.className = 'progress' + (state ? ' ' + state : '');
  $('progressLabel').textContent = label || '';
}

function setButtonsDisabled(disabled) {
  ['btnStart', 'btnRestart', 'btnStop', 'btnOpen'].forEach((id) => {
    $(id).disabled = disabled;
  });
}

function applyLifecycle(life) {
  if (!life || !life.ok) return;
  let state = life.state || (life.running ? 'running' : 'idle');
  // 守护进程重启后 lifecycle.state 可能停留在 idle，但服务实际在跑：以 running 为准
  if (state === 'idle' && life.running) state = 'running';
  // 操作进行中时，忽略还没开始更新的 idle 状态，避免进度条闪回“未运行”
  if (busy && state === 'idle') return;
  if (state === 'starting' || state === 'restarting' || state === 'stopping') {
    const pct =
      state === 'starting' ? (life.step === '等待端口' ? 65 : 25) :
      state === 'restarting' ? 30 : 55;
    const label = life.message || life.step || state;
    setProgress(pct, state, label);
    setStatus(label, 'busy');
    setPill(
      state === 'starting' ? '启动中' :
      state === 'restarting' ? '重启中' : '停止中',
      'busy'
    );
  } else if (state === 'running') {
    setProgress(100, 'done', 'DSH 运行中');
    setStatus('DSH 正在运行' + (life.pid ? ' · PID ' + life.pid : ''), 'ok');
    setPill('运行中', 'ok');
  } else if (state === 'failed') {
    setProgress(0, 'fail', life.message || '操作失败');
    setStatus(life.error || life.message || '操作失败', 'err');
    setPill('失败', 'err');
    if (life.error) showError(life.error, life.log);
  } else {
    setProgress(0, '', life.message || 'DSH 未运行');
    setStatus(life.message || 'DSH 未运行', '');
    setPill('未运行', '');
  }
}

async function refresh() {
  const [status, life] = await Promise.all([
    send({ type: 'getStatus' }),
    send({ type: 'getLifecycle' }),
  ]);

  if (status && status.ok && status.running) {
    // 服务确实在跑时优先显示“运行中”；只有正处于启动/重启/停止中才展示进度
    const lstate = life && life.ok ? life.state : null;
    if (lstate === 'starting' || lstate === 'restarting' || lstate === 'stopping') {
      applyLifecycle(life);
    } else {
      applyLifecycle({
        ok: true,
        state: 'running',
        running: true,
        pid: status.pid,
        message: (life && life.ok && life.message) ? life.message : 'DSH 正在运行',
      });
    }
  } else if (life && life.ok) {
    applyLifecycle(life);
  } else if (status && status.ok) {
    applyLifecycle({
      ok: true,
      state: status.running ? 'running' : 'idle',
      running: status.running,
      pid: status.pid,
      message: status.running ? 'DSH 正在运行' : 'DSH 未运行',
    });
  } else {
    setStatus('无法连接本地守护进程', 'err');
    setPill('离线', 'err');
    setProgress(0, 'fail', '请确认 dsh-relay-daemon 已启动');
    showError('无法连接守护进程 127.0.0.1:9317', (status && status.error) || '');
  }
}

function startPolling(ms) {
  stopPolling();
  pollTimer = setInterval(async () => {
    const life = await send({ type: 'getLifecycle' });
    if (life && life.ok) applyLifecycle(life);
  }, ms || 400);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function loadLogs(name, lines) {
  const r = await send({ type: 'getLogs', name: name || 'dsh', lines: lines || 300 });
  return (r && r.ok && r.log) ? r.log : '';
}

function showError(error, log) {
  $('logSection').classList.remove('hidden');
  $('btnToggleLog').textContent = '隐藏日志';
  const text =
    '错误：' + (error || '未知错误') + '\n\n' +
    '—— DSH 日志（末尾）——\n' +
    (log || '（暂无日志内容，可查看 /tmp/dsh-web-3080.log）');
  $('log').textContent = text;
}

function toggleLog() {
  const section = $('logSection');
  const hidden = section.classList.toggle('hidden');
  $('btnToggleLog').textContent = hidden ? '查看日志' : '隐藏日志';
  if (!hidden && !$('log').textContent) {
    loadLogs('dsh', 300).then((log) => {
      $('log').textContent = log || '（日志为空）';
    });
  }
}

async function doStart() {
  if (busy) return;
  busy = true;
  setButtonsDisabled(true);
  setProgress(10, 'starting', '正在启动 DSH…');
  setStatus('正在启动 DSH…', 'busy');
  setPill('启动中', 'busy');
  startPolling(400);

  const r = await send({ type: 'start' });
  stopPolling();
  busy = false;
  setButtonsDisabled(false);

  if (r && r.ok) {
    await send({ type: 'openPage' });
    setProgress(100, 'done', r.status === 'already-running' ? 'DSH 已在运行' : 'DSH 已启动');
    setStatus(
      (r.status === 'already-running' ? 'DSH 已在运行' : 'DSH 已启动') +
      (r.pid ? ' · PID ' + r.pid : ''),
      'ok'
    );
    setPill('运行中', 'ok');
    setTimeout(() => window.close(), 600);
  } else {
    const err = (r && r.error) || '未知错误';
    const log = (r && r.log) || await loadLogs('dsh', 200);
    setProgress(0, 'fail', '启动失败');
    setStatus('启动失败', 'err');
    setPill('失败', 'err');
    showError(err, log);
    startPolling(2000);
  }
}

async function doRestart() {
  if (busy) return;
  busy = true;
  setButtonsDisabled(true);
  setProgress(10, 'restarting', '正在重启 DSH…');
  setStatus('正在重启 DSH…', 'busy');
  setPill('重启中', 'busy');
  startPolling(400);

  const r = await send({ type: 'restart' });
  stopPolling();
  busy = false;
  setButtonsDisabled(false);

  if (r && r.ok) {
    await send({ type: 'openPage' });
    setProgress(100, 'done', 'DSH 已重启');
    setStatus('DSH 已重启' + (r.pid ? ' · PID ' + r.pid : ''), 'ok');
    setPill('运行中', 'ok');
    setTimeout(() => window.close(), 600);
  } else {
    const err = (r && r.error) || '未知错误';
    const log = (r && r.log) || await loadLogs('dsh', 200);
    setProgress(0, 'fail', '重启失败');
    setStatus('重启失败', 'err');
    setPill('失败', 'err');
    showError(err, log);
    startPolling(2000);
  }
}

async function doStop() {
  if (busy) return;
  busy = true;
  setButtonsDisabled(true);
  setProgress(50, 'stopping', '正在停止 DSH…');
  setStatus('正在停止 DSH…', 'busy');
  setPill('停止中', 'busy');
  startPolling(400);

  const r = await send({ type: 'stop' });
  stopPolling();
  busy = false;
  setButtonsDisabled(false);

  if (r && r.ok) {
    setProgress(0, '', 'DSH 已停止');
    setStatus('DSH 已停止', '');
    setPill('未运行', '');
  } else {
    const err = (r && r.error) || '未知错误';
    const log = (r && r.log) || await loadLogs('daemon', 100);
    setProgress(0, 'fail', '停止失败');
    setStatus('停止失败', 'err');
    setPill('失败', 'err');
    showError(err, log);
    startPolling(2000);
  }
}

// ── 版本检查 / 更新（从右键菜单迁移到 popup）────────────────────────────

let updateBusy = false;
let updateAvailable = false;
let updatePollTimer = null;

function formatVersion(v) {
  if (!v) return '—';
  if (v.packageVersion && v.shortCommit) return v.packageVersion + ' (' + v.shortCommit + ')';
  return v.packageVersion || v.shortCommit || v.commit || '—';
}

function setUpdateBusy(v) {
  updateBusy = v;
  $('btnCheckUpdate').disabled = v;
  $('btnUpdate').disabled = v || !updateAvailable;
}

function renderVersion(info) {
  if (!info || !info.ok) {
    const err = (info && info.error) || '';
    const msg = isPortClosed(err) ? '后台未响应，请先在 chrome://extensions 重新加载扩展' : err;
    $('versionCurrent').textContent = '当前版本：' + (err ? '读取失败' : '—');
    $('versionLatest').textContent = '最新版本：—';
    $('updateStatus').textContent = msg || '';
    $('updateStatus').className = 'version-status' + (err ? ' err' : '');
    updateAvailable = false;
    setUpdateBusy(updateBusy);
    return;
  }
  updateAvailable = !!info.hasUpdate;
  $('versionCurrent').textContent = '当前版本：' + formatVersion(info.current);
  $('versionLatest').textContent = '最新版本：' + formatVersion(info.latest);
  if (info.hasUpdate) {
    $('updateStatus').textContent = '发现新版本（落后 ' + (info.behind || '?') + ' 个提交）';
    $('updateStatus').className = 'version-status has-update';
  } else {
    $('updateStatus').textContent = '当前已是最新版本';
    $('updateStatus').className = 'version-status ok';
  }
  setUpdateBusy(updateBusy);
}

async function loadVersionInfo() {
  let info = await send({ type: 'getVersionInfo' });
  // service worker 冷启动时可能未就绪，端口关闭则稍等重试一次
  if (info && !info.ok && isPortClosed(info.error)) {
    await new Promise((r) => setTimeout(r, 600));
    info = await send({ type: 'getVersionInfo' });
  }
  renderVersion(info);
}

async function doCheckUpdate() {
  if (updateBusy) return;
  setUpdateBusy(true);
  $('updateStatus').textContent = '正在检查更新…';
  $('updateStatus').className = 'version-status busy';
  const info = await send({ type: 'checkUpdate' });
  setUpdateBusy(false);
  if (info && !info.ok && isPortClosed(info.error)) {
    $('updateStatus').textContent = '后台未响应，请先在 chrome://extensions 重新加载扩展';
    $('updateStatus').className = 'version-status err';
    updateAvailable = false;
    setUpdateBusy(false);
    return;
  }
  renderVersion(info);
}

async function pollUpdateStatus() {
  stopUpdatePolling();
  updatePollTimer = setInterval(async () => {
    const s = await send({ type: 'getUpdateStatus' });
    if (!s || !s.ok) {
      stopUpdatePolling();
      setUpdateBusy(false);
      $('updateStatus').textContent = (s && s.error) || '读取更新状态失败';
      $('updateStatus').className = 'version-status err';
      return;
    }
    if (s.state === 'completed') {
      stopUpdatePolling();
      setUpdateBusy(false);
      $('updateStatus').textContent = s.message || '更新完成';
      $('updateStatus').className = 'version-status ok';
      const info = await send({ type: 'getVersionInfo' });
      renderVersion(info);
    } else if (s.state === 'failed') {
      stopUpdatePolling();
      setUpdateBusy(false);
      $('updateStatus').textContent = s.error || s.message || '更新失败';
      $('updateStatus').className = 'version-status err';
    } else {
      $('updateStatus').textContent = s.message || s.step || '更新中…';
      $('updateStatus').className = 'version-status busy';
    }
  }, 1000);
}

function stopUpdatePolling() {
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

async function doStartUpdate() {
  if (updateBusy || !updateAvailable) return;
  if (!window.confirm('将停止 DSH、拉取最新版本并重新构建（本地插件/设置保留）。确定继续？')) return;
  setUpdateBusy(true);
  $('updateStatus').textContent = '正在提交更新任务…';
  $('updateStatus').className = 'version-status busy';
  const r = await send({ type: 'startUpdate' });
  if (r && r.ok) {
    pollUpdateStatus();
  } else {
    setUpdateBusy(false);
    const err = (r && r.error) || '更新启动失败';
    $('updateStatus').textContent = isPortClosed(err) ? '后台未响应，请先在 chrome://extensions 重新加载扩展' : err;
    $('updateStatus').className = 'version-status err';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('btnStart').addEventListener('click', doStart);
  $('btnRestart').addEventListener('click', doRestart);
  $('btnStop').addEventListener('click', doStop);
  $('btnOpen').addEventListener('click', () => send({ type: 'openPage' }));
  $('btnToggleLog').addEventListener('click', toggleLog);
  $('btnCheckUpdate').addEventListener('click', doCheckUpdate);
  $('btnUpdate').addEventListener('click', doStartUpdate);

  refresh();
  startPolling(2000);
  loadVersionInfo();
});

window.addEventListener('unload', () => {
  stopPolling();
  stopUpdatePolling();
});
