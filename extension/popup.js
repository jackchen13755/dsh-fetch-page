const BASE = 'http://127.0.0.1:9317';
const URL = 'http://127.0.0.1:3080';
const statusEl = document.getElementById('status');
const buttonsEl = document.getElementById('buttons');
const restartBtn = document.getElementById('restart');
const stopBtn = document.getElementById('stop');

async function ctl(action) {
  try {
    const r = await fetch(BASE + '/' + action, { method: action === 'status' ? 'GET' : 'POST' });
    return await r.json();
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

function openPage() { chrome.tabs.create({ url: URL }); }

async function init() {
  const s = await ctl('status');
  if (!s.ok) { statusEl.textContent = '错误: ' + (s.error || '未知'); return; }
  if (s.running) {
    statusEl.textContent = '运行中 · PID ' + (s.pid || '?');
    buttonsEl.hidden = false;
  } else {
    statusEl.textContent = '启动中…';
    const r = await ctl('start');
    if (r.ok) {
      statusEl.textContent = '已启动';
      openPage();
      window.close();
    } else {
      statusEl.textContent = '启动失败: ' + (r.error || '未知');
    }
  }
}

restartBtn.onclick = async () => {
  statusEl.textContent = '重启中…';
  const r = await ctl('restart');
  if (r.ok) { statusEl.textContent = '已重启'; openPage(); }
  else { statusEl.textContent = '失败: ' + (r.error || '未知'); }
};

stopBtn.onclick = async () => {
  statusEl.textContent = '停止中…';
  const r = await ctl('stop');
  statusEl.textContent = r.ok ? '已停止' : ('失败: ' + (r.error || '未知'));
};

init();
