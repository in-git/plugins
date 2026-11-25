(function () {
  const VERSION = '1.0.40';

  // 纯逻辑层：扫描、筛选、布局、下载、状态管理。
  // DOM 渲染完全交给 React（src/ui.jsx → ui.js）。
  const prev = window.__IMG_INSPECTOR_SESSION__;
  if (prev && prev.version === VERSION) {
    // 同版本重复注入：只重新打开已有面板
    if (typeof window.__IMG_INSPECTOR_BOOT__ === 'function') window.__IMG_INSPECTOR_BOOT__();
    return;
  }
  if (prev && typeof prev.dispose === 'function') {
    try { prev.dispose(); } catch (e) { /* 忽略 */ }
  }
  document.querySelectorAll('#__img_inspector_host__').forEach((n) => n.remove());

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const UI = () => globalThis.__IMG_INSPECTOR_UI__;

  // ==================== 扫描 ====================

  function abs(u, base) {
    if (!u) return '';
    u = String(u).trim();
    if (/^(data|blob|chrome-extension):/i.test(u)) return u;
    if (/^\/\//.test(u)) u = location.protocol + u;
    try { return new URL(u, base || location.href).href; } catch (e) { return u; }
  }

  function srcsetCandidates(s) {
    if (!s) return [];
    return s.split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
  }

  function bgUrls(el, view) {
    let bg = '';
    try { bg = view.getComputedStyle(el).backgroundImage || ''; } catch (e) { return []; }
    const re = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)]*))\s*\)/g;
    const out = [];
    let m;
    while ((m = re.exec(bg)) !== null) {
      const u = m[1] || m[2] || m[3];
      if (u) out.push(u.trim());
    }
    return out;
  }

  function scanDoc(doc) {
    const view = doc.defaultView;
    const base = doc.baseURI || (doc.location && doc.location.href) || location.href;
    const results = [];
    const seen = Object.create(null);

    function add(u, source, width, height) {
      if (!u) return;
      const full = abs(u, base);
      if (!full || seen[full]) return;
      if (/^data:/i.test(full) && full.length < 100) return;
      seen[full] = 1;
      results.push({ url: full, source: source || 'img', width: width || 0, height: height || 0 });
    }

    const elements = [];
    function walk(root) {
      let all;
      try { all = root.querySelectorAll('*'); } catch (e) { return; }
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        elements.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    }
    walk(doc.documentElement || doc);

    for (const el of elements) {
      const tag = String(el.tagName || '').toLowerCase();
      if (tag === 'img') {
        const ss = srcsetCandidates(el.getAttribute('srcset'));
        const candidates = [
          el.currentSrc, el.src, ss.length ? ss[ss.length - 1] : '',
          el.getAttribute('data-src'), el.getAttribute('data-original'),
          el.getAttribute('data-lazy-src'), el.getAttribute('data-echo'),
          el.getAttribute('data-url'), el.getAttribute('data-image'),
          el.getAttribute('data-full'), el.getAttribute('data-large'),
          el.getAttribute('data-href')
        ];
        for (const u of candidates) {
          if (u) { add(u, 'img', el.naturalWidth, el.naturalHeight); break; }
        }
      } else if (tag === 'source') {
        srcsetCandidates(el.getAttribute('srcset')).forEach((u) => add(u, 'picture'));
      } else if (tag === 'link') {
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        const as = (el.getAttribute('as') || '').toLowerCase();
        if (rel === 'icon' || rel === 'apple-touch-icon' || rel === 'apple-touch-icon-precomposed' ||
            rel === 'image_src' || (rel === 'preload' && as === 'image')) add(el.href, 'link');
      } else if (tag === 'meta') {
        const key = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
        if (key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url' ||
            key === 'twitter:image' || key === 'twitter:image:src' ||
            key === 'thumbnail' || key === 'msapplication-tileimage') add(el.content, 'meta');
      } else if (tag === 'image') {
        add(el.getAttribute('href') || el.getAttribute('xlink:href'), 'svg');
      } else if (tag === 'input' && el.type === 'image') {
        add(el.src, 'input');
      }

      bgUrls(el, view).forEach((u) => add(u, 'background'));
      const style = el.getAttribute('style') || '';
      if (/background-image/i.test(style)) {
        const probe = doc.createElement('div');
        probe.style.cssText = style;
        bgUrls(probe, view).forEach((u) => add(u, 'background'));
      }
    }
    return { images: results, title: doc.title || '', url: base };
  }

  function scanAll() {
    const main = scanDoc(document);
    const merged = [];
    const seen = Object.create(null);
    function push(data) {
      (data.images || []).forEach((img) => {
        if (!img.url || seen[img.url]) return;
        seen[img.url] = 1;
        merged.push(img);
      });
    }
    push(main);
    try {
      document.querySelectorAll('iframe,frame').forEach((frame) => {
        let doc = null;
        try { doc = frame.contentDocument; } catch (e) { /* 跨域 */ }
        if (doc && doc.documentElement) push(scanDoc(doc));
      });
    } catch (e) { /* 忽略 */ }
    return { images: merged, title: main.title, url: main.url };
  }

  // ==================== 筛选（纯函数） ====================

  // 形状筛选：控制器宽高比 = 目标图片宽高比，容差内即命中；
  // sizeMode = 'any' 不限大小，'gte' 面积大于控制器，'lte' 面积小于控制器。
  // 默认不启用：进入页面不自动筛选，只有点「应用」或用开关手动启用后才生效。
  const DEFAULT_CFG = {
    enabled: false, boxW: 100, boxH: 100, scale: 1,
    tolerance: 0.2, sizeMode: 'any', formats: [], sources: []
  };
  const cfg = Object.assign({}, DEFAULT_CFG, { formats: [], sources: [] });

  // ==================== 配置持久化 ====================
  // 关闭筛选器 / 刷新页面后仍保留上一次的筛选属性。
  const CFG_KEY = 'ii-filter-cfg';
  let saveTimer = 0;

  function persistCfg() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        if (!chrome.storage || !chrome.storage.local) return;
        chrome.storage.local.set({
          [CFG_KEY]: {
            enabled: cfg.enabled, boxW: cfg.boxW, boxH: cfg.boxH, scale: cfg.scale,
            tolerance: cfg.tolerance, sizeMode: cfg.sizeMode,
            formats: cfg.formats.slice(), sources: cfg.sources.slice()
          }
        });
      } catch (e) { /* 忽略 */ }
    }, 150);
  }

  function restoreCfg() {
    try {
      if (!chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get(CFG_KEY).then((res) => {
        const d = res && res[CFG_KEY];
        if (!d) return;
        // 启用状态不恢复：每次进入页面都保持未筛选，需手动点「应用」
        if (Number.isFinite(d.boxW)) cfg.boxW = clamp(Math.round(d.boxW), 10, 400);
        if (Number.isFinite(d.boxH)) cfg.boxH = clamp(Math.round(d.boxH), 10, 400);
        if (Number.isFinite(d.scale)) cfg.scale = clamp(d.scale, 0.1, 10);
        if (Number.isFinite(d.tolerance)) cfg.tolerance = clamp(d.tolerance, 0.05, 0.6);
        if (d.sizeMode === 'gte' || d.sizeMode === 'lte' || d.sizeMode === 'any') cfg.sizeMode = d.sizeMode;
        // 旧版按宽/高筛选的配置：把“大于/小于”迁移为大小开关，形状沿用兼容默认值
        else if (d.mode === 'gte' || d.mode === 'lte') cfg.sizeMode = d.mode;
        if (Array.isArray(d.formats)) cfg.formats = d.formats.slice();
        if (Array.isArray(d.sources)) cfg.sources = d.sources.slice();
        applyFilter();
      }).catch(() => {});
    } catch (e) { /* 忽略 */ }
  }

  function extOf(url) {
    try {
      const m = new URL(url).pathname.match(/\.(jpe?g|png|gif|webp|svg|bmp|ico|avif)$/i);
      if (!m) return 'other';
      const ext = m[1].toLowerCase();
      return ext === 'jpeg' ? 'jpg' : ext;
    } catch (e) { return 'other'; }
  }

  function sourceGroup(source) {
    if (source === 'background') return 'background';
    if (source === 'img' || source === 'picture' || source === 'input') return 'img';
    return 'other';
  }

  // 控制器折算后的目标尺寸与面积（方块 1px = scale 图片像素）
  function thresholdOf(c) {
    const w = Math.round(c.boxW * c.scale);
    const h = Math.round(c.boxH * c.scale);
    return { w, h, area: w * h };
  }

  // 形状筛选：控制器宽高比 = 目标图片宽高比，容差内即命中。
  // sizeMode 可选再按面积约束大小；无法判断形状的图片一律不显示。
  function passesFilter(img, c) {
    if (!c.enabled) return true;
    if (!(img.width > 0 && img.height > 0)) return false;
    const targetRatio = c.boxW / c.boxH;
    const ratio = img.width / img.height;
    if (Math.abs(ratio - targetRatio) / targetRatio > c.tolerance) return false;
    if (c.sizeMode === 'gte' || c.sizeMode === 'lte') {
      const area = img.width * img.height;
      if (c.sizeMode === 'gte' ? area < thresholdOf(c).area : area > thresholdOf(c).area) return false;
    }
    if (c.formats.length && c.formats.indexOf(extOf(img.url)) < 0) return false;
    if (c.sources.length && c.sources.indexOf(sourceGroup(img.source)) < 0) return false;
    return true;
  }

  // ==================== 状态（useSyncExternalStore） ====================

  let images = [];
  let filtered = [];
  let layout = [];
  let visible = [];
  let canvasHeight = 0;
  let currentUrl = '';
  let site = '';
  let title = '';
  let status = '准备就绪';
  let statusKind = '';
  let filterOpen = false;
  function dataUrlToBlob(dataUrl) {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) throw new Error('裁剪数据无效');
    const mime = (/^data:([^;]+)/.exec(dataUrl.slice(0, comma)) || [])[1] || 'image/png';
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }

  function saveDataUrl(dataUrl, filename) {
    const href = URL.createObjectURL(dataUrlToBlob(dataUrl));
    const link = document.createElement('a');
    link.href = href;
    link.download = filename || 'crop.png';
    link.style.display = 'none';
    (document.body || document.documentElement).appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
    return { ok: 1 };
  }

  let scrollTop = 0;
  let viewport = 600;
  let canvasWidth = 0;
  let busy = false;
  const selected = new Set();
  const listeners = new Set();
  let snapshot = null;

  function buildSnapshot() {
    const chosen = filtered.reduce((n, img) => n + (selected.has(img.url) ? 1 : 0), 0);
    const unknownCount = images.reduce((n, img) => n + (img.width > 0 && img.height > 0 ? 0 : 1), 0);
    return {
      site, title, currentUrl,
      total: images.length,
      matched: filtered.length,
      unknownCount,
      selectedCount: chosen,
      allSelected: filtered.length > 0 && chosen === filtered.length,
      status, statusKind, filterOpen,
      cfg: Object.assign({}, cfg, { formats: cfg.formats.slice(), sources: cfg.sources.slice() }),
      threshold: thresholdOf(cfg),
      layout, visible, canvasHeight,
      selected
    };
  }

  function notify() {
    snapshot = buildSnapshot();
    listeners.forEach((fn) => {
      try { fn(); } catch (e) { console.error('[图片探查器] 订阅回调失败', e); }
    });
  }

  function setStatus(text, kind) {
    status = text || '';
    statusKind = kind || '';
    notify();
  }

  // ==================== 布局（瀑布流 + 虚拟渲染） ====================

  const GAP = 16;
  const CARD_MIN = 210;
  const BUFFER = 700;
  const PAD = 10;

  function ratioOf(img, i) {
    if (img.width && img.height) return clamp(img.width / img.height, 0.3, 3.5);
    const seq = [0.78, 1, 1.28, 0.9, 1.45, 0.82, 1.12];
    return seq[i % seq.length];
  }

  function updateVisible() {
    const from = scrollTop - BUFFER;
    const to = scrollTop + viewport + BUFFER;
    const next = [];
    for (let i = 0; i < layout.length; i++) {
      const item = layout[i];
      if (item.top + item.height >= from && item.top <= to) next.push(i);
    }
    const changed = next.length !== visible.length || next.some((v, i) => v !== visible[i]);
    if (changed) { visible = next; return true; }
    return false;
  }

  // 始终用面板实测宽度排版；筛选、重扫等重算布局时必须沿用上次测量值，
  // 否则会退回默认宽度、卡片全挤在左侧。还没测到宽度时按面板尺寸估算。
  function fallbackWidth() {
    return Math.min(window.innerWidth * 0.7, 1600) - 72;
  }

  function computeLayout(width) {
    const canvas = Math.max(240, Math.round(width || canvasWidth || fallbackWidth()));
    const cols = clamp(Math.floor((canvas + GAP) / (CARD_MIN + GAP)), 2, 8);
    const colWidth = Math.floor((canvas - GAP * (cols - 1)) / cols);
    const innerWidth = colWidth - PAD * 2;
    const heights = new Array(cols).fill(0);

    layout = filtered.map((img, i) => {
      const imgH = Math.round(innerWidth / ratioOf(img, i));
      const h = PAD + imgH + PAD;
      let c = 0;
      for (let k = 1; k < cols; k++) if (heights[k] < heights[c]) c = k;
      const item = { img, index: i, left: c * (colWidth + GAP), top: heights[c], width: colWidth, imgH, height: h };
      heights[c] += h + GAP;
      return item;
    });
    canvasHeight = filtered.length ? Math.max(0, Math.max.apply(null, heights) - GAP) : 0;
    // 筛选后内容变短时，把视口钳回有效范围，避免停在一片空白里
    scrollTop = clamp(scrollTop, 0, Math.max(0, canvasHeight - viewport));
    visible = [];
    updateVisible();
    notify();
  }

  function applyFilter() {
    filtered = images.filter((img) => passesFilter(img, cfg));
    const urls = new Set(filtered.map((img) => img.url));
    Array.from(selected).forEach((u) => { if (!urls.has(u)) selected.delete(u); });
    computeLayout();
  }

  // ==================== 扫描 / 尺寸探测 ====================

  function probeOne(url) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const probe = new Image();
        probe.onload = () => finish(probe.naturalWidth && probe.naturalHeight
          ? { w: probe.naturalWidth, h: probe.naturalHeight } : null);
        probe.onerror = () => finish(null);
        probe.src = url;
        setTimeout(() => finish(null), 3000);
      } catch (e) { finish(null); }
    });
  }

  async function probeMissingSizes(list) {
    const unknown = list.filter((img) => !(img.width && img.height));
    if (!unknown.length) return;
    let changed = false;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, unknown.length) }, async () => {
      while (next < unknown.length) {
        const img = unknown[next++];
        const size = await probeOne(img.url);
        if (size) { img.width = size.w; img.height = size.h; changed = true; }
      }
    }));
    if (changed && UI() && UI().isOpen()) applyFilter();
  }

  // ==================== 文件大小 ====================

  const byteCache = Object.create(null);

  function dataUrlBytes(u) {
    const comma = u.indexOf(',');
    if (comma < 0) return 0;
    const body = u.slice(comma + 1);
    const pad = (body.match(/=+$/) || [''])[0].length;
    return Math.max(0, Math.round(body.length * 3 / 4) - pad);
  }

  // 优先用资源计时里已有的字节数，避免额外请求
  function attachTimingBytes(list) {
    let entries = [];
    try { entries = performance.getEntriesByType('resource') || []; } catch (e) { /* 忽略 */ }
    const map = Object.create(null);
    entries.forEach((e) => {
      const bytes = e.encodedBodySize || e.transferSize || e.decodedBodySize || 0;
      if (bytes > 0 && e.name) map[e.name] = bytes;
    });
    list.forEach((img) => {
      if (img.bytes) return;
      if (/^data:/i.test(img.url)) { img.bytes = dataUrlBytes(img.url); return; }
      if (map[img.url]) img.bytes = map[img.url];
    });
  }

  // 资源计时拿不到的，用后台 HEAD 取 Content-Length 补齐
  async function probeByteOne(url) {
    if (byteCache[url]) return byteCache[url];
    try {
      const res = await chrome.runtime.sendMessage({ type: 'IMAGE_SIZE', url });
      const bytes = res && Number(res.bytes) > 0 ? Math.round(Number(res.bytes)) : 0;
      if (bytes) byteCache[url] = bytes;
      return bytes;
    } catch (e) { return 0; }
  }

  async function probeMissingBytes(list) {
    const missing = list.filter((img) => !img.bytes).slice(0, 150);
    if (!missing.length) return;
    let changed = false;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, async () => {
      while (next < missing.length) {
        const img = missing[next++];
        const bytes = await probeByteOne(img.url);
        if (bytes) { img.bytes = bytes; changed = true; }
      }
    }));
    if (changed && UI() && UI().isOpen()) notify();
  }

  function rescan() {
    let data;
    try { data = scanAll(); }
    catch (err) { setStatus('扫描出错：' + (err && err.message ? err.message : err), 'error'); return; }
    images = (data.images || []).map((img, i) => { img.order = i; return img; });
    currentUrl = data.url || '';
    title = ((data.title || '') + '\n' + currentUrl).trim();
    site = '';
    try { site = new URL(currentUrl).hostname; } catch (e) { /* 忽略 */ }
    applyFilter();
    attachTimingBytes(images);
    probeMissingSizes(images).catch((err) => console.warn('[图片探查器] 尺寸探测失败', err));
    probeMissingBytes(images).catch((err) => console.warn('[图片探查器] 大小探测失败', err));
    setStatus(images.length
      ? '扫描完成，共找到 ' + images.length + ' 张，符合筛选 ' + filtered.length + ' 张'
      : '未找到图片；可点“加载更多”触发网页懒加载后重扫');
  }

  async function loadMore() {
    if (busy) return;
    busy = true;
    const html = document.documentElement;
    const startY = window.scrollY;
    const prevOverflow = html.style.overflow;
    let error = '';
    try {
      html.style.overflow = 'auto';
      const maxScroll = () => Math.max(0, document.body.scrollHeight - window.innerHeight);
      let before = -1;
      for (let step = 0; step < 30; step++) {
        const y = window.scrollY;
        setStatus('正在滚动网页触发懒加载… ' + (step + 1) + '/30');
        window.scrollTo(0, Math.min(maxScroll(), y + Math.round(window.innerHeight * 0.9)));
        await new Promise((r) => setTimeout(r, 200));
        if (window.scrollY >= maxScroll() - 2 && window.scrollY === before) break;
        before = window.scrollY;
      }
    } catch (err) {
      error = (err && err.message) ? err.message : String(err);
    } finally {
      html.style.overflow = prevOverflow;
      window.scrollTo(0, startY);
      rescan();
      if (error) setStatus('滚动触发失败，已按现有内容重扫：' + error, 'error');
      busy = false;
    }
  }

  // ==================== 下载 ====================

  // ==================== 打包 ====================
  // 后台 Service Worker 不支持 URL.createObjectURL，
  // 因此 ZIP 在页面里用 zip.js 构建，再用临时 <a download> 触发保存。

  const ZIP_EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
    'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/avif': 'avif'
  };

  function fileExt(url, mime) {
    try {
      const m = new URL(url).pathname.match(/\.(jpe?g|png|gif|webp|svg|bmp|ico|avif)$/i);
      if (m) return m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    } catch (e) { /* data URL */ }
    return ZIP_EXT[(mime || '').split(';')[0].trim()] || 'bin';
  }

  function zipEntryName(img, index, mime) {
    let host = 'image';
    try { host = new URL(img.url).hostname || 'image'; } catch (e) { /* data URL */ }
    const dim = img.width && img.height ? '-' + img.width + 'x' + img.height : '';
    const safe = String(host).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60) || 'image';
    return String(index + 1).padStart(3, '0') + '-' + safe + dim + '.' + fileExt(img.url, mime);
  }

  function dataUrlBytes(dataUrl) {
    const at = dataUrl.indexOf(',');
    const meta = dataUrl.slice(0, at);
    const body = dataUrl.slice(at + 1);
    if (!/;base64/i.test(meta)) return new TextEncoder().encode(decodeURIComponent(body));
    const bin = atob(body);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function zipStamp() {
    return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  }

  async function fetchImageBytes(url) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE_BYTES', url });
      return res && res.dataUrl ? res : null;
    } catch (e) { return null; }
  }

  async function buildZip(list) {
    const Zip = globalThis.ZipWriter;
    if (typeof Zip !== 'function') return null;
    const zip = new Zip();
    const used = Object.create(null);
    const total = list.length;
    const BATCH = 5;
    let ok = 0;
    let fail = 0;
    for (let start = 0; start < total; start += BATCH) {
      const batch = list.slice(start, start + BATCH);
      setStatus('正在打包 ' + Math.min(start + BATCH, total) + '/' + total + ' 张…');
      const results = await Promise.all(batch.map((img) => fetchImageBytes(img.url)));
      for (let i = 0; i < batch.length; i++) {
        const res = results[i];
        if (!res) { fail++; continue; }
        let bytes;
        try { bytes = dataUrlBytes(res.dataUrl); } catch (e) { bytes = null; }
        if (!bytes || !bytes.length) { fail++; continue; }
        let name = zipEntryName(batch[i], start + i, res.type);
        if (used[name]) name = (start + i + 1) + '-' + name;
        used[name] = 1;
        zip.addFile(name, bytes);
        ok++;
      }
    }
    return { zip, ok, fail };
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function requestDownload(list, zip) {
    if (busy) { setStatus('已有任务进行中，请稍候'); return { ok: 0, fail: 0, error: 'busy' }; }
    if (!list.length) { setStatus('没有可下载的图片', 'error'); return { ok: 0, fail: 0, error: 'empty' }; }
    busy = true;
    try {
      if (zip) {
        const built = await buildZip(list);
        if (!built) { setStatus('打包组件未加载，请重新加载插件后重试', 'error'); return { ok: 0, fail: list.length, error: 'zip-unavailable' }; }
        if (built.ok) {
          saveBlob(built.zip.build(), 'images-' + zipStamp() + '.zip');
          setStatus('打包完成，共 ' + built.ok + ' 张'
            + (built.fail ? '，' + built.fail + ' 张失败（部分站点有防盗链）' : ''),
            built.fail ? 'error' : 'success');
          return { ok: built.ok, fail: built.fail };
        }
        setStatus('没有成功获取到图片，改为逐张下载…');
      }

      let result;
      try {
        result = await chrome.runtime.sendMessage({
          type: 'DOWNLOAD',
          items: list.map((img) => ({ url: img.url, width: img.width, height: img.height }))
        });
      } catch (err) {
        result = { ok: 0, fail: list.length, error: err && err.message ? err.message : String(err) };
      }

      if (!result) setStatus('下载失败：后台未响应，请在 edge://extensions 重新加载插件', 'error');
      else if (result.error && !result.ok) setStatus('下载失败：' + result.error, 'error');
      else if (result.fail) setStatus('完成：' + result.ok + ' 张成功，' + result.fail + ' 张失败（部分站点有防盗链）', 'error');
      else setStatus('已下载 ' + result.ok + ' 张图片', 'success');
      return result || { ok: 0, fail: list.length, error: 'no-response' };
    } finally {
      busy = false;
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  async function fetchInPage(url) {
    const response = await fetch(url, {
      credentials: 'include', referrer: location.href,
      referrerPolicy: 'no-referrer-when-downgrade'
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return { dataUrl: await blobToDataUrl(await response.blob()) };
  }

  // ==================== Actions ====================

  function setCfg(key, value) {
    if (key === 'scale') cfg.scale = clamp(Number(value) || 1, 0.1, 10);
    else if (key === 'tolerance') cfg.tolerance = clamp(Number(value) || 0.2, 0.05, 0.6);
    else if (key === 'sizeMode') cfg.sizeMode = value === 'gte' || value === 'lte' ? value : 'any';
    else if (key === 'boxW') cfg.boxW = clamp(Number(value) || 10, 10, 400);
    else if (key === 'boxH') cfg.boxH = clamp(Number(value) || 10, 10, 400);
    else return;
    persistCfg();
    applyFilter();
  }

  function setBoxSize(w, h) {
    const nw = clamp(Math.round(w), 10, 400);
    const nh = clamp(Math.round(h), 10, 400);
    if (nw === cfg.boxW && nh === cfg.boxH && cfg.enabled) return;
    cfg.boxW = nw;
    cfg.boxH = nh;
    cfg.enabled = true;
    persistCfg();
    applyFilter();
  }

  function toggleIn(arr, value) {
    const at = arr.indexOf(value);
    if (at >= 0) arr.splice(at, 1); else arr.push(value);
    persistCfg();
    applyFilter();
  }

  const actions = {
    rescan,
    loadMore,
    close: () => { if (UI()) UI().close(); },
    closePopover: () => { if (filterOpen) { filterOpen = false; notify(); } },
    toggleFilter: () => { filterOpen = !filterOpen; notify(); },
    toggleEnabled: () => { cfg.enabled = !cfg.enabled; persistCfg(); applyFilter(); },
    setCfg,
    setBoxSize,
    resetFilter: () => {
      cfg.enabled = DEFAULT_CFG.enabled;
      cfg.boxW = DEFAULT_CFG.boxW;
      cfg.boxH = DEFAULT_CFG.boxH;
      cfg.scale = DEFAULT_CFG.scale;
      cfg.tolerance = DEFAULT_CFG.tolerance;
      cfg.sizeMode = DEFAULT_CFG.sizeMode;
      cfg.formats = [];
      cfg.sources = [];
      persistCfg();
      applyFilter();
    },
    chipFormat: (v) => toggleIn(cfg.formats, v),
    chipSource: (v) => toggleIn(cfg.sources, v),
    selectAll: () => {
      const all = filtered.length > 0 && filtered.every((img) => selected.has(img.url));
      filtered.forEach((img) => { if (all) selected.delete(img.url); else selected.add(img.url); });
      notify();
    },
    toggleSelect: (idx) => {
      const item = layout[idx];
      if (!item) return;
      if (selected.has(item.img.url)) selected.delete(item.img.url);
      else selected.add(item.img.url);
      notify();
    },
    // 下载选中：多张时打成 ZIP，单张直接下载
    downloadSelected: () => {
      const list = filtered.filter((img) => selected.has(img.url));
      return requestDownload(list, list.length > 1);
    },
    // 打包下载 = 当前扫描到的全部图片（不受筛选影响）
    downloadAll: () => requestDownload(images, true),
    downloadOne: (idx) => {
      const item = layout[idx];
      if (item) return requestDownload([item.img], false);
      return Promise.resolve();
    },
    // 裁剪：先在后台抓取图片字节（绕过防盗链/CORS），再交给裁剪器
    fetchImage: (url) => chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url }),
    saveCropped: (dataUrl, filename) => {
      try { return Promise.resolve(saveDataUrl(dataUrl, filename)); }
      catch (err) { return Promise.resolve({ ok: 0, error: String((err && err.message) || err) }); }
    },
    onScroll: (top, height, width) => {
      scrollTop = top || 0;
      viewport = height || 600;
      const measured = Math.round(width || 0);
      if (measured > 0 && Math.abs(measured - canvasWidth) > 4) {
        canvasWidth = measured;
        computeLayout(measured);
        return;
      }
      if (updateVisible()) notify();
    }
  };

  // ==================== 注册 ====================

  const handler = function (msg, sender, sendResponse) {
    if (!msg) return false;
    if (msg.type === 'FETCH_INPAGE') {
      fetchInPage(msg.url).then(sendResponse,
        (err) => sendResponse({ error: String((err && err.message) || err) }));
      return true;
    }
    if (msg.type === 'SAVE_IMAGE_DATA') {
      try { sendResponse(saveDataUrl(msg.dataUrl, msg.filename)); }
      catch (e) { sendResponse({ ok: 0, error: String((e && e.message) || e) }); }
      return false;
    }
    if (msg.type === 'OPEN') {
      try { if (UI()) UI().open(); } catch (e) { console.error('[图片探查器] OPEN 失败', e); }
      sendResponse({ ok: true });
      return false;
    }
    // 备用窗口 popup.js 仍通过这个消息取扫描结果
    if (msg.type === '__IMG_INSPECTOR_SCAN__') {
      try { sendResponse(scanAll()); }
      catch (e) { sendResponse({ error: String((e && e.message) || e) }); }
      return false;
    }
    return false;
  };

  chrome.runtime.onMessage.addListener(handler);
  restoreCfg();
  snapshot = buildSnapshot();

  window.__IMG_INSPECTOR_CONTROLLER__ = {
    getSnapshot: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    actions
  };

  window.__IMG_INSPECTOR_BOOT__ = () => { if (UI()) UI().open(); };

  window.__IMG_INSPECTOR_SESSION__ = {
    version: VERSION,
    dispose: () => {
      try { chrome.runtime.onMessage.removeListener(handler); } catch (e) { /* 忽略 */ }
      try { if (UI()) UI().dispose(); } catch (e) { /* 忽略 */ }
    }
  };
})();
