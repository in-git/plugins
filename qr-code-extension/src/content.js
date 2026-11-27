// 文龙二维码助手 —— 内容脚本
// 监听 SHOW_QR 消息 → 屏幕居中弹出模态框 → 用 qrcode 库渲染
// 左右布局：左侧配置，右侧二维码
// 所有 DOM 放在 Shadow Root 里，避免被页面 CSS 干扰

import QRCode from 'qrcode';

const HOST_ID = '__QR_CODE_EXT_HOST__';
const MAX_CHARS = 2048; // 最大字符数（QR 库限制约 2953 字节，留余量）

const PRESETS = [
  { label: '黑前景 · 白背景', dark: '#111111', light: '#ffffff' },
  { label: '黑背景 · 白前景', dark: '#ffffff', light: '#111111' },
  { label: '蓝前景 · 白背景', dark: '#0a5fd4', light: '#ffffff' },
  { label: '绿前景 · 米白背景', dark: '#0d7a4a', light: '#f5f7f1' },
];

function ensureHost() {
  let host = document.getElementById(HOST_ID);
  if (host) return host;
  host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const css = new CSSStyleSheet();
  css.replaceSync(`
    * { box-sizing: border-box; }
    .overlay {
      position: fixed; inset: 0;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(2px);
      display: flex; align-items: center; justify-content: center;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
      animation: fadeIn 160ms ease-out;
      cursor: default;
    }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .modal {
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.06);
      width: min(640px, calc(100vw - 48px));
      padding: 22px 22px 18px;
      position: relative;
      animation: popIn 180ms cubic-bezier(.2,.9,.3,1.2);
    }
    @keyframes popIn {
      from { transform: scale(0.92); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }
    .close-btn {
      position: absolute; top: 10px; right: 12px;
      width: 28px; height: 28px; border: none;
      background: #f2f2f4; border-radius: 50%; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      color: #666; font-size: 18px; line-height: 1;
      transition: background 120ms;
    }
    .close-btn:hover { background: #e5e5ea; color: #000; }
    .title {
      font-size: 14px; font-weight: 600; color: #111;
      margin: 0 0 14px 0; text-align: left;
    }

    /* 左右分栏 */
    .body {
      display: flex; gap: 20px;
    }
    .col-left { flex: 1.15; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
    .col-right { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; align-items: stretch; }

    @media (max-width: 540px) {
      .body { flex-direction: column; }
      .modal { width: min(380px, calc(100vw - 32px)); }
    }

    /* —— 左侧 —— */
    .input {
      width: 100%;
      min-height: 96px; max-height: 200px;
      padding: 10px 12px;
      border: 1px solid #e5e5ea; border-radius: 10px;
      font-size: 13px; line-height: 1.5; color: #111;
      font-family: inherit; resize: vertical; outline: none;
      transition: border-color 120ms, box-shadow 120ms;
    }
    .input:focus { border-color: #111; box-shadow: 0 0 0 3px rgba(0,0,0,0.06); }
    .input::placeholder { color: #aaa; }
    .input.warn { border-color: #ff3b30; }
    .char-row {
      display: flex; justify-content: space-between; align-items: center;
      font-size: 14px; color: #aaa;
    }
    .char-row .warn { color: #ff3b30; font-weight: 500; }

    /* 设置区 */
    .settings-title {
      font-size: 14px; font-weight: 600; color: #888;
      text-transform: uppercase; letter-spacing: .06em;
      margin: 2px 0 2px;
    }
    .presets {
      display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
    }
    .preset-btn {
      height: 36px; padding: 0 8px;
      border: 1px solid #e5e5ea; border-radius: 8px;
      background: #fff; cursor: pointer;
      display: flex; align-items: center; gap: 8px;
      font-size: 12px; color: #111;
      transition: border-color 120ms, background 120ms;
    }
    .preset-btn:hover { background: #fafafa; border-color: #c8c8ce; }
    .preset-btn.active { border-color: #111; box-shadow: 0 0 0 1px #111; }
    .preset-swatch {
      flex: 0 0 16px; width: 16px; height: 16px; border-radius: 4px;
      border: 1px solid #e5e5ea;
      background-image: linear-gradient(135deg, var(--pk-dark) 0 50%, var(--pk-light) 50% 100%);
    }
    .adv-grid {
      display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
      padding: 10px; border: 1px solid #e5e5ea; border-radius: 10px;
      background: #fafafa;
    }
    .adv-row { display: flex; flex-direction: column; gap: 4px; }
    .adv-row label { font-size: 14px; color: #888; }
    .adv-row input[type="number"],
    .adv-row select {
      height: 30px; padding: 0 8px;
      border: 1px solid #e5e5ea; border-radius: 6px;
      font-size: 12px; color: #111; background: #fff;
      font-family: inherit; outline: none;
    }
    .adv-row input:focus, .adv-row select:focus {
      border-color: #111; box-shadow: 0 0 0 2px rgba(0,0,0,0.06);
    }
    .adv-row input[type="color"] {
      height: 30px; padding: 2px;
      border: 1px solid #e5e5ea; border-radius: 6px;
      background: #fff; cursor: pointer;
    }

    /* —— 右侧 —— */
    .qr-wrap {
      display: flex; justify-content: center; align-items: center;
      padding: 8px 0;
      flex: 1; min-height: 240px;
    }
    canvas { display: block; border-radius: 8px; background: #fff; max-width: 100%; height: auto; }
    .empty-hint {
      width: 100%; max-width: 248px; aspect-ratio: 1;
      border-radius: 8px; background: #f5f5f7;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      color: #999; font-size: 13px; gap: 6px;
    }
    .empty-hint .big { font-size: 36px; }

    .actions { display: flex; gap: 8px; }
    .btn {
      flex: 1; height: 36px; border-radius: 8px; border: none;
      font-size: 13px; font-weight: 500; cursor: pointer;
      transition: transform 80ms, background 120ms;
    }
    .btn:active { transform: scale(0.97); }
    .btn-primary { background: #111; color: #fff; }
    .btn-primary:hover { background: #000; }
    .btn-secondary { background: #f2f2f4; color: #111; }
    .btn-secondary:hover { background: #e5e5ea; }
    .btn[disabled] { opacity: 0.5; cursor: not-allowed; }
  `);
  shadow.adoptedStyleSheets = [css];
  return host;
}

