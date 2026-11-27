'use strict';

const MENU_ID = 'video-inspector-open-last';

// ===== webRequest: 按标签页嗅探 HLS/DASH manifest URL =====
// content script 在 document_idle 才注入，且页面可能用 fetch/XHR 之外的通道加载
// manifest（原生 video、SW、其它扩展改写过的请求），这里在网络层统一兜底。
const manifestCache = new Map(); // tabId -> Map<url, { url, kind, ts }>
const MANIFEST_TTL = 30 * 60 * 1000;

function manifestKind(details) {
  const url = String(details.url || '');
  if (/\.m3u8(\?|#|$)/i.test(url)) return 'hls';
  if (/\.mpd(\?|#|$)/i.test(url)) return 'dash';
  let type = '';
  try {
    const h = (details.responseHeaders || []).find((x) => /^content-type$/i.test(x.name || ''));
    type = String((h && h.value) || '').toLowerCase();
  } catch (_) {}
  if (/mpegurl|m3u8/i.test(type)) return 'hls';
  if (/dash\+xml/i.test(type)) return 'dash';
  return '';
}

function noteManifest(details) {
  const tabId = details.tabId;
  if (tabId == null || tabId < 0) return;
  const kind = manifestKind(details);
  if (!kind) return;
  const url = String(details.url || '');
  let m = manifestCache.get(tabId);
  if (!m) { m = new Map(); manifestCache.set(tabId, m); }
  m.set(url, { url, kind, ts: Date.now() });
  if (m.size > 60) {
    const oldest = Array.from(m.entries()).sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) m.delete(oldest[0]);
  }
  send(tabId, { type: 'vi-manifest-found', url, kind, frameId: details.frameId }, details.frameId);
}

try {
  chrome.webRequest.onResponseStarted.addListener(noteManifest, { urls: ['<all_urls>'] }, ['responseHeaders']);
} catch (_) {}

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => manifestCache.delete(tabId));
}

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

  // content 拉取本标签页已嗅探到的 manifest（含注入前发出的请求）
  if (msg.type === 'vi-get-manifests') {
    const tabId = sender && sender.tab && sender.tab.id;
    const m = tabId != null ? manifestCache.get(tabId) : null;
    const now = Date.now();
    const items = m ? Array.from(m.values()).filter((x) => now - x.ts < MANIFEST_TTL) : [];
    sendResponse({ ok: true, items });
    return;
  }

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
