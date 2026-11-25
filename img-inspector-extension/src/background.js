// 图片探查器后台：打开面板 + 下载
// 下载一律走 chrome.downloads.download(原始 URL)：
// 浏览器自身会带上该站点的 Cookie / Referer，不受 CORS 限制，也不需要先 fetch。
// 只有打包 ZIP 才需要抓取字节。

const VERSION = '1.0.40';
const PANEL_PAGE = 'popup.html';
const WIDTH = 560;
const HEIGHT = 620;

// ---------- 打开面板 ----------

// 每次点击都重新注入：不依赖 sendMessage 的返回值判断是否成功。
// 旧版内容脚本残留的 onMessage 监听器会抢先应答 OPEN，
// 用消息探测会让后台误判成功、永远不注入新版脚本。
chrome.action.onClicked.addListener(function (tab) {
  if (!tab || !tab.id) return;
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['tailwind-css.js', 'zip.js', 'ui.js', 'content.js', 'bootstrap.js']
  }).catch(async function (err) {
    console.warn('[图片探查器] 网页内注入失败，改用备用窗口', err);
    try { await openWindow(tab); } catch (e) { console.error('[图片探查器] 备用窗口也失败', e); }
  });
});

async function openWindow(tab) {
  const baseUrl = chrome.runtime.getURL(PANEL_PAGE);
  const url = baseUrl + '?tabId=' + tab.id;
  const windows = await chrome.windows.getAll({ populate: true });
  for (const win of windows) {
    const existing = (win.tabs || []).find((t) => t.url && t.url.startsWith(baseUrl));
    if (existing) {
      await chrome.tabs.update(existing.id, { url });
      await chrome.windows.update(win.id, { focused: true });
      return;
    }
  }
  await chrome.windows.create({
    url, type: 'popup', width: WIDTH, height: HEIGHT, focused: true
  });
}

// ---------- 文件名 ----------

function safeName(text) {
  return String(text).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60) || 'image';
}

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/avif': 'avif'
};

function extensionOf(url, mime) {
  try {
    const match = new URL(url).pathname.match(/\.(jpe?g|png|gif|webp|svg|bmp|ico|avif)$/i);
    if (match) {
      const ext = match[1].toLowerCase();
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  } catch (err) { /* data URL */ }
  return (mime && MIME_EXT[mime.split(';')[0].trim()]) || 'bin';
}

function nameOf(item, index, mime) {
  let host = 'image';
  try { host = new URL(item.url).hostname || 'image'; } catch (err) { /* data URL */ }
  const dim = item.width && item.height ? '-' + item.width + 'x' + item.height : '';
  return String(index + 1).padStart(3, '0') + '-' + safeName(host) + dim + '.' + extensionOf(item.url, mime);
}

// ---------- 下载 ----------

const downloadsLog = [];

// 等待单张下载真正完成（complete / interrupted），返回 { ok, error }
function waitDownloadDone(id, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve({ ok: !!ok, error: error || '' });
    };
    const onChanged = (delta) => {
      if (!delta || delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') finish(true);
      else if (delta.state.current === 'interrupted') finish(false, (delta.error && delta.error.current) || 'INTERRUPTED');
    };
    const timer = setTimeout(() => finish(false, 'TIMEOUT'), timeoutMs || 120000);
    chrome.downloads.onChanged.addListener(onChanged);
    // 下载可能在监听前就已完成，补一次状态查询
    chrome.downloads.search({ id }, (list) => {
      const item = list && list[0];
      if (!item) return;
      if (item.state === 'complete') finish(true);
      else if (item.state === 'interrupted') finish(false, item.error || 'INTERRUPTED');
    });
  });
}

// 被防盗链拒绝时：用带 Referer 的请求抓字节，再交给页面保存
async function saveViaFetch(item, index, tabId, frameId) {
  const blob = await fetchBlob(item.url, tabId, frameId);
  if (!blob) return false;
  let dataUrl;
  try { dataUrl = await blobToDataUrl(blob); } catch (err) { return false; }
  const filename = nameOf(item, index, blob.type || '');
  if (tabId) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'SAVE_IMAGE_DATA', dataUrl, filename }, { frameId });
      if (res && res.ok) return true;
    } catch (err) { /* 页面不可用，尝试直接下载 data URL */ }
  }
  try {
    const id = await chrome.downloads.download({ url: dataUrl, filename, conflictAction: 'uniquify', saveAs: false });
    const state = await waitDownloadDone(id, 120000);
    return state.ok;
  } catch (err) {
    return false;
  }
}