let currentHost = null;
function closeModal(host) {
  host.shadowRoot.innerHTML = '';
  document.removeEventListener('keydown', onKey);
}
function onKey(e) {
  if (e.key === 'Escape' && currentHost) { closeModal(currentHost); currentHost = null; }
}

async function renderQr(canvas, text, opts) {
  if (!text) return false;
  try {
    await QRCode.toCanvas(canvas, text, {
      width: Number(opts.width) || 260,
      margin: Number(opts.margin) || 2,
      errorCorrectionLevel: opts.level || 'M',
      color: { dark: opts.dark || '#111111', light: opts.light || '#ffffff' },
    });
    return true;
  } catch (err) {
    console.warn('[QR render fail]', err);
    return false;
  }
}

const DEFAULT_SETTINGS = { level: 'M', width: 248, margin: 2, dark: '#111111', light: '#ffffff' };

function showQr(initialText) {
  const host = ensureHost();
  host.shadowRoot.innerHTML = '';
  document.removeEventListener('keydown', onKey);
  currentHost = host;

  const shadow = host.shadowRoot;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';

  const modal = document.createElement('div');
  modal.className = 'modal';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'close-btn'; closeBtn.type = 'button';
  closeBtn.textContent = '✕'; closeBtn.setAttribute('aria-label', '关闭');

  const title = document.createElement('p');
  title.className = 'title'; title.textContent = '文龙二维码助手';

  // ============ 左栏（只有设置） ============
  const colLeft = document.createElement('div');
  colLeft.className = 'col-left';

  const presetsTitle = document.createElement('div');
  presetsTitle.className = 'settings-title'; presetsTitle.textContent = '配色预设';

  const presets = document.createElement('div');
  presets.className = 'presets';
  PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'preset-btn';
    btn.title = p.label;
    btn.dataset.dark = p.dark; btn.dataset.light = p.light;
    btn.innerHTML = `
      <span class="preset-swatch" style="--pk-dark:${p.dark};--pk-light:${p.light}"></span>
      <span>${p.label}</span>`;
    presets.appendChild(btn);
  });

  const advTitle = document.createElement('div');
  advTitle.className = 'settings-title'; advTitle.textContent = '高级参数';

  const advGrid = document.createElement('div');
  advGrid.className = 'adv-grid';
  advGrid.innerHTML = `
    <div class="adv-row"><label>纠错等级</label>
      <select data-k="level">
        <option value="L">L · 7%</option><option value="M" selected>M · 15%</option>
        <option value="Q">Q · 25%</option><option value="H">H · 30%</option>
      </select></div>
    <div class="adv-row"><label>边距</label>
      <input type="number" data-k="margin" min="0" max="10" step="1" value="2"></div>
    <div class="adv-row"><label>前景色</label>
      <input type="color" data-k="dark" value="#111111"></div>
    <div class="adv-row"><label>背景色</label>
      <input type="color" data-k="light" value="#ffffff"></div>
  `;

  colLeft.appendChild(presetsTitle);
  colLeft.appendChild(presets);
  colLeft.appendChild(advTitle);
  colLeft.appendChild(advGrid);

  // ============ 右栏（QR + 文本框在 QR 下方） ============
  const colRight = document.createElement('div');
  colRight.className = 'col-right';

  const qrWrap = document.createElement('div');
  qrWrap.className = 'qr-wrap';
  const canvas = document.createElement('canvas');
  canvas.width = 248; canvas.height = 248;
  const emptyHint = document.createElement('div');
  emptyHint.className = 'empty-hint';
  emptyHint.innerHTML = `<span class="big">▦</span><span>输入内容后自动生成</span>`;

  // 文本框（放在 QR 下面）
  const input = document.createElement('textarea');
  input.className = 'input';
  input.placeholder = '输入文字、链接或任意内容…';
  input.maxLength = MAX_CHARS;
  input.value = initialText || '';
  input.spellcheck = false;

  const charRow = document.createElement('div');
  charRow.className = 'char-row';
  const charLeft = document.createElement('span');
  charLeft.textContent = '字符数';
  const charCount = document.createElement('span');
  charCount.textContent = `${(initialText || '').length} / ${MAX_CHARS}`;
  charRow.appendChild(charLeft);
  charRow.appendChild(charCount);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn btn-secondary'; copyBtn.textContent = '复制内容';
  const dlBtn = document.createElement('button');
  dlBtn.className = 'btn btn-primary'; dlBtn.textContent = '下载图片';
  dlBtn.disabled = !initialText;
  actions.appendChild(copyBtn); actions.appendChild(dlBtn);

  colRight.appendChild(qrWrap);
  colRight.appendChild(input);
  colRight.appendChild(charRow);
  colRight.appendChild(actions);

  // ============ 组装 ============
  const body = document.createElement('div');
  body.className = 'body';
  body.appendChild(colLeft);
  body.appendChild(colRight);

  modal.appendChild(closeBtn);
  modal.appendChild(title);
  modal.appendChild(body);
  overlay.appendChild(modal);
  shadow.appendChild(overlay);

  // ============ 状态 ============
  let settings = { ...DEFAULT_SETTINGS };
  let hasContent = !!initialText;
  let debounceTimer = null;

  const refreshPresetActive = () => {
    const current = `${settings.dark}|${settings.light}`;
    presets.querySelectorAll('.preset-btn').forEach((b) => {
      b.classList.toggle('active', `${b.dataset.dark}|${b.dataset.light}` === current);
    });
  };

  // 初始渲染
  if (hasContent) { qrWrap.appendChild(canvas); renderQr(canvas, initialText, settings); }
  else { qrWrap.appendChild(emptyHint); }
  refreshPresetActive();

  async function triggerRender() {
    const val = input.value; if (!val) return;
    await renderQr(canvas, val, settings);
  }

  // ============ 输入事件 ============
  input.addEventListener('input', () => {
    const val = input.value;
    const over = val.length >= MAX_CHARS;
    charCount.textContent = `${val.length} / ${MAX_CHARS}${over ? ' · 已达上限' : ''}`;
    charCount.classList.toggle('warn', over);
    input.classList.toggle('warn', over);
    dlBtn.disabled = !val;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (!val) {
        hasContent = false; qrWrap.innerHTML = ''; qrWrap.appendChild(emptyHint); return;
      }
      if (!hasContent) { hasContent = true; qrWrap.innerHTML = ''; qrWrap.appendChild(canvas); }
      await triggerRender();
    }, 50);
  });

  // ============ 设置变更（通用） ============
  function wireField(el) {
    const k = el.dataset.k;
    const on = () => {
      let v = el.value;
      if (k === 'margin') v = Number(v);
      settings[k] = v;
      refreshPresetActive();
      triggerRender();
    };
    el.addEventListener(el.tagName === 'SELECT' || el.type === 'color' ? 'change' : 'input', on);
  }
  advGrid.querySelectorAll('[data-k]').forEach(wireField);

  // ============ 配色预设点击 ============
  presets.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.dark = btn.dataset.dark;
      settings.light = btn.dataset.light;
      // 同步 color picker 值
      advGrid.querySelector('[data-k="dark"]').value = btn.dataset.dark;
      advGrid.querySelector('[data-k="light"]').value = btn.dataset.light;
      refreshPresetActive();
      triggerRender();
    });
  });

  // ============ 其他 ============
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) { closeModal(host); currentHost = null; } });
  closeBtn.addEventListener('click', () => { closeModal(host); currentHost = null; });
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); copyBtn.click(); }
  });

  copyBtn.addEventListener('click', async () => {
    const val = input.value; if (!val) return;
    try { await navigator.clipboard.writeText(val); copyBtn.textContent = '已复制 ✓'; }
    catch { copyBtn.textContent = '复制失败'; }
    setTimeout(() => (copyBtn.textContent = '复制内容'), 1500);
  });

  dlBtn.addEventListener('click', () => {
    const val = input.value; if (!val) return;
    try {
      const url = canvas.toDataURL('image/png');
      const a = document.createElement('a'); a.href = url;
      const safeName = String(val).replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 16) || 'qrcode';
      a.download = safeName + '.png';
      document.body.appendChild(a); a.click(); a.remove();
    } catch { dlBtn.textContent = '下载失败'; }
  });

  input.focus();
  if (initialText) input.select();
}

try {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'SHOW_QR' && typeof msg.text === 'string') { showQr(msg.text); sendResponse({ ok: true }); }
    return false;
  });
} catch { /* 非扩展上下文忽略 */ }

if (typeof window !== 'undefined') {
  window.__QR_CODE_EXT__ = window.__QR_CODE_EXT__ || {};
  window.__QR_CODE_EXT__.show = showQr;
}
