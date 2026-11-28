// Shadow DOM 根节点与界面元素引用
import { TEMPLATE } from './template.js';

export let host = null;
export let shadow = null;

export const q = (selector) => shadow.querySelector(selector);

export let tip = null;
export let boxes = null;
export let areaOverlay = null;
export let areaRect = null;
export let areaTip = null;
export let areaToast = null;
export let modal = null;
export let numEl = null;
export let grid = null;
export let selectAll = null;
export let formatSelect = null;
export let qualitySelect = null;
export let scanModeInputs = [];
export let modeNote = null;

export function mountUi() {
  host = document.createElement('div');
  host.id = '__video_inspector_host__';
  document.documentElement.appendChild(host);

  shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = TEMPLATE;

  tip = q('.vi-tip');
  boxes = q('.vi-boxes');
  areaOverlay = q('.vi-area-overlay');
  areaRect = q('.vi-area-rect');
  areaTip = q('.vi-area-tip');
  areaToast = q('.vi-area-toast');
  modal = q('.vi-modal');
  numEl = q('.vi-count .num');
  grid = q('.vi-grid');
  selectAll = q('.vi-select-all');
  formatSelect = q('.vi-format');
  qualitySelect = q('.vi-quality');
  scanModeInputs = Array.from(shadow.querySelectorAll('.vi-scan-mode input'));
  modeNote = q('.vi-mode-note');
}
