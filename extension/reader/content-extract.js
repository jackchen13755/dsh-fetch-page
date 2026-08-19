/**
 * DSH 页面提取脚本（isolated world）。
 * 由 background.js 通过 chrome.scripting.executeScript 注入到「渲染模式」打开的标签页中，
 * 负责：等待 SPA 渲染稳定 → 可选滚动加载 → 用 Readability + Turndown 提取正文。
 * 期望先注入 reader/Readability.js 与 reader/turndown.js（同 isolated world）。
 */
(function () {
  'use strict';

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function makeTurndown() {
    try {
      if (typeof window.TurndownService === 'function') {
        return new window.TurndownService({
          headingStyle: 'atx',
          codeBlockStyle: 'fenced',
          bulletListMarker: '-',
          emDelimiter: '*',
        });
      }
    } catch (e) {}
    return null;
  }

  /** 等待 selector 出现。 */
  async function waitForSelector(selector, deadline) {
    while (Date.now() < deadline) {
      let el = null;
      try { el = document.querySelector(selector); } catch (e) { return false; }
      if (el) return true;
      await sleep(200);
    }
    try { return !!document.querySelector(selector); } catch (e) { return false; }
  }

  /** 等待 DOM 稳定（正文长度连续 400ms 不变，且至少观察 800ms）。 */
  async function waitForMutationIdle(deadline) {
    const minWaitMs = Math.min(1200, Math.max(400, (deadline - Date.now()) / 2));
    const startedAt = Date.now();
    let lastLen = -1;
    let quietMs = 0;
    while (Date.now() < deadline) {
      let len = 0;
      try { len = document.body ? String(document.body.innerText || '').length : 0; } catch (e) {}
      if (len === lastLen) {
        quietMs += 200;
      } else {
        lastLen = len;
        quietMs = 0;
      }
      if (Date.now() - startedAt >= minWaitMs && quietMs >= 400) return true;
      await sleep(200);
    }
    return true;
  }

  /** 无限滚动加载：滚到底直到高度不再增长或达到 scroll 次数。 */
  async function scrollToLoadMore(times, deadline) {
    for (let i = 0; i < times && Date.now() < deadline; i++) {
      let before = 0;
      try { before = document.documentElement.scrollHeight || 0; } catch (e) {}
      try { window.scrollTo(0, document.documentElement.scrollHeight || 0); } catch (e) {}
      try { window.dispatchEvent(new Event('scroll')); } catch (e) {}
      await sleep(700);
      let after = 0;
      try { after = document.documentElement.scrollHeight || 0; } catch (e) {}
      if (after <= before + 50) break;
    }
    try { window.scrollTo(0, 0); } catch (e) {}
    await sleep(250);
  }

  function textOf(node) {
    try {
      if (node && node.innerText !== undefined) return String(node.innerText);
      if (node && node.textContent !== undefined) return String(node.textContent);
    } catch (e) {}
    return '';
  }

  function extractContent(opts) {
    const td = makeTurndown();
    let title = '';
    try { title = document.title || ''; } catch (e) {}
    let byline = '';
    let excerpt = '';
    let text = '';
    let markdown = '';

    if (opts.targetSelector) {
      let el = null;
      try { el = document.querySelector(opts.targetSelector); } catch (e) {}
      if (!el) return { error: 'target_selector 未命中: ' + opts.targetSelector };
      text = textOf(el);
      if (td) {
        try { markdown = td.turndown(el.cloneNode(true)); } catch (e) {}
      }
    } else if (typeof window.Readability === 'function') {
      try {
        const article = new window.Readability(document.cloneNode(true)).parse();
        if (article) {
          title = article.title || title;
          byline = article.byline || '';
          excerpt = article.excerpt || '';
          if (article.content) {
            const holder = document.createElement('div');
            holder.innerHTML = article.content;
            text = textOf(holder);
            if (td) {
              try { markdown = td.turndown(holder); } catch (e) {}
            }
          }
        }
      } catch (e) {}
    }

    if (!text) {
      try { text = document.body ? textOf(document.body) : ''; } catch (e) {}
    }
    if (!markdown) markdown = text;

    const out = {
      title: title,
      byline: byline,
      excerpt: excerpt,
      text: text,
      markdown: markdown,
      url: null,
      finalUrl: null,
    };
    try { out.url = location.href; } catch (e) {}
    try { out.finalUrl = location.href; } catch (e) {}
    if (opts.format === 'html') {
      try { out.html = document.documentElement.outerHTML; } catch (e) {}
    }
    return out;
  }

  /**
   * 由 background.js 的 func 包装调用：window.__dshExtractPage(opts)
   * opts: { timeout(秒), waitForSelector?, targetSelector?, scroll?, format? }
   */
  window.__dshExtractPage = async function (opts) {
    opts = opts || {};
    const timeoutSec = Math.min(Math.max(Number(opts.timeout) || 45, 5), 120);
    const deadline = Date.now() + timeoutSec * 1000;

    // 1) 等页面基本加载完成
    while (document.readyState !== 'complete' && Date.now() < deadline) {
      await sleep(200);
    }

    // 2) 等目标元素 / DOM 稳定
    if (opts.waitForSelector) {
      const ok = await waitForSelector(opts.waitForSelector, deadline);
      if (!ok) return { error: 'wait_for_selector 超时: ' + opts.waitForSelector };
    } else {
      await waitForMutationIdle(deadline);
    }

    // 3) 可选：无限滚动加载更多
    const scrollTimes = Math.min(Math.max(Number(opts.scroll) || 0, 0), 20);
    if (scrollTimes > 0) {
      await scrollToLoadMore(scrollTimes, deadline);
    }

    // 4) 提取正文
    return extractContent(opts);
  };
})();
