const grid = document.getElementById('grid');
const countEl = document.getElementById('count');
const statusEl = document.getElementById('status');
const pageTitleEl = document.getElementById('pageTitle');
const hideSmallEl = document.getElementById('hideSmall');
const toggleViewBtn = document.getElementById('toggleView');

let images = [];
let currentUrl = '';
let viewMode = 'grid';
const selected = new Set();

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = kind === 'error'
    ? 'truncate text-[#b06a62]'
    : kind === 'success'
      ? 'truncate text-[#4b8b6a]'
      : 'truncate';
  statusEl.title = text;
}

function setBusy(busy) {
  document.querySelectorAll('button').forEach((btn) => { btn.disabled = busy; });
}

function visibleImages() {
  return images.filter((img) => {
    if (hideSmallEl.checked && img.width && img.height && (img.width < 60 || img.height < 60)) {
      return false;
    }
    return true;
  });
}

function render() {
  const list = visibleImages();
  const isList = viewMode === 'list';
  grid.className = isList ? 'grid grid-cols-1 gap-2.5' : 'grid grid-cols-3 gap-4';
  grid.innerHTML = '';
  countEl.textContent = list.length + ' 张';

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'col-span-full flex flex-col items-center justify-center py-24 text-center';
    const icon = document.createElement('div');
    icon.className = 'mb-6 text-[#d2d2d7]';
    icon.innerHTML = '<svg viewBox="0 0 48 48" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="10" width="34" height="28" rx="3"/><circle cx="17" cy="20" r="3"/><path d="M7 33l10-9 7 6 7-8 10 11"/></svg>';
    const label = document.createElement('div');
    label.className = 'text-[14px] font-medium text-ink';
    label.textContent = '没有找到图片';
    const rescan = document.createElement('button');
    rescan.className = 'mt-7 inline-flex h-9 items-center gap-1.5 rounded-control bg-accent px-4 text-[12px] text-white transition-colors hover:bg-[#0071eb]';
    rescan.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6"/><path d="M16.5 3.5v4h-4"/></svg>重新扫描';
    rescan.addEventListener('click', scan);
    const tip = document.createElement('div');
    tip.className = 'mt-6 max-w-[380px] text-[11px] leading-[1.9] text-subtle';
    tip.textContent = '当前页面：' + (currentUrl || '未知') + '。部分网站图片需滚动后才加载，可滚动到页面底部再重新扫描。';
    empty.appendChild(icon);
    empty.appendChild(label);
    empty.appendChild(rescan);
    empty.appendChild(tip);
    grid.appendChild(empty);
    return;
  }

  for (const img of list) {
    const originalIndex = images.indexOf(img);
    const chosen = selected.has(img.url);
    const card = document.createElement('div');
    card.className = 'relative flex overflow-hidden rounded-card bg-white transition-colors hover:border-black/[0.12] '
      + (chosen ? 'border-accent ring-2 ring-accent/15' : 'border-black/[0.06]')
      + (isList ? ' flex-row items-center pr-2.5' : ' flex-col');

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'sf-check z-10 ' + (isList ? 'left-3 top-1/2 -translate-y-1/2' : 'left-2.5 top-2.5');
    check.checked = chosen;
    check.addEventListener('change', () => {
      if (check.checked) selected.add(img.url);
      else selected.delete(img.url);
      card.classList.toggle('border-accent', check.checked);
      card.classList.toggle('ring-2', check.checked);
      card.classList.toggle('ring-accent/15', check.checked);
      updateSelectAllLabel();
    });
    card.appendChild(check);

    const thumb = document.createElement('div');
    thumb.className = isList
      ? 'flex h-14 w-20 shrink-0 items-center justify-center overflow-hidden bg-canvas'
      : 'flex h-24 items-center justify-center overflow-hidden bg-canvas';
    const preview = document.createElement('img');
    preview.src = img.url;
    preview.loading = 'lazy';
    preview.alt = '';
    preview.className = 'block max-h-full max-w-full object-contain';
    preview.addEventListener('error', () => preview.classList.add('opacity-20'));
    thumb.appendChild(preview);
    card.appendChild(thumb);

    const meta = document.createElement('div');
    meta.className = isList
      ? 'min-w-0 flex-1 px-4 py-2.5 text-[11px] leading-[1.5]'
      : 'min-w-0 flex-1 px-3 pb-9 pt-2.5 text-[11px] leading-[1.5]';
    const dim = document.createElement('span');
    dim.className = 'block truncate text-subtle';
    dim.textContent = img.width && img.height ? `${img.width} × ${img.height} · ${img.source}` : img.source;
    meta.appendChild(dim);
    const src = document.createElement('span');
    src.className = 'mt-0.5 block truncate text-[10px] text-[#aeaeb2]';
    let host = img.url;
    try { host = new URL(img.url).hostname || img.url; } catch (e) { /* data URL */ }
    src.textContent = host;
    src.title = img.url;
    meta.appendChild(src);
    card.appendChild(meta);

    const dl = document.createElement('button');
    dl.className = 'h-6 shrink-0 rounded-[7px] border border-black/[0.06] bg-white px-2.5 text-[10px] text-ink transition-colors hover:bg-canvas '
      + (isList ? '' : 'absolute bottom-2.5 right-2.5 bg-white/95');
    dl.textContent = '下载';
    dl.title = '下载这张图片';
    dl.addEventListener('click', async () => {
      setBusy(true);
      setStatus('正在下载...');
      const ok = await downloadOne(img, originalIndex);
      setStatus(ok ? '已下载 1 张图片' : '下载失败，请检查网络或站点限制', ok ? 'success' : 'error');
      setBusy(false);
    });
    card.appendChild(dl);

    grid.appendChild(card);
  }
  updateSelectAllLabel();
}

