import { formatSelect, host, shadow } from '../ui/mount.js';
import { MAX_DEPTH } from './constants.js';

function itemKey(item) {
  return String(item && item.index) + ':' + ((item && item.src) || 'no-src');
}

function frameFromVideo(video) {
  try {
    if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 2) return null;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 480 / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch (_) {
    return null;
  }
}


function candidateUrls(item) {
  const video = item.el;
  const candidates = [];
  const add = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  // 只取「当前这个 video 元素」自身对应的地址，避免多视频页面串台。
  if (video) {
    add(video.currentSrc);
    add(video.src);
    try {
      Array.from(video.querySelectorAll('source')).forEach((source) => {
        add(source.src || source.getAttribute('src'));
      });
    } catch (_) {}
  }
  add(item.src);

  // 只有当整页仅有一个视频时，才用资源记录里的地址补全。
  // 多视频页面（如 TikTok 信息流）里资源记录无法可靠对应到具体 video，
  // 盲目取第一个会导致一直下载同一个视频，因此这种情况下不使用，改由录制兜底。
  try {
    const root = document.body || document.documentElement;
    const videoCount = (root.querySelectorAll ? root.querySelectorAll('video').length : 0)
      + (root.shadowRoot ? root.shadowRoot.querySelectorAll('video').length : 0);
    if (videoCount <= 1) {
      const isVideoFile = /(\.mp4|\.webm|\.m4v)(\?|$)|(\/video\/tos\/)|(\/video\/mp4\/)|(v\d+-webapp[^/]*\/video\/)/i;
      const entries = performance.getEntriesByType('resource') || [];
      entries.forEach((entry) => {
        const url = entry.name || '';
        if (/^https?:\/\//i.test(url) && isVideoFile.test(url)) add(url);
      });
    }
  } catch (_) {}

  return candidates;
}

// 页面标题清洗成可作文件名的字符串（与 fileName 的规则一致）
function cleanPageTitle() {
  return String(document.title || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function fileName(item, forceExt) {
  const raw = (item.customTitle || '').trim();
  const base = String(raw).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'video';
  if (forceExt) return base + '.' + forceExt;
  const format = formatSelect ? formatSelect.value : 'mp4';
  let ext;
  if (format === 'mp4') ext = 'mp4';
  else if (format === 'webm') ext = 'webm';
  else {
    const first = candidateUrls(item)[0] || '';
    const match = first.split('?')[0].match(/\.(mp4|webm|ogv|mov|m4v|mkv|avi|flv)$/i);
    ext = match ? match[1].toLowerCase() : (/webm/i.test(first) ? 'webm' : 'mp4');
  }
  return base + '.' + ext;
}

// 断点续传的稳定标识：只用 origin+pathname，避免签名参数变化导致对不上任务
function jobKeyOf(item) {
  const raw = (item && (item.src || (item.el && item.el.currentSrc))) || '';
  try {
    const u = new URL(raw, location.href);
    if (/^https?:$/.test(u.protocol)) return u.origin + u.pathname;
  } catch (_) {}
  return '';
}

function resumeKeyOf(item) {
  return jobKeyOf(item) || String(fileName(item)).replace(/\.[^.]+$/, '');
}


function copyText(text) {
  if (!text) return;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  shadow.appendChild(area);
  area.select();
  try { document.execCommand('copy'); } catch (_) {}
  area.remove();
}

function hitTest(doc, x, y, offsetX = 0, offsetY = 0, depth = 0) {
  if (depth > MAX_DEPTH || !doc || !isReadable(doc)) return null;
  let el;
  try { el = doc.elementFromPoint(x, y); } catch (_) { return null; }
  if (!el) return null;

  if (el.tagName === 'IFRAME') {
    let inner = null;
    try { inner = el.contentDocument; } catch (_) {}
    if (inner && isReadable(inner)) {
      const rect = el.getBoundingClientRect();
      const nx = x - rect.left;
      const ny = y - rect.top;
      if (nx >= 0 && ny >= 0 && nx <= rect.width && ny <= rect.height) {
        const found = hitTest(inner, nx, ny, offsetX + rect.left, offsetY + rect.top, depth + 1);
        if (found) return found;
      }
    }
  }

  if (el.shadowRoot) {
    let shadowEl = null;
    try { shadowEl = el.shadowRoot.elementFromPoint(x, y); } catch (_) {}
    if (shadowEl && shadowEl !== el) return makeHit(shadowEl, doc, offsetX, offsetY);
  }

  return makeHit(el, doc, offsetX, offsetY);
}

function makeHit(el, doc, offsetX, offsetY) {
  const rect = el.getBoundingClientRect();
  return {
    el,
    doc,
    rect: {
      left: rect.left + offsetX,
      top: rect.top + offsetY,
      width: rect.width,
      height: rect.height
    }
  };
}


function collectVideos(node, offsetX, offsetY, depth, out = [], seen = new Set(), maxDepth = MAX_DEPTH) {
  if (!node || depth > maxDepth || seen.has(node)) return out;
  seen.add(node);

  if (node.nodeType === 1) {
    if (node.tagName === 'VIDEO') {
      if (videoHasSource(node)) out.push({ el: node, ox: offsetX, oy: offsetY });
      return out;
    }
    if (node.tagName === 'IFRAME') {
      let doc = null;
      try { doc = node.contentDocument; } catch (_) {}
      if (doc && doc.documentElement) {
        const rect = node.getBoundingClientRect();
        collectVideos(doc.documentElement, offsetX + rect.left, offsetY + rect.top, depth + 1, out, seen, maxDepth);
      }
      return out;
    }
    if (node.shadowRoot) {
      collectVideos(node.shadowRoot, offsetX, offsetY, depth + 1, out, seen, maxDepth);
    }
  }

  let children = [];
  try { children = node.querySelectorAll ? Array.from(node.querySelectorAll('*')) : []; } catch (_) {}
  for (const child of children) {
    if (seen.has(child)) continue;
    if (child.tagName === 'VIDEO') {
      if (videoHasSource(child)) out.push({ el: child, ox: offsetX, oy: offsetY });
      continue;
    }
    if (child.shadowRoot) {
      collectVideos(child.shadowRoot, offsetX, offsetY, depth + 1, out, seen, maxDepth);
    }
    if (child.tagName === 'IFRAME') {
      let doc = null;
      try { doc = child.contentDocument; } catch (_) {}
      if (doc && doc.documentElement) {
        const rect = child.getBoundingClientRect();
        collectVideos(doc.documentElement, offsetX + rect.left, offsetY + rect.top, depth + 1, out, seen, maxDepth);
      }
    }
  }
  return out;
}

 



function videoHasSource(video) {
  if (!video) return false;
  try {
    if (video.currentSrc || video.src) return true;
    return Array.from(video.querySelectorAll('source')).some((source) => source.src || source.getAttribute('src'));
  } catch (_) {
    return false;
  }
}

function videoSrc(video) {
  if (video.currentSrc) return video.currentSrc;
  if (video.src) return video.src;
  const sources = Array.from(video.querySelectorAll('source'))
    .map((source) => source.src || source.getAttribute('src'))
    .filter(Boolean);
  return sources.length ? sources.join(', ') : '';
}

function formatDuration(value) {
  if (!Number.isFinite(value) || value <= 0) return '-';
  const m = Math.floor(value / 60);
  const s = Math.floor(value % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '-';
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}


function describe(el) {
  if (!el) return '';
  const tag = (el.tagName || el.nodeName || '').toLowerCase();
  const id = el.id ? '#' + el.id : '';
  let cls = '';
  if (typeof el.className === 'string' && el.className.trim()) {
    cls = '.' + el.className.trim().split(/\s+/).join('.');
  }
  return tag + id + cls;
}

function isReadable(doc) {
  try { return Boolean(doc && doc.body); } catch (_) { return false; }
}

function isOwnEvent(event) {
  try {
    return Boolean(host && typeof event.composedPath === 'function' && event.composedPath().includes(host));
  } catch (_) {
    return event.target === host;
  }
}

function deepestElement(event) {
  try {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const found = path.find((node) => node && node.nodeType === 1);
    if (found) return found;
  } catch (_) {}
  return event.target && event.target.nodeType === 1 ? event.target : null;
}

// 从命中元素向上（含 shadow host）找最近一个子树里含视频的容器，最多 8 层
function findVideoRoot(node, maxHops = 8) {
  let cur = node;
  for (let i = 0; cur && i <= maxHops; i++) {
    if (cur.nodeType === 1) {
      const list = collectVideos(cur, 0, 0, 0);
      if (list.length) return cur;
    }
    if (cur.parentElement) {
      cur = cur.parentElement;
    } else {
      let root = null;
      try { root = cur.getRootNode ? cur.getRootNode() : null; } catch (_) {}
      cur = root && root.host ? root.host : null;
    }
  }
  return null;
}

export { itemKey, frameFromVideo, candidateUrls, cleanPageTitle, fileName, jobKeyOf, resumeKeyOf, copyText, fallbackCopy, hitTest, makeHit, collectVideos, videoHasSource, videoSrc, formatDuration, formatSize, describe, isReadable, isOwnEvent, deepestElement, findVideoRoot };
