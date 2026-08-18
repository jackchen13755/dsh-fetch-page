// MAIN world hook：静默捕获 Figma 编辑器 WS 的 Kiwi 二进制帧。
// 只保留两份：schema 帧（fig-wire 头）与最大的数据帧，通过 postMessage 交给
// 隔离世界 content script 转发给扩展后台。同时在 window.__figmaWsSilentState
// 暴露状态，便于无扩展环境（CDP）下验证。
(() => {
  if (window.__figmaWsSilent) return;
  const state = { schema: null, data: null, sent: false, hookUrl: location.href };
  window.__figmaWsSilent = true;
  window.__figmaWsSilentState = state;

  const CHUNK = 0x8000;
  const b64FromBuffer = (buf) => {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  };

  const post = () => {
    if (!state.schema || !state.data || state.sent) return;
    state.sent = true;
    try {
      window.postMessage(
        {
          source: 'figma-ws-silent',
          payload: {
            schema: state.schema,
            data: state.data,
            url: location.href,
            title: document.title,
            ts: Date.now(),
          },
        },
        '*',
      );
    } catch (_) {}
  };

  const consider = (type, url, data) => {
    if (type !== 'recv' || !data || data.k !== 'b64') return;
    const b64 = data.v;
    let head = '';
    try {
      head = atob(b64).slice(0, 8);
    } catch (_) {}
    if (head === 'fig-wire') {
      if (!state.schema || data.size > state.schema.size) {
        state.schema = { size: data.size, b64, url, ts: Date.now() };
        state.sent = false;
      }
    } else if (!state.data || data.size > state.data.size) {
      state.data = { size: data.size, b64, url, ts: Date.now() };
      state.sent = false;
    }
    post();
  };

  const OrigWS = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new OrigWS(...args);
    const url = String(args[0]);
    const origSend = ws.send.bind(ws);
    ws.send = function (data) {
      let desc;
      try {
        if (typeof data === 'string') desc = { k: 'str', v: data };
        else if (data instanceof ArrayBuffer) desc = { k: 'b64', size: data.byteLength, v: b64FromBuffer(data) };
        else if (ArrayBuffer.isView(data)) {
          desc = {
            k: 'b64',
            size: data.byteLength,
            v: b64FromBuffer(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
          };
        } else desc = { k: 'other', v: String(data) };
      } catch (e) {
        desc = { k: 'err', v: e.message };
      }
      try {
        consider('send', url, desc);
      } catch (_) {}
      return origSend(data);
    };
    ws.addEventListener('message', (e) => {
      let desc;
      try {
        if (typeof e.data === 'string') desc = { k: 'str', v: e.data };
        else if (e.data instanceof Blob) {
          e.data
            .arrayBuffer()
            .then((buf) => {
              try {
                consider('recv', url, { k: 'b64', size: buf.byteLength, v: b64FromBuffer(buf) });
              } catch (_) {}
            })
            .catch(() => {});
          desc = { k: 'blob-async', size: e.data.size };
        } else if (e.data instanceof ArrayBuffer) {
          desc = { k: 'b64', size: e.data.byteLength, v: b64FromBuffer(e.data) };
        } else if (ArrayBuffer.isView(e.data)) {
          desc = {
            k: 'b64',
            size: e.data.byteLength,
            v: b64FromBuffer(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength)),
          };
        } else desc = { k: 'other', v: String(e.data) };
      } catch (e) {
        desc = { k: 'err', v: e.message };
      }
      if (desc.k !== 'blob-async') {
        try {
          consider('recv', url, desc);
        } catch (_) {}
      }
    });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
})();