function updateSelectAllLabel() {
  const list = visibleImages();
  const allSelected = list.length > 0 && list.every((img) => selected.has(img.url));
  document.getElementById('selectAll').textContent = allSelected ? '取消全选' : '全选';
}

// 该函数会被序列化注入到标签页（含所有 iframe）中执行，不能引用外部变量。
function scanPage() {
  function abs(u) {
    if (!u) return '';
    u = String(u).trim();
    if (/^(data|blob|chrome-extension):/i.test(u)) return u;
    if (/^\/\//.test(u)) u = location.protocol + u;
    try { return new URL(u, location.href).href; } catch (e) { return u; }
  }

  function srcsetCandidates(s) {
    if (!s) return [];
    return s.split(',').map(function (part) {
      return part.trim().split(/\s+/)[0];
    }).filter(Boolean);
  }

  function bgUrls(el) {
    let bg = '';
    try { bg = getComputedStyle(el).backgroundImage || ''; } catch (e) { return []; }
    const re = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)]*))\s*\)/g;
    const out = [];
    let m;
    while ((m = re.exec(bg)) !== null) {
      const u = m[1] || m[2] || m[3];
      if (u) out.push(u.trim());
    }
    return out;
  }

  const results = [];
  const seen = Object.create(null);

  function add(u, source, width, height) {
    if (!u) return;
    const full = abs(u);
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
  walk(document.documentElement || document);

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    const tag = el.tagName.toLowerCase();

    if (tag === 'img') {
      const ss = srcsetCandidates(el.getAttribute('srcset'));
      const candidates = [
        el.currentSrc,
        el.src,
        ss.length ? ss[ss.length - 1] : '',
        el.getAttribute('data-src'),
        el.getAttribute('data-original'),
        el.getAttribute('data-lazy-src'),
        el.getAttribute('data-echo'),
        el.getAttribute('data-url'),
        el.getAttribute('data-image'),
        el.getAttribute('data-full'),
        el.getAttribute('data-large'),
        el.getAttribute('data-href')
      ];
      for (let j = 0; j < candidates.length; j++) {
        if (candidates[j]) {
          add(candidates[j], 'img', el.naturalWidth, el.naturalHeight);
          break;
        }
      }
    } else if (tag === 'source') {
      srcsetCandidates(el.getAttribute('srcset')).forEach(function (u) { add(u, 'picture'); });
    } else if (tag === 'link') {
      const rel = (el.getAttribute('rel') || '').toLowerCase();
      const as = (el.getAttribute('as') || '').toLowerCase();
      if (rel === 'icon' || rel === 'apple-touch-icon' || rel === 'apple-touch-icon-precomposed' ||
          rel === 'image_src' || (rel === 'preload' && as === 'image')) {
        add(el.href, 'link');
      }
    } else if (tag === 'meta') {
      const key = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
      if (key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url' ||
          key === 'twitter:image' || key === 'twitter:image:src' ||
          key === 'thumbnail' || key === 'msapplication-tileimage') {
        add(el.content, 'meta');
      }
    } else if (tag === 'image') {
      add(el.getAttribute('href') || el.getAttribute('xlink:href'), 'svg');
    } else if (tag === 'input' && el.type === 'image') {
      add(el.src, 'input');
    }

    bgUrls(el).forEach(function (u) { add(u, 'background'); });

    const style = el.getAttribute('style') || '';
    if (/background-image/i.test(style)) {
      const probe = document.createElement('div');
      probe.style.cssText = style;
      bgUrls(probe).forEach(function (u) { add(u, 'background'); });
    }
  }

  return { images: results, title: document.title, url: location.href };
}

