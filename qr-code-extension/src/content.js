// 文龙二维码助手 —— 内容脚本（逻辑桥接层）
// 监听 SHOW_QR 消息 → 调用 React 面板（src/ui.jsx → ui.js）打开二维码弹窗。
// DOM 渲染全部交给 React，这里只负责消息与生命周期。
(function () {
  const VERSION = (function () {
    try {
      return chrome.runtime.getManifest().version;
    } catch (e) {
      return '0.0.0';
    }
  })();

  const prev = window.__QR_CODE_SESSION__;
  if (prev && prev.version === VERSION) return; // 同版本重复注入：沿用已有实例
  if (prev && typeof prev.dispose === 'function') {
    try { prev.dispose(); } catch (e) { /* 忽略 */ }
  }
  document.querySelectorAll('#__QR_CODE_EXT_HOST__').forEach((node) => node.remove());

  const UI = () => globalThis.__QR_CODE_UI__;

  function showQr(text) {
    try {
      if (UI()) UI().open(text || '');
    } catch (e) {
      console.error('[二维码助手] 打开失败', e);
    }
  }

  const handler = (msg, _sender, sendResponse) => {
    if (msg && msg.type === 'SHOW_QR' && typeof msg.text === 'string') {
      showQr(msg.text);
      sendResponse({ ok: true });
    }
    return false;
  };

  try {
    chrome.runtime.onMessage.addListener(handler);
  } catch (e) {
    /* 非扩展上下文忽略 */
  }

  // 兼容旧入口
  window.__QR_CODE_EXT__ = window.__QR_CODE_EXT__ || {};
  window.__QR_CODE_EXT__.show = showQr;

  window.__QR_CODE_SESSION__ = {
    version: VERSION,
    dispose() {
      try { chrome.runtime.onMessage.removeListener(handler); } catch (e) { /* 忽略 */ }
      try { if (UI()) UI().dispose(); } catch (e) { /* 忽略 */ }
    }
  };
})();