async function downloadDirect(items, tabId, frameId) {
  let ok = 0;
  let fail = 0;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    try {
      const id = await chrome.downloads.download({
        url: item.url,
        filename: nameOf(item, i, ''),
        conflictAction: 'uniquify',
        saveAs: false
      });
      downloadsLog.push({ url: item.url, id });
      const state = await waitDownloadDone(id, 120000);
      if (state.ok) { ok++; continue; }
      // 站点防盗链（如 pixiv 的 i.pximg.net 返回 403）：带 Referer 重试
      if (state.error !== 'USER_CANCELED' && await saveViaFetch(item, i, tabId, frameId)) ok++;
      else fail++;
    } catch (err) {
      if (await saveViaFetch(item, i, tabId, frameId)) ok++;
      else {
        fail++;
        console.warn('[图片探查器] 单张下载失败', item.url, err);
      }
    }
  }
  return { ok, fail };
}

async function fetchBlob(url, tabId, frameId) {
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (response.ok) {
      const blob = await response.blob();
      if (blob && blob.size > 20 && !/^text\/html/i.test(blob.type)) return blob;
    }
  } catch (err) { /* 尝试网页内请求 */ }

  try {
    const inPage = await chrome.tabs.sendMessage(
      tabId, { type: 'FETCH_INPAGE', url }, { frameId }
    );
    if (inPage && inPage.dataUrl) {
      const blob = await (await fetch(inPage.dataUrl)).blob();
      if (blob && blob.size > 20) return blob;
    }
  } catch (err) { /* 放弃该张 */ }
  return null;
}

async function handleDownload(msg, sender) {
  const items = (msg.items || []).filter((it) => it && it.url);
  if (!items.length) return { ok: 0, fail: 0, error: '没有可下载的图片' };
  const tabId = sender && sender.tab ? sender.tab.id : 0;
  const frameId = sender ? (sender.frameId || 0) : 0;
  return downloadDirect(items, tabId, frameId);
}

// ---------- 裁剪：为面板读取图片字节（绕过 CORS/防盗链） ----------

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + btoa(binary);
}

async function handleFetchImage(msg, sender) {
  const url = msg.url;
  if (!url) return { error: '缺少图片地址' };
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  const frameId = sender ? sender.frameId : 0;
  const blob = await fetchBlob(url, tabId, frameId);
  if (!blob) return { error: '图片获取失败（可能受防盗链保护）' };
  if (blob.size > 15 * 1024 * 1024) return { error: '图片超过 15MB，暂不支持裁剪' };
  return { dataUrl: await blobToDataUrl(blob) };
}

// ---------- 打包：为页面内 ZIP 构建读取图片字节 ----------

async function handleFetchImageBytes(msg, sender) {
  const url = msg.url;
  if (!url) return { error: '缺少图片地址' };
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  const frameId = sender ? sender.frameId : 0;
  const blob = await fetchBlob(url, tabId, frameId);
  if (!blob) return { error: '图片获取失败（可能受防盗链保护）' };
  if (blob.size > 40 * 1024 * 1024) return { error: '图片超过 40MB，已跳过' };
  return { dataUrl: await blobToDataUrl(blob), type: blob.type };
}

// ---------- 图片大小：用 HEAD 读取 Content-Length ----------

async function handleImageSize(msg) {
  const url = msg.url;
  if (!url || !/^https?:/i.test(url)) return { bytes: 0 };
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'include' });
    const len = Number(res.headers.get('content-length'));
    if (res.ok && Number.isFinite(len) && len > 0) return { bytes: len };
  } catch (err) { /* 忽略 */ }
  return { bytes: 0 };
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return false;
  if (msg.type === 'IMAGE_SIZE') {
    Promise.resolve(handleImageSize(msg)).then(sendResponse, function (err) {
      sendResponse({ error: String((err && err.message) || err) });
    });
    return true;
  }
  if (msg.type === 'FETCH_IMAGE_BYTES') {
    Promise.resolve(handleFetchImageBytes(msg, sender)).then(sendResponse, function (err) {
      sendResponse({ error: String((err && err.message) || err) });
    });
    return true;
  }
  if (msg.type === 'FETCH_IMAGE') {
    Promise.resolve(handleFetchImage(msg, sender)).then(sendResponse, function (err) {
      sendResponse({ error: String((err && err.message) || err) });
    });
    return true;
  }
  if (msg.type !== 'DOWNLOAD') return false;
  Promise.resolve(handleDownload(msg, sender)).then(sendResponse, function (err) {
    console.error('[图片探查器] 下载处理异常', err);
    sendResponse({ ok: 0, fail: (msg.items || []).length, error: String((err && err.message) || err) });
  });
  return true;
});