async function scan() {
  setBusy(true);
  setStatus('正在扫描页面...');
  try {
    const tabIdParam = new URLSearchParams(location.search).get('tabId');
    let tab = null;
    try {
      tab = tabIdParam
        ? await chrome.tabs.get(Number(tabIdParam))
        : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    } catch (e) {
      tab = null;
    }
    if (!tab || !tab.id) throw new Error('来源网页已关闭，请回到网页重新点击插件图标');

    const tabUrl = tab.url || tab.pendingUrl || '';
    if (/^(edge|chrome|about|devtools|view-source|chrome-extension):/i.test(tabUrl)) {
      throw new Error('浏览器内部页面无法扫描，请打开普通网页后重试');
    }

    let data;
    try {
      data = await chrome.tabs.sendMessage(tab.id, { type: '__IMG_INSPECTOR_SCAN__' }, { frameId: 0 });
    } catch (e) {
      throw new Error('该网页无法显示面板。若是刚安装或更新插件，请刷新网页后重试；浏览器内置页面、扩展商店等页面不支持。');
    }
    if (!data) throw new Error('网页未返回扫描结果，请刷新网页后重试');
    if (data.error) throw new Error('扫描出错：' + data.error);
    const merged = [];
    const seen = Object.create(null);
    (data.images || []).forEach(function (img) {
      if (!img || !img.url || seen[img.url]) return;
      seen[img.url] = 1;
      merged.push(img);
    });
    const title = data.title || '';
    const pageUrl = data.url && !/^about:blank/i.test(data.url) ? data.url : tabUrl;

    images = merged;
    selected.clear();
    currentUrl = pageUrl;
    try { pageTitleEl.textContent = new URL(pageUrl).hostname; } catch (e) { pageTitleEl.textContent = ''; }
    pageTitleEl.title = (title ? title + '\n' : '') + pageUrl;
    render();
    setStatus(images.length
      ? `扫描完成，共找到 ${images.length} 张图片`
      : '扫描完成，未找到图片；部分网站需滚动页面后图片才加载，可重新扫描');
  } catch (err) {
    images = [];
    currentUrl = '';
    render();
    setStatus('扫描失败：' + (err && err.message ? err.message : err), 'error');
  } finally {
    setBusy(false);
  }
}

async function fetchImage(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const blob = await response.blob();
  if (!blob || blob.size < 20) throw new Error('空图片');
  if (/^text\/html/i.test(blob.type)) throw new Error('返回内容不是图片');
  return blob;
}

function safeName(text) {
  return String(text).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60) || 'image';
}

function extensionOf(url, mime) {
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.(jpe?g|png|gif|webp|svg|bmp|ico|avif)$/i);
    if (match) {
      const ext = match[1].toLowerCase();
      return ext === 'jpeg' ? 'jpg' : ext;
    }
  } catch (e) { /* data URL */ }
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
    'image/x-icon': 'ico', 'image/avif': 'avif'
  };
  return (mime && map[mime.split(';')[0].trim()]) || 'bin';
}

