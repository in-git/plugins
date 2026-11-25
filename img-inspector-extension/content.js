(function () {
  if (window.__IMG_INSPECTOR_LOADED__) return;
  window.__IMG_INSPECTOR_LOADED__ = true;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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
    return s.split(',').map(function (part) {
      return part.trim().split(/\s+/)[0];
    }).filter(Boolean);
  }

  function bgUrls(el, view) {
    var bg = '';
    try { bg = view.getComputedStyle(el).backgroundImage || ''; } catch (e) { return []; }
    var re = /url\(\s*(?:'([^']*)'|"([^"]*)"|([^)]*))\s*\)/g;
    var out = [];
    var m;
    while ((m = re.exec(bg)) !== null) {
      var u = m[1] || m[2] || m[3];
      if (u) out.push(u.trim());
    }
    return out;
  }

  function scanDoc(doc) {
    var view = doc.defaultView;
    var base = doc.baseURI || (doc.location && doc.location.href) || location.href;
    var results = [];
    var seen = Object.create(null);

    function add(u, source, width, height) {
      if (!u) return;
      var full = abs(u, base);
      if (!full || seen[full]) return;
      if (/^data:/i.test(full) && full.length < 100) return;
      seen[full] = 1;
      results.push({ url: full, source: source || 'img', width: width || 0, height: height || 0 });
    }

    var elements = [];
    function walk(root) {
      var all;
      try { all = root.querySelectorAll('*'); } catch (e) { return; }
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        elements.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    }
    walk(doc.documentElement || doc);

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var tag = String(el.tagName || '').toLowerCase();

      if (tag === 'img') {
        var ss = srcsetCandidates(el.getAttribute('srcset'));
        var candidates = [
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
        for (var j = 0; j < candidates.length; j++) {
          if (candidates[j]) {
            add(candidates[j], 'img', el.naturalWidth, el.naturalHeight);
            break;
          }
        }
      } else if (tag === 'source') {
        srcsetCandidates(el.getAttribute('srcset')).forEach(function (u) { add(u, 'picture'); });
      } else if (tag === 'link') {
        var rel = (el.getAttribute('rel') || '').toLowerCase();
        var as = (el.getAttribute('as') || '').toLowerCase();
        if (rel === 'icon' || rel === 'apple-touch-icon' || rel === 'apple-touch-icon-precomposed' ||
            rel === 'image_src' || (rel === 'preload' && as === 'image')) {
          add(el.href, 'link');
        }
      } else if (tag === 'meta') {
        var key = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
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

      bgUrls(el, view).forEach(function (u) { add(u, 'background'); });

      var style = el.getAttribute('style') || '';
      if (/background-image/i.test(style)) {
        var probe = doc.createElement('div');
        probe.style.cssText = style;
        bgUrls(probe, view).forEach(function (u) { add(u, 'background'); });
      }
    }

    return { images: results, title: doc.title || '', url: base };
  }

  function scanAll() {
    var main = scanDoc(document);
    var merged = [];
    var seen = Object.create(null);

    function push(data) {
      (data.images || []).forEach(function (img) {
        if (!img.url || seen[img.url]) return;
        seen[img.url] = 1;
        merged.push(img);
      });
    }

    push(main);
    try {
      document.querySelectorAll('iframe,frame').forEach(function (frame) {
        var doc;
        try { doc = frame.contentDocument; } catch (e) { doc = null; }
        if (doc && doc.documentElement) push(scanDoc(doc));
      });
    } catch (e) { /* 忽略无法访问的框架 */ }

    return { images: merged, title: main.title, url: main.url };
  }

  // ==================== 面板结构 ====================

  const REFRESH_SVG = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6"/><path d="M16.5 3.5v4h-4"/></svg>';
  const CLOSE_SVG = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M5 5l10 10M15 5L5 15"/></svg>';
  const CHECK_SVG = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>';
  const EMPTY_SVG = '<svg viewBox="0 0 48 48" width="46" height="46" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="10" width="34" height="28" rx="3"/><circle cx="17" cy="20" r="3"/><path d="M7 33l10-9 7 6 7-8 10 11"/></svg>';

  const MARKUP = `
<div data-el="overlay" class="fixed inset-0 flex items-center justify-center bg-canvas/70 backdrop-blur-[3px]">
  <div class="ii-panel flex flex-col overflow-hidden rounded-modal bg-white font-sans text-ink antialiased shadow-[0_24px_80px_-16px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.03)]">
    <header class="flex shrink-0 items-center justify-between px-9 pb-5 pt-7">
      <div class="flex items-baseline gap-3">
        <h1 class="text-[17px] font-semibold tracking-[-0.01em] text-ink">图片探查器</h1>
        <span data-el="site" class="max-w-[260px] truncate text-[11px] text-[#b8b8bd]"></span>
      </div>
      <div class="flex items-center gap-3">
        <span data-el="count" class="rounded-full bg-canvas px-3 py-1 text-[11px] tracking-wide text-subtle">0 张</span>
        <button data-el="close" title="关闭 (Esc)" class="ii-close">${CLOSE_SVG}</button>
      </div>
    </header>

    <div class="flex shrink-0 flex-wrap items-center gap-2 px-9 pb-6">
      <input data-el="q" type="search" placeholder="搜索图片地址" class="ii-input w-[190px]">
      <input data-el="minW" type="number" min="0" placeholder="最小宽" title="最小宽度" class="ii-input w-[82px]">
      <input data-el="minH" type="number" min="0" placeholder="最小高" title="最小高度" class="ii-input w-[82px]">
      <select data-el="format" title="图片格式" class="ii-input w-[92px]">
        <option value="all">全部格式</option>
        <option value="jpg">JPG</option>
        <option value="png">PNG</option>
        <option value="webp">WebP</option>
        <option value="gif">GIF</option>
        <option value="svg">SVG</option>
        <option value="other">其他</option>
      </select>
      <select data-el="sort" title="排序方式" class="ii-input w-[106px]">
        <option value="page">页面顺序</option>
        <option value="area">面积最大</option>
        <option value="width">宽度最大</option>
        <option value="height">高度最大</option>
        <option value="format">按格式</option>
      </select>
      <button data-el="loadMore" title="滚动网页触发懒加载后重新扫描" class="ii-btn">${REFRESH_SVG}加载更多</button>
      <span class="flex-1"></span>
      <button data-el="selectAll" class="ii-btn">全选</button>
      <button data-el="downloadSelected" class="ii-btn">下载选中</button>
      <button data-el="downloadAll" class="ii-btn-primary">打包下载</button>
    </div>

    <main data-el="scroll" class="ii-scroll min-h-0 flex-1 overflow-y-auto px-9 pb-8">
      <div data-el="canvas" class="relative w-full"></div>
    </main>

    <footer class="flex shrink-0 items-center justify-between gap-4 border-t border-black/[0.05] px-9 py-4 text-[11px] text-subtle">
      <span data-el="status" class="truncate">准备就绪</span>
      <span class="shrink-0 text-[#b8b8bd]">点击卡片选择 · 每张可单独下载 · Esc 关闭</span>
    </footer>
  </div>
</div>`;

  // ==================== 状态 ====================

  let host = null;
  let root = null;
  let refs = {};
  let savedOverflow = null;

  let images = [];
  let filtered = [];
  let layout = [];
  let currentUrl = '';
  let canvasHeight = 0;
  let rafPending = false;
  let isBusyScroll = false;
  let isDownloading = false;
  const selected = new Set();
  const mounted = new Map();

  const GAP = 16;
  const CARD_MIN = 210;
  const INFO_H = 42;
  const BUFFER = 700;
  const PAD = 10;

  function el(name) { return refs[name]; }
  function isOpen() { return !!host && host.style.display !== 'none'; }

  function setStatus(text, kind) {
    const node = el('status');
    if (!node) return;
    node.textContent = text;
    node.className = kind === 'error'
      ? 'truncate text-[#b06a62]'
      : kind === 'success'
        ? 'truncate text-[#4b8b6a]'
        : 'truncate';
    node.title = text;
  }

  function setBusy(busy) {
    if (!root) return;
    root.querySelectorAll('button').forEach((btn) => {
      if (btn !== el('close')) btn.disabled = busy;
    });
  }

  function extOf(url) {
    try {
      const m = new URL(url).pathname.match(/\.(jpe?g|png|gif|webp|svg|bmp|ico|avif)$/i);
      if (!m) return 'other';
      const ext = m[1].toLowerCase();
      return ext === 'jpeg' ? 'jpg' : ext;
    } catch (e) { return 'other'; }
  }

  function hostOf(url) {
    try { return new URL(url).hostname || url; } catch (e) { return url; }
  }

  // ==================== 面板生命周期 ====================

  function ensurePanel() {
    if (host && root) return;
    host = document.createElement('div');
    host.id = '__img_inspector_host__';
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;display:none;';
    const shadow = host.attachShadow({ mode: 'closed' });

    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(globalThis.__IMG_INSPECTOR_CSS__ || '');
      shadow.adoptedStyleSheets = [sheet];
    } catch (e) {
      const style = document.createElement('style');
      style.textContent = globalThis.__IMG_INSPECTOR_CSS__ || '';
      shadow.appendChild(style);
    }

    const tpl = document.createElement('template');
    tpl.innerHTML = MARKUP;
    root = tpl.content.firstElementChild;
    shadow.appendChild(root);
    // querySelectorAll 不含根节点本身，overlay 必须显式注册，
    // 否则 el('overlay') 为 undefined 会抛错并中断后续所有事件绑定。
    refs = { overlay: root };
    root.querySelectorAll('[data-el]').forEach((node) => { refs[node.getAttribute('data-el')] = node; });

    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    el('close').addEventListener('click', close);

    ['q', 'minW', 'minH', 'format', 'sort'].forEach((key) => {
      const node = el(key);
      node.addEventListener(node.tagName === 'SELECT' ? 'change' : 'input', debounce(() => applyAndRender(true), 160));
    });

    el('loadMore').addEventListener('click', loadMore);
    el('selectAll').addEventListener('click', () => {
      const all = filtered.length > 0 && filtered.every((img) => selected.has(img.url));
      filtered.forEach((img) => { if (all) selected.delete(img.url); else selected.add(img.url); });
      syncVisibleSelection();
      updateCounts();
    });
    el('downloadSelected').addEventListener('click', () => {
      const chosen = filtered.filter((img) => selected.has(img.url));
      if (!chosen.length) { setStatus('请先点击卡片选择图片', 'error'); return; }
      requestDownload(chosen, false);
    });
    el('downloadAll').addEventListener('click', () => {
      if (!filtered.length) { setStatus('当前筛选结果为空', 'error'); return; }
      requestDownload(filtered, true);
    });

    el('scroll').addEventListener('scroll', () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; renderVisible(); });
    }, { passive: true });

    const onResize = debounce(() => {
      if (!isOpen()) return;
      applyPanelSize();
      clearMounted();
      computeLayout();
    }, 140);
    window.addEventListener('resize', onResize);
  }

  // 按真实视口高度精确设置为 80%，并在窗口尺寸变化后重算。
  // CSS 的 80vh 已作为兜底，这里覆盖为像素值以避免 vh 在特殊视口下偏差。
  function applyPanelSize() {
    if (!root) return;
    const panel = root.querySelector('.ii-panel');
    if (!panel) return;
    const h = Math.round(window.innerHeight * 0.8);
    panel.style.height = h + 'px';
    panel.style.minHeight = h + 'px';
    panel.style.maxHeight = h + 'px';
  }

  function debounce(fn, ms) {
    let timer = null;
    return function () { clearTimeout(timer); timer = setTimeout(fn, ms); };
  }

  function open() {
    try {
      ensurePanel();
      if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
      if (!isOpen() && savedOverflow === null) {
        savedOverflow = document.documentElement.style.overflow;
        document.documentElement.style.overflow = 'hidden';
      }
      host.style.display = 'block';
      applyPanelSize();
      refresh();
    } catch (e) {
      console.error('[图片探查器] 打开面板失败', e);
      setStatus('面板初始化失败：' + (e && e.message ? e.message : e), 'error');
      // 初始化失败后允许下次点击重新构建，避免一次异常导致永久失效
      if (host && host.parentNode) host.remove();
      host = null;
      root = null;
      refs = {};
      savedOverflow = null;
      throw e;
    }
  }

  function close() {
    if (!isOpen()) return;
    host.style.display = 'none';
    if (savedOverflow !== null) {
      document.documentElement.style.overflow = savedOverflow;
      savedOverflow = null;
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close();
  }, true);

  // ==================== 扫描 / 筛选 ====================

  function refresh() {
    let data;
    try {
      data = scanAll();
    } catch (e) {
      setStatus('扫描出错：' + (e && e.message ? e.message : e), 'error');
      return;
    }
    images = (data.images || []).map((img, i) => {
      img.order = i;
      return img;
    });
    // 重扫后保留仍然存在的选中项
    const urls = new Set(images.map((img) => img.url));
    Array.from(selected).forEach((u) => { if (!urls.has(u)) selected.delete(u); });

    currentUrl = data.url || '';
    el('site').textContent = '';
    try { el('site').textContent = new URL(currentUrl).hostname; } catch (e) { /* 忽略 */ }
    el('site').title = ((data.title || '') + '\n' + currentUrl).trim();

    applyAndRender(false);
    setStatus(images.length
      ? '扫描完成，共找到 ' + images.length + ' 张图片'
      : '未找到图片；可点“加载更多”触发网页懒加载后重扫');
  }

  // 滚动网页到底部触发懒加载，然后回到原位重新扫描
  async function loadMore() {
    if (isBusyScroll) return;
    isBusyScroll = true;
    setBusy(true);
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
        await sleep(200);
        if (window.scrollY >= maxScroll() - 2 && window.scrollY === before) break;
        before = window.scrollY;
      }
    } catch (e) {
      error = (e && e.message) ? e.message : String(e);
    } finally {
      html.style.overflow = prevOverflow;
      window.scrollTo(0, startY);
      refresh();
      if (error) setStatus('滚动触发失败，已按现有内容重扫：' + error, 'error');
      setBusy(false);
      isBusyScroll = false;
    }
  }

  function applyFilters() {
    const q = el('q').value.trim().toLowerCase();
    const minW = Number(el('minW').value) || 0;
    const minH = Number(el('minH').value) || 0;
    const fmt = el('format').value;
    const sort = el('sort').value;

    const list = images.filter((img) => {
      if (q && img.url.toLowerCase().indexOf(q) < 0) return false;
      if (minW && (!img.width || img.width < minW)) return false;
      if (minH && (!img.height || img.height < minH)) return false;
      if (fmt !== 'all') {
        const ext = extOf(img.url);
        if (fmt === 'other') {
          if (['jpg', 'png', 'webp', 'gif', 'svg'].indexOf(ext) >= 0) return false;
        } else if (ext !== fmt) return false;
      }
      return true;
    });

    if (sort === 'area') list.sort((a, b) => (b.width * b.height) - (a.width * a.height));
    else if (sort === 'width') list.sort((a, b) => b.width - a.width);
    else if (sort === 'height') list.sort((a, b) => b.height - a.height);
    else if (sort === 'format') list.sort((a, b) => extOf(a.url).localeCompare(extOf(b.url)) || a.order - b.order);
    else list.sort((a, b) => a.order - b.order);

    return list;
  }

  function updateCounts() {
    const chosen = filtered.reduce((n, img) => n + (selected.has(img.url) ? 1 : 0), 0);
    el('count').textContent = filtered.length + ' 张 · 已选 ' + chosen;
    const all = filtered.length > 0 && filtered.every((img) => selected.has(img.url));
    el('selectAll').textContent = all ? '取消全选' : '全选';
  }

  function applyAndRender(resetScroll) {
    filtered = applyFilters();
    updateCounts();
    clearMounted();
    if (resetScroll) el('scroll').scrollTop = 0;
    computeLayout();
  }

  // ==================== 瀑布流（贪心分列 + 虚拟渲染） ====================

  // 有真实尺寸时按原比例；没有尺寸信息的资源用确定性序列占位，
  // 图片本身始终 object-fit: contain，不会被拉伸或裁切。
  function ratioOf(img, i) {
    if (img.width && img.height) return clamp(img.width / img.height, 0.3, 3.5);
    const seq = [0.78, 1, 1.28, 0.9, 1.45, 0.82, 1.12];
    return seq[i % seq.length];
  }

  function clearMounted() {
    mounted.forEach((node) => node.remove());
    mounted.clear();
    const canvas = el('canvas');
    canvas.replaceChildren();
  }

  function computeLayout() {
    const canvas = el('canvas');
    const scroller = el('scroll');
    const width = Math.max(240, Math.round(canvas.clientWidth || scroller.clientWidth - 72 || 800));
    const cols = clamp(Math.floor((width + GAP) / (CARD_MIN + GAP)), 2, 8);
    const colWidth = Math.floor((width - GAP * (cols - 1)) / cols);
    const innerWidth = colWidth - PAD * 2;
    const heights = new Array(cols).fill(0);

    layout = filtered.map((img, i) => {
      // 高度按内容宽度 ÷ 真实宽高比计算，图片完整显示不裁切
      const imgH = Math.round(innerWidth / ratioOf(img, i));
      const h = PAD + imgH + INFO_H + PAD;
      let c = 0;
      for (let k = 1; k < cols; k++) if (heights[k] < heights[c]) c = k;
      const item = { img, index: i, left: c * (colWidth + GAP), top: heights[c], width: colWidth, imgH, height: h };
      heights[c] += h + GAP;
      return item;
    });

    canvasHeight = Math.max(0, Math.max.apply(null, heights) - GAP);
    canvas.style.height = filtered.length ? canvasHeight + 'px' : 'auto';

    if (!filtered.length) {
      renderEmpty();
      return;
    }
    renderVisible();
  }

  function renderEmpty() {
    const wrap = document.createElement('div');
    wrap.className = 'ii-empty';
    const icon = document.createElement('div');
    icon.className = 'mb-6 text-[#d2d2d7]';
    icon.innerHTML = EMPTY_SVG;
    const title = document.createElement('div');
    title.className = 'text-[14px] font-medium text-ink';
    title.textContent = images.length ? '没有符合筛选条件的图片' : '没有找到图片';
    const tip = document.createElement('div');
    tip.className = 'mt-3 max-w-[420px] text-[11px] leading-[1.9] text-subtle';
    tip.textContent = images.length
      ? '试着放宽尺寸或格式条件，或清空搜索关键词。'
      : '当前页面：' + (currentUrl || '未知') + '。部分网站图片需滚动后才加载，可点“加载更多”后重扫。';
    const rescan = document.createElement('button');
    rescan.className = 'ii-btn-primary mt-7';
    rescan.innerHTML = REFRESH_SVG + '重新扫描';
    rescan.addEventListener('click', refresh);
    wrap.appendChild(icon);
    wrap.appendChild(title);
    wrap.appendChild(tip);
    wrap.appendChild(rescan);
    el('canvas').appendChild(wrap);
  }

  function renderVisible() {
    const scroller = el('scroll');
    const viewport = scroller.clientHeight || 600;
    const from = scroller.scrollTop - BUFFER;
    const to = scroller.scrollTop + viewport + BUFFER;
    const need = new Set();

    for (let i = 0; i < layout.length; i++) {
      const item = layout[i];
      if (item.top + item.height >= from && item.top <= to) need.add(i);
    }

    mounted.forEach((node, idx) => {
      if (!need.has(idx)) { node.remove(); mounted.delete(idx); }
    });

    need.forEach((idx) => {
      if (mounted.has(idx)) return;
      const node = createCard(layout[idx]);
      el('canvas').appendChild(node);
      mounted.set(idx, node);
    });
  }

  function createCard(item) {
    const img = item.img;
    const card = document.createElement('div');
    card.className = 'ii-card' + (selected.has(img.url) ? ' is-selected' : '');
    card.style.left = item.left + 'px';
    card.style.top = item.top + 'px';
    card.style.width = item.width + 'px';
    card.style.height = item.height + 'px';

    const media = document.createElement('div');
    media.className = 'ii-media';
    media.style.height = item.imgH + 'px';
    const preview = document.createElement('img');
    preview.className = 'ii-img';
    preview.alt = '';
    preview.loading = 'lazy';
    preview.decoding = 'async';
    preview.src = img.url;
    preview.addEventListener('load', () => preview.classList.add('is-loaded'));
    preview.addEventListener('error', () => { preview.remove(); media.classList.add('is-broken'); });
    media.appendChild(preview);
    card.appendChild(media);

    const pick = document.createElement('button');
    pick.className = 'ii-pick' + (selected.has(img.url) ? ' is-on' : '');
    pick.title = '选择这张图片';
    pick.innerHTML = CHECK_SVG;
    pick.addEventListener('click', (e) => { e.stopPropagation(); toggleSelect(img, card, pick); });
    card.appendChild(pick);

    const info = document.createElement('div');
    info.style.height = INFO_H + 'px';
    info.className = 'ii-info';
    const dim = document.createElement('span');
    dim.className = 'ii-dim';
    dim.textContent = img.width && img.height ? img.width + ' × ' + img.height : img.source;
    const name = document.createElement('span');
    name.className = 'ii-host';
    name.textContent = hostOf(img.url);
    name.title = img.url;
    const dl = document.createElement('button');
    dl.className = 'ii-dl';
    dl.textContent = '下载';
    dl.addEventListener('click', (e) => { e.stopPropagation(); requestDownload([img], false); });
    info.appendChild(dim);
    info.appendChild(name);
    info.appendChild(dl);
    card.appendChild(info);

    card.addEventListener('click', () => toggleSelect(img, card, pick));
    return card;
  }

  function toggleSelect(img, card, pick) {
    if (selected.has(img.url)) selected.delete(img.url);
    else selected.add(img.url);
    const on = selected.has(img.url);
    card.classList.toggle('is-selected', on);
    pick.classList.toggle('is-on', on);
    updateCounts();
  }

  function syncVisibleSelection() {
    mounted.forEach((node, idx) => {
      const img = layout[idx] && layout[idx].img;
      if (!img) return;
      const on = selected.has(img.url);
      node.classList.toggle('is-selected', on);
      const pick = node.querySelector('.ii-pick');
      if (pick) pick.classList.toggle('is-on', on);
    });
    updateCounts();
  }

  // ==================== 下载 ====================

  async function requestDownload(list, zip) {
    if (isDownloading) { setStatus('已有下载任务进行中，请稍候'); return; }
    if (!list.length) { setStatus('没有可下载的图片', 'error'); return; }
    isDownloading = true;
    setBusy(true);
    setStatus(zip ? '正在获取 ' + list.length + ' 张图片…' : '正在下载 ' + list.length + ' 张图片…');
    let result;
    try {
      result = await chrome.runtime.sendMessage({
        type: 'DOWNLOAD',
        zip,
        items: list.map((img) => ({ url: img.url, width: img.width, height: img.height }))
      });
    } catch (e) {
      result = { ok: 0, fail: list.length, error: e && e.message ? e.message : String(e) };
    }
    if (!result) {
      setStatus('下载失败：后台未响应', 'error');
    } else if (result.error && !result.ok) {
      setStatus('下载失败：' + result.error, 'error');
    } else if (zip) {
      setStatus(result.fail ? '打包完成：' + result.ok + ' 张成功，' + result.fail + ' 张失败'
        : '打包完成，共 ' + result.ok + ' 张', result.fail ? '' : 'success');
    } else {
      setStatus('已下载 ' + result.ok + '/' + list.length + ' 张图片', result.fail ? '' : 'success');
    }
    isDownloading = false;
    setBusy(false);
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
      credentials: 'include',
      referrer: location.href,
      referrerPolicy: 'no-referrer-when-downgrade'
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return { dataUrl: await blobToDataUrl(await response.blob()) };
  }

  // ==================== 消息 ====================

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg) return false;
    if (msg.type === 'OPEN') {
      try {
        open();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
      return false;
    }
    if (msg.type === '__IMG_INSPECTOR_SCAN__') {
      try { sendResponse(scanAll()); }
      catch (e) { sendResponse({ error: String(e && e.message ? e.message : e) }); }
      return false;
    }
    if (msg.type === 'PROGRESS') {
      setStatus('处理中 ' + msg.done + '/' + msg.total + ' · 成功 ' + msg.ok + ' · 失败 ' + msg.fail);
      return false;
    }
    if (msg.type === 'FETCH_INPAGE') {
      fetchInPage(msg.url).then(sendResponse, function (e) {
        sendResponse({ error: String((e && e.message) || e) });
      });
      return true;
    }
    return false;
  });
})();
