import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import QRCode from 'qrcode';

// 文龙二维码助手 —— React 面板
// 结构与图片助手一致：逻辑桥接在 content.js，DOM 渲染全部交给这里（→ ui.js）。

const MAX_CHARS = 2048; // 最大字符数（QR 库限制约 2953 字节，留余量）

const PRESETS = [
  { label: '黑前景 · 白背景', dark: '#111111', light: '#ffffff' },
  { label: '黑背景 · 白前景', dark: '#ffffff', light: '#111111' },
  { label: '蓝前景 · 白背景', dark: '#0a5fd4', light: '#ffffff' },
  { label: '绿前景 · 米白背景', dark: '#0d7a4a', light: '#f5f7f1' }
];

// 7×7 迷你二维码点阵：1 表示前景色，0 表示背景色
const MINI_QR_PATTERN = [
  1, 1, 1, 0, 1, 1, 1,
  1, 1, 1, 0, 1, 1, 1,
  0, 0, 0, 1, 0, 1, 0,
  1, 1, 0, 1, 0, 0, 1,
  0, 1, 1, 0, 1, 1, 0,
  1, 1, 1, 0, 1, 0, 1,
  1, 1, 1, 1, 0, 1, 0
];

const DEFAULT_SETTINGS = { level: 'M', width: 248, margin: 2, dark: '#111111', light: '#ffffff' };

const AUTHOR_URL = 'https://space.bilibili.com/3706965849016893';
const APP_VERSION = (() => {
  try {
    return chrome.runtime.getManifest().version;
  } catch (e) {
    return '';
  }
})();
const AUTHOR_ICON = (() => {
  try {
    return chrome.runtime.getURL('bilibili.png');
  } catch (e) {
    return '';
  }
})();

// 挂载层与 React 之间的桥：content.js 通过它打开 / 关闭面板
const bridge = { open: null, close: null };
let pendingOpen = null;

function MiniQr({ dark, light }) {
  return (
    <div className="qr-preset-qr" style={{ background: light }}>
      {MINI_QR_PATTERN.map((on, index) => (
        <span
          key={index}
          className="qr-preset-cell"
          style={on ? { background: dark } : undefined}
        />
      ))}
    </div>
  );
}

