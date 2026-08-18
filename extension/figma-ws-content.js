// 隔离世界 content script：把 figma-ws-hook.js 注入 MAIN world，并把页面里的
// figma-ws-silent postMessage 转发给扩展后台。
(() => {
  const HOOK_URL = chrome.runtime.getURL('figma-ws-hook.js');

  function injectHook() {
    const script = document.createElement('script');
    script.src = HOOK_URL;
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  injectHook();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.source !== 'figma-ws-silent' || !d.payload) return;
    try {
      chrome.runtime.sendMessage({ type: 'figma-ws-capture', payload: d.payload }, () => {
        // 忽略错误；捕获失败下次刷新会重试
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  });
})();
