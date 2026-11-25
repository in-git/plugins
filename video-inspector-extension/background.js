'use strict';

const MENU_ID = 'video-inspector-open-last';

function createMenu() {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: '下载页面视频',
    contexts: ['page', 'frame', 'selection', 'link', 'image', 'video', 'audio']
  }, () => void chrome.runtime.lastError);
}

chrome.runtime.onInstalled.addListener(createMenu);
if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(createMenu);

function send(tabId, message, frameId) {
  if (tabId == null) return;
  const options = typeof frameId === 'number' ? { frameId } : undefined;
  chrome.tabs.sendMessage(tabId, message, options || {}, () => void chrome.runtime.lastError);
}

chrome.action.onClicked.addListener((tab) => send(tab && tab.id, { type: 'vi-toggle' }));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  send(tab && tab.id, { type: 'vi-open-last' }, info.frameId);
});

// ===== ffmpeg offscreen mux relay =====
let offscreenCreating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing && existing.length) return;
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Merge video and audio streams into a single MP4 file'
  }).catch((e) => {
    if (!/already exists/i.test(String(e && e.message || e))) throw e;
  }).finally(() => { offscreenCreating = null; });
  return offscreenCreating;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // offscreen 就绪信号
  if (msg.type === 'vi-offscreen-ready') return;

  // offscreen -> 所有 tab：mux 结果广播（含 result / progress）
  if (msg.type === 'vi-mux-result' || msg.type === 'vi-mux-progress') {
    if (sender && sender.tab) return;
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (tab && tab.id != null) {
          chrome.tabs.sendMessage(tab.id, msg, () => void chrome.runtime.lastError);
        }
      }
    });
    return;
  }

  // content -> offscreen：需剥离 sender.tab，否则 offscreen 的 tab 守卫会丢弃
  if (msg.type === 'vi-mux-init' || msg.type === 'vi-mux-chunk' || msg.type === 'vi-mux-go') {
    if (!sender || !sender.tab) return; // 已是转发副本，避免回环
    (async () => {
      try {
        await ensureOffscreen();
        await new Promise((r) => setTimeout(r, 50));
        sendResponse({ ok: true });
        chrome.runtime.sendMessage(msg).catch(() => {});
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
});