function filenameOf(img, index, mime) {
  let host = 'image';
  try { host = new URL(img.url).hostname || 'image'; } catch (e) { /* data URL */ }
  const dim = img.width && img.height ? `-${img.width}x${img.height}` : '';
  const number = String(index + 1).padStart(3, '0');
  return `${number}-${safeName(host)}${dim}.${extensionOf(img.url, mime)}`;
}

async function downloadOne(img, index) {
  try {
    const blob = await fetchImage(img.url);
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url,
      filename: filenameOf(img, index, blob.type),
      conflictAction: 'uniquify',
      saveAs: false
    });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return true;
  } catch (e) {
    try {
      await chrome.downloads.download({
        url: img.url,
        filename: filenameOf(img, index, ''),
        conflictAction: 'uniquify',
        saveAs: false
      });
      return true;
    } catch (e2) {
      return false;
    }
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await mapper(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function timestamp() {
  return new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
}

async function downloadZip(list) {
  if (typeof ZipWriter === 'undefined') {
    setStatus('打包组件未加载，请重新安装插件', 'error');
    return;
  }
  setBusy(true);
  setStatus(`正在获取 ${list.length} 张图片...`);
  const fetched = await mapLimit(list, 6, (img) => fetchImage(img.url));

  const zip = new ZipWriter();
  const used = Object.create(null);
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < fetched.length; i++) {
    const result = fetched[i];
    if (!result.ok) { fail++; continue; }
    const blob = result.value;
    let name = filenameOf(list[i], i, blob.type);
    if (used[name]) name = `${i + 1}-${name}`;
    used[name] = 1;
    zip.addFile(name, new Uint8Array(await blob.arrayBuffer()));
    ok++;
    if (i % 5 === 0) setStatus(`正在打包 ${i + 1}/${list.length} ...`);
  }

  if (!ok) {
    setStatus('所有图片均获取失败，未生成压缩包', 'error');
    setBusy(false);
    return;
  }

  setStatus('正在生成 ZIP...');
  const zipBlob = zip.build();
  const url = URL.createObjectURL(zipBlob);
  try {
    await chrome.downloads.download({
      url,
      filename: `images-${timestamp()}.zip`,
      conflictAction: 'uniquify',
      saveAs: false
    });
    setStatus(`打包完成：${ok} 张成功${fail ? `，${fail} 张失败` : ''}`, fail ? '' : 'success');
  } catch (err) {
    setStatus('保存压缩包失败：' + (err && err.message ? err.message : err), 'error');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setBusy(false);
  }
}

function bindEvents() {
  document.getElementById('refresh').addEventListener('click', scan);

  document.getElementById('selectAll').addEventListener('click', () => {
    const list = visibleImages();
    const allSelected = list.length > 0 && list.every((img) => selected.has(img.url));
    list.forEach((img) => {
      if (allSelected) selected.delete(img.url);
      else selected.add(img.url);
    });
    render();
  });

  document.getElementById('downloadSelected').addEventListener('click', async () => {
    const chosen = visibleImages().filter((img) => selected.has(img.url));
    if (!chosen.length) { setStatus('请先勾选要下载的图片', 'error'); return; }
    setBusy(true);
    setStatus(`正在下载 ${chosen.length} 张图片...`);
    const results = await mapLimit(chosen, 4, (img) => downloadOne(img, images.indexOf(img)));
    const ok = results.filter((r) => r.ok).length;
    setStatus(`已下载 ${ok}/${chosen.length} 张图片`, ok === chosen.length ? 'success' : 'error');
    setBusy(false);
  });

  document.getElementById('downloadAll').addEventListener('click', () => {
    const list = visibleImages();
    if (!list.length) { setStatus('没有可下载的图片', 'error'); return; }
    downloadZip(list);
  });

  hideSmallEl.addEventListener('change', render);

  toggleViewBtn.addEventListener('click', () => {
    viewMode = viewMode === 'grid' ? 'list' : 'grid';
    toggleViewBtn.textContent = viewMode === 'list' ? '网格' : '列表';
    render();
  });
}

bindEvents();
scan();