function App() {
  const [visible, setVisible] = useState(false);
  const [text, setText] = useState('');
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [copyState, setCopyState] = useState('idle'); // idle | done | fail
  const canvasRef = useRef(null);
  const inputRef = useRef(null);
  const timerRef = useRef(0);

  // 注册打开 / 关闭入口，并处理挂载前就到达的打开请求
  useEffect(() => {
    bridge.open = (value) => {
      setText(value || '');
      setSettings(DEFAULT_SETTINGS);
      setCopyState('idle');
      setVisible(true);
    };
    bridge.close = () => setVisible(false);
    if (pendingOpen !== null) {
      const value = pendingOpen;
      pendingOpen = null;
      bridge.open(value);
    }
    return () => {
      bridge.open = null;
      bridge.close = null;
    };
  }, []);

  const close = () => {
    const api = globalThis.__QR_CODE_UI__;
    if (api) api.close();
  };

  // Esc 关闭
  useEffect(() => {
    if (!visible) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [visible]);

  // 打开时聚焦输入框，内容已存在则全选，方便直接替换
  useEffect(() => {
    if (!visible) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (el.value) el.select();
  }, [visible]);

  // 生成二维码（输入时轻微防抖）
  useEffect(() => {
    if (!visible || !text) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      QRCode.toCanvas(canvas, text, {
        width: Number(settings.width) || 248,
        margin: Number(settings.margin) || 0,
        errorCorrectionLevel: settings.level || 'M',
        color: { dark: settings.dark || '#111111', light: settings.light || '#ffffff' }
      }).catch(() => {
        if (!cancelled) console.warn('[二维码助手] 渲染失败');
      });
    }, 50);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [visible, text, settings]);

  const patch = (key, value) => setSettings((prev) => ({ ...prev, [key]: value }));

  const applyPreset = (preset) => {
    setSettings((prev) => ({ ...prev, dark: preset.dark, light: preset.light }));
  };

  const flashCopy = (state) => {
    setCopyState(state);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopyState('idle'), 1500);
  };

  const copyText = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      flashCopy('done');
    } catch (e) {
      flashCopy('fail');
    }
  };

  const download = () => {
    if (!text || !canvasRef.current) return;
    const url = canvasRef.current.toDataURL('image/png');
    const safeName = String(text).replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 16) || 'qrcode';
    const link = document.createElement('a');
    link.href = url;
    link.download = safeName + '.png';
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  const over = text.length >= MAX_CHARS;
  const currentColors = settings.dark + '|' + settings.light;
  const copyLabel = copyState === 'done' ? '已复制 ✓' : copyState === 'fail' ? '复制失败' : '复制内容';

  if (!visible) return null;

  return (
    <div
      className="qr-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="qr-modal" role="dialog" aria-modal="true" aria-label="文龙二维码助手">
        <button type="button" className="qr-close" aria-label="关闭" onClick={close}>✕</button>
        <p className="qr-title">文龙二维码助手</p>

        <div className="qr-body">
          <div className="qr-col-left">
            <div className="qr-settings-title">配色预设</div>
            <div className="qr-presets">
              {PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  aria-label={preset.label}
                  className={'qr-preset-btn' + (preset.dark + '|' + preset.light === currentColors ? ' active' : '')}
                  onClick={() => applyPreset(preset)}
                >
                  <MiniQr dark={preset.dark} light={preset.light} />
                </button>
              ))}
            </div>

            <div className="qr-settings-title">高级参数</div>
            <div className="qr-adv-grid">
              <div className="qr-adv-row">
                <label>纠错等级</label>
                <select value={settings.level} onChange={(event) => patch('level', event.target.value)}>
                  <option value="L">L · 7%</option>
                  <option value="M">M · 15%</option>
                  <option value="Q">Q · 25%</option>
                  <option value="H">H · 30%</option>
                </select>
              </div>
              <div className="qr-adv-row">
                <label>边距</label>
                <input
                  type="number"
                  min="0"
                  max="10"
                  step="1"
                  value={settings.margin}
                  onChange={(event) => patch('margin', Number(event.target.value))}
                />
              </div>
              <div className="qr-adv-row">
                <label>前景色</label>
                <input type="color" value={settings.dark} onChange={(event) => patch('dark', event.target.value)} />
              </div>
              <div className="qr-adv-row">
                <label>背景色</label>
                <input type="color" value={settings.light} onChange={(event) => patch('light', event.target.value)} />
              </div>
            </div>
          </div>

          <div className="qr-col-right">
            <div className="qr-wrap">
              {text ? (
                <canvas ref={canvasRef} className="qr-canvas" width="248" height="248" />
              ) : (
                <div className="qr-empty-hint">
                  <span className="big">▦</span>
                  <span>输入内容后自动生成</span>
                </div>
              )}
            </div>

            <textarea
              ref={inputRef}
              className={'qr-input' + (over ? ' warn' : '')}
              placeholder="输入文字、链接或任意内容…"
              maxLength={MAX_CHARS}
              spellCheck={false}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                  event.preventDefault();
                  copyText();
                }
              }}
            />

            <div className="qr-char-row">
              <span>字符数</span>
              <span className={over ? 'warn' : ''}>
                {text.length} / {MAX_CHARS}{over ? ' · 已达上限' : ''}
              </span>
            </div>

            <div className="qr-actions">
              <button type="button" className="qr-btn qr-btn-secondary" onClick={copyText}>{copyLabel}</button>
              <button type="button" className="qr-btn qr-btn-primary" disabled={!text} onClick={download}>下载图片</button>
            </div>
          </div>
        </div>

        <div className="qr-footer">
          <a
            className="qr-author"
            href={AUTHOR_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="联系作者：吴文龙"
          >
            <img src={AUTHOR_ICON} alt="B站" />
            <span className="qr-tip">联系作者：吴文龙</span>
          </a>
          {APP_VERSION ? <span className="qr-ver">v{APP_VERSION}</span> : null}
        </div>
      </div>
    </div>
  );
}

// ---------- Shadow DOM 挂载 ----------

const state = globalThis.__QR_CODE_UI_STATE__ || (globalThis.__QR_CODE_UI_STATE__ = {
  host: null,
  shadow: null,
  root: null
});

function ensureHost() {
  if (state.host) return;
  const host = document.createElement('div');
  host.id = '__QR_CODE_EXT_HOST__';
  host.style.cssText = 'all:initial;position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;display:none;';
  const shadow = host.attachShadow({ mode: 'closed' });

  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(globalThis.__QR_CODE_CSS__ || '');
    shadow.adoptedStyleSheets = [sheet];
  } catch (e) {
    const style = document.createElement('style');
    style.textContent = globalThis.__QR_CODE_CSS__ || '';
    shadow.appendChild(style);
  }

  state.host = host;
  state.shadow = shadow;
  state.root = createRoot(shadow);
  state.root.render(<App />);
}

globalThis.__QR_CODE_UI__ = {
  open(text) {
    ensureHost();
    const host = state.host;
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    host.style.display = 'block';
    if (bridge.open) bridge.open(text);
    else pendingOpen = text || '';
  },
  close() {
    if (bridge.close) bridge.close();
    if (state.host) state.host.style.display = 'none';
  },
  isOpen() {
    return !!state.host && state.host.style.display !== 'none';
  },
  dispose() {
    try {
      if (state.root) state.root.unmount();
    } catch (e) {
      /* 忽略 */
    }
    if (state.host && state.host.parentNode) state.host.remove();
    state.host = null;
    state.shadow = null;
    state.root = null;
  }
};
