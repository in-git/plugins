// 冒烟测试：在 jsdom 中加载打包后的 content.js，确认挂载与初始化不抛异常
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const code = readFileSync(new URL('../dist/content.js', import.meta.url), 'utf8');

const dom = new JSDOM(
  '<!doctype html><html><body><video src="https://example.com/a.mp4"></video></body></html>',
  { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/page' }
);

const { window } = dom;
const messages = [];
window.chrome = {
  runtime: {
    lastError: null,
    getURL: (path) => 'chrome-extension://smoke/' + path,
    getManifest: () => ({ version: '0.0.0' }),
    onMessage: { addListener: (fn) => messages.push(fn) },
    sendMessage: (_msg, cb) => { if (typeof cb === 'function') cb({ ok: true, items: [] }); }
  }
};

window.eval(code);

const host = window.document.getElementById('__video_inspector_host__');
if (!host || !host.shadowRoot) throw new Error('Shadow host not mounted');
if (!host.shadowRoot.querySelector('.vi-dialog')) throw new Error('Dialog template missing');
if (!window.__videoInspectorLoaded) throw new Error('Loaded flag missing');
if (!messages.length) throw new Error('runtime.onMessage not bound');

console.log('smoke ok:', {
  nodes: host.shadowRoot.querySelectorAll('*').length,
  listeners: messages.length
});
