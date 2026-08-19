// 隔离世界 content script：
// 1. 把 figma-ws-hook.js 注入 MAIN world；
// 2. 页面捕获到 schema+数据帧后，把载荷转发给扩展后台“暂存”（不自动下载）；
// 3. 在 Figma 页面右上角展示「下载 Figma 帧」按钮，点击后才触发下载。
(() => {
  const HOOK_URL = chrome.runtime.getURL('figma-ws-hook.js');
  const BUTTON_ID = 'dsh-figma-ws-download';

  function injectHook() {
    const script = document.createElement('script');
    script.src = HOOK_URL;
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  let btn = null;
  function ensureButton() {
    if (btn && document.contains(btn)) return btn;
    btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.textContent = '⬇ 下载 Figma 帧';
    btn.setAttribute('aria-label', '下载已捕获的 Figma 帧');
    Object.assign(btn.style, {
      position: 'fixed',
      top: '16px',
      right: '16px',
      zIndex: '2147483647',
      background: '#1a73e8',
      color: '#ffffff',
      border: 'none',
      borderRadius: '6px',
      padding: '8px 14px',
      fontSize: '14px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
      display: 'none',
    });
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = '下载中…';
      try {
        chrome.runtime.sendMessage({ type: 'figma-ws-download' }, (resp) => {
          void chrome.runtime.lastError;
          if (resp && resp.ok) {
            btn.textContent = '已下载 ✓';
            setTimeout(() => { btn.style.display = 'none'; }, 2000);
          } else {
            btn.disabled = false;
            btn.textContent = '⬇ 下载 Figma 帧';
            btn.title = resp && resp.error ? resp.error : '下载失败';
            btn.textContent = '下载失败';
            setTimeout(() => { btn.textContent = '⬇ 下载 Figma 帧'; }, 2000);
          }
        });
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '⬇ 下载 Figma 帧';
      }
    });
    document.documentElement.appendChild(btn);
    return btn;
  }

  function ensureReady() {
    ensureButton();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureReady, { once: true });
  } else {
    ensureReady();
  }
  setTimeout(ensureReady, 2000);

  injectHook();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== 'figma-ws-silent' || !d.payload) return;
    try {
      chrome.runtime.sendMessage({ type: 'figma-ws-capture', payload: d.payload }, (resp) => {
        void chrome.runtime.lastError;
        if (resp && resp.ok) {
          ensureButton();
          btn.style.display = 'block';
          btn.disabled = false;
          btn.textContent = '⬇ 下载 Figma 帧';
        }
      });
    } catch (_) {}
  });
})();
