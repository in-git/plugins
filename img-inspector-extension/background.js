// 自包含 ZIP 写入器（store 模式）。
// MV3 service worker 不使用 importScripts：不同 Chromium 版本对它的支持不一致，
// 一旦脚本首行抛错，整个后台不启动，会导致点击图标和下载全部无反应。
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC32_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

class ZipWriter {
  constructor() {
    this.encoder = new TextEncoder();
    this.local = [];
    this.central = [];
    this.offset = 0;
    this.count = 0;
  }

  async addFile(name, blob) {
    const nameBytes = this.encoder.encode(name);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const crc = crc32(bytes);
    const size = bytes.length;
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const day = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    this.local.push(new Blob([local, blob]));

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, day, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, this.offset, true);
    central.set(nameBytes, 46);
    this.central.push(central);

    this.offset += local.length + size;
    this.count++;
  }

  build() {
    const centralSize = this.central.reduce((sum, part) => sum + part.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, this.count, true);
    ev.setUint16(10, this.count, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, this.offset, true);
    return new Blob([...this.local, ...this.central, eocd], { type: 'application/zip' });
  }
}

const PANEL_PAGE = 'popup.html';
const WIDTH = 560;
const HEIGHT = 620;

// 点击工具栏图标：优先在网页内显示居中模态框，无法注入时退回独立窗口
chrome.action.onClicked.addListener(function (tab) {
  openPanel(tab).catch(function (err) {
    console.error('[图片探查器] 打开面板失败', err);
  });
});

async function openPanel(tab) {
  if (!tab || !tab.id) return;
  const open = { type: 'OPEN' };

  try {
    await chrome.tabs.sendMessage(tab.id, open, { frameId: 0 });
    return;
  } catch (err) {
    // 网页在插件安装/更新前就已打开，内容脚本尚未加载
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['tailwind-css.js', 'content.js']
    });
    await chrome.tabs.sendMessage(tab.id, open, { frameId: 0 });
    return;
  } catch (err) {
    // 浏览器内部页面、扩展商店等禁止注入
  }

  await openWindow(tab);
}

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

  let left;
  let top;
  try {
    const source = await chrome.windows.get(tab.windowId);
    const availLeft = typeof source.availLeft === 'number' ? source.availLeft : 0;
    const availTop = typeof source.availTop === 'number' ? source.availTop : 0;
    const availWidth = source.availWidth || source.width || WIDTH;
    const availHeight = source.availHeight || source.height || HEIGHT;
    left = availLeft + Math.max(0, Math.round((availWidth - WIDTH) / 2));
    top = availTop + Math.max(0, Math.round((availHeight - HEIGHT) / 2));
  } catch (err) {
    left = undefined;
    top = undefined;
  }

  await chrome.windows.create({
    url,
    type: 'popup',
    width: WIDTH,
    height: HEIGHT,
    left,
    top,
    focused: true
  });
}

// ---------- 下载 ----------

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

function isUsable(blob) {
  if (!blob || blob.size < 20) return false;
  return !/^text\/html/i.test(blob.type);
}

// 先由扩展后台直接请求；遇到防盗链时改在网页环境内请求（带上网页的来源信息）
async function fetchImage(url, tabId, frameId) {
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (response.ok) {
      const blob = await response.blob();
      if (isUsable(blob)) return blob;
    }
  } catch (err) { /* 继续尝试网页内请求 */ }

  const inPage = await chrome.tabs.sendMessage(tabId, { type: 'FETCH_INPAGE', url }, { frameId });
  if (!inPage || !inPage.dataUrl) {
    throw new Error((inPage && inPage.error) || '获取失败');
  }
  const response = await fetch(inPage.dataUrl);
  const blob = await response.blob();
  if (!isUsable(blob)) throw new Error('返回内容不是图片');
  return blob;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await mapper(items[i], i);
      } catch (err) {
        results[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function timestamp() {
  return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
}

const BATCH = 6;

async function handleDownload(msg, sender) {
  const items = msg.items || [];
  const tabId = sender.tab.id;
  const frameId = sender.frameId;
  let ok = 0;
  let fail = 0;

  function report(done) {
    try {
      Promise.resolve(chrome.tabs.sendMessage(
        tabId, { type: 'PROGRESS', done, total: items.length, ok, fail }, { frameId }
      )).catch(function () { /* 面板已关闭或消息端口提前关闭 */ });
    } catch (err) { /* 忽略 */ }
  }

  // 分批抓取、边抓边写入/下载，避免同时把所有 Blob 留在内存里
  if (msg.zip) {
    const zip = new ZipWriter();
    const used = Object.create(null);
    for (let start = 0; start < items.length; start += BATCH) {
      const batch = items.slice(start, start + BATCH);
      const blobs = await mapLimit(batch, BATCH, (item) => fetchImage(item.url, tabId, frameId));
      for (let i = 0; i < batch.length; i++) {
        if (!blobs[i]) { fail++; continue; }
        let name = nameOf(batch[i], start + i, blobs[i].type);
        if (used[name]) name = (start + i + 1) + '-' + name;
        used[name] = 1;
        await zip.addFile(name, blobs[i]);
        ok++;
      }
      report(Math.min(start + BATCH, items.length));
    }
    if (!ok) return { ok, fail };
    const url = URL.createObjectURL(zip.build());
    try {
      await chrome.downloads.download({
        url,
        filename: 'images-' + timestamp() + '.zip',
        conflictAction: 'uniquify',
        saveAs: false
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    return { ok, fail };
  }

  for (let start = 0; start < items.length; start += BATCH) {
    const batch = items.slice(start, start + BATCH);
    const blobs = await mapLimit(batch, BATCH, (item) => fetchImage(item.url, tabId, frameId));
    for (let i = 0; i < batch.length; i++) {
      if (!blobs[i]) { fail++; continue; }
      const url = URL.createObjectURL(blobs[i]);
      try {
        await chrome.downloads.download({
          url,
          filename: nameOf(batch[i], start + i, blobs[i].type),
          conflictAction: 'uniquify',
          saveAs: false
        });
        ok++;
      } catch (err) {
        fail++;
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    }
    report(Math.min(start + BATCH, items.length));
  }
  return { ok, fail };
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || msg.type !== 'DOWNLOAD' || !sender.tab) return false;
  const total = (msg.items || []).length;
  handleDownload(msg, sender).then(sendResponse, function (err) {
    sendResponse({ ok: 0, fail: total, error: String((err && err.message) || err) });
  });
  return true;
});
