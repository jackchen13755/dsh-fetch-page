const HOST = 'com.dsh.control';
const URL = 'http://127.0.0.1:3080';
const statusEl = document.getElementById('status');
const buttonsEl = document.getElementById('buttons');
const restartBtn = document.getElementById('restart');
const stopBtn = document.getElementById('stop');

function sendNative(action) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST, { action }, (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: false, error: '无响应' });
      }
    });
  });
}

function openPage() { chrome.tabs.create({ url: URL }); }

async function init() {
  const s = await sendNative('status');
  if (!s.ok) { statusEl.textContent = '错误: ' + (s.error || '未知'); return; }
  if (s.running) {
    statusEl.textContent = '运行中 · PID ' + (s.pid || '?');
    buttonsEl.hidden = false;
  } else {
    statusEl.textContent = '启动中…';
    const r = await sendNative('start');
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
  const r = await sendNative('restart');
  if (r.ok) { statusEl.textContent = '已重启'; openPage(); }
  else { statusEl.textContent = '失败: ' + (r.error || '未知'); }
};

stopBtn.onclick = async () => {
  statusEl.textContent = '停止中…';
  const r = await sendNative('stop');
  statusEl.textContent = r.ok ? '已停止' : ('失败: ' + (r.error || '未知'));
};

init();
