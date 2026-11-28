import { CHUNK_BYTES, DL_RESUME_QUERY, GET_QUALITIES, GET_RESOURCES, MANIFEST_FOUND, MAX_DEPTH, PROBE_SIZE, PROBE_SIZE_RESPONSE, QUALITIES, SCAN_RESOURCES } from '../core/constants.js';
import { capturedByUrl, capturedResources, counters, currentItems, downloadTasks, integratingScanId, picked, scanLoading, scanMode, setCurrentItems, setIntegratingScanId, setScanLoading, sizeCache } from '../core/state.js';
import { grid, modal, modeNote, numEl, q, qualitySelect, scanModeInputs, shadow } from '../ui/mount.js';
import { refreshDownloadButtons } from './downloads.js';
import { t } from '../core/i18n.js';
import { collectVideos, formatDuration, formatSize, itemKey } from '../core/utils.js';
import { buildItem, renderGrid } from './modal.js';

function forwardManifest(items) {
  (items || []).forEach((item) => {
    if (!item || !item.url) return;
    try {
      document.dispatchEvent(new CustomEvent(MANIFEST_FOUND, {
        detail: JSON.stringify({ url: item.url, kind: item.kind || '' })
      }));
    } catch (_) {}
  });
}

function blobToChunks(blob, id, stream) {
  return new Promise((resolve, reject) => {
    const reader = blob.stream().getReader();
    let index = 0;
    const pump = () => reader.read().then(({ done, value }) => {
      if (done) { resolve(); return; }
      let offset = 0;
      const sendChunk = () => {
        if (offset >= value.length) { pump(); return; }
        const slice = value.subarray(offset, offset + CHUNK_BYTES);
        offset += slice.length;
        let binary = '';
        for (let i = 0; i < slice.length; i += 8192) {
          binary += String.fromCharCode.apply(null, slice.subarray(i, i + 8192));
        }
        const b64 = btoa(binary);
        chrome.runtime.sendMessage({ type: 'vi-mux-chunk', id, stream, index: index++, b64 }, () => {
          if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
          sendChunk();
        });
      };
      sendChunk();
    }).catch(reject);
    pump();
  });
}

function updateScanModeUi() {
  scanModeInputs.forEach((input) => { input.checked = input.value === scanMode; });
  if (modeNote) modeNote.hidden = scanMode !== 'deep';
}

function runSearch() {
  if (modal.hidden) return;
  if (scanMode === 'deep') {
    startDeepView();
  } else {
    setIntegratingScanId('');
    setScanLoading(false);
    openNormalView(picked);
  }
}

// 普通搜索：完全沿用原来的 DOM 视频扫描逻辑。
function openNormalView(root) {
  const videos = collectVideos(root, 0, 0, 0, [], new Set(), MAX_DEPTH);
  setCurrentItems(videos.map((item, index) => buildItem(item, index)));

  currentItems.forEach((item) => {
    const videoTask = downloadTasks.get(itemKey(item));
    if (videoTask) videoTask.item = item;
  });

  if (numEl) numEl.textContent = String(videos.length);
  try {
    renderGrid();
    refreshDownloadButtons();
  } catch (error) {
    grid.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'vi-empty';
    empty.textContent = '渲染视频列表时出错，请查看控制台。';
    grid.appendChild(empty);
  }
  loadSizes();
}

// 深度扫描：三层资源模型独占视图，不再追加到普通结果里。
function startDeepView() {
  setIntegratingScanId('');
  setScanLoading(true);
  setCurrentItems([]);
  if (numEl) numEl.textContent = '0';
  grid.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'vi-empty';
  loading.textContent = t('deepScanning');
  grid.appendChild(loading);
  requestResourceScan();
}

function requestCapturedResources() {
  try {
    document.dispatchEvent(new CustomEvent(GET_RESOURCES, { detail: JSON.stringify({}) }));
  } catch (_) {}
}

function requestResourceScan() {
  const id = 'scan-' + (++counters.scan);
  setIntegratingScanId(id);
  try {
    document.dispatchEvent(new CustomEvent(SCAN_RESOURCES, {
      detail: JSON.stringify({ id, pageUrl: location.href })
    }));
  } catch (_) {
    setIntegratingScanId('');
  }
  setTimeout(() => {
    if (integratingScanId !== id) return;
    setIntegratingScanId('');
    if (scanLoading && scanMode === 'deep' && !modal.hidden) integrateResources([]);
  }, 8000);
}

const SIGNATURE_PARAM = /^(bti|bt|ft|a|sign|signature|token|t|expires|expire|ts|nonce|stamp|timestamp|x-amz-[^=]*|x-goog-[^=]*|se|sv|sp|sig|_signature)$/i;
const ID_PARAM = /^(id|vid|video_id|aweme_id|bvid|cid|item_id|itemId)$/i;

function resourceFingerprint(url) {
  if (!url || typeof url !== 'string') return '';
  if (/^blob:|^data:|^mse:/i.test(url)) return '';
  let u;
  try { u = new URL(url, location.href); } catch (_) { return ''; }
  const host = u.hostname.replace(/^www\./i, '');
  const path = u.pathname.replace(/\/+$/, '');
  if (/bilibili/i.test(host)) {
    const bv = (path.match(/(BV[0-9A-Za-z]{10})/) || [])[1];
    if (bv) return 'bilibili:' + bv;
  }
  if (/(tiktok|douyin|aweme)/i.test(host + path)) {
    const id = (path.match(/\/([0-9]{12,}|[A-Za-z0-9_-]{18,})\/?$/) || [])[1];
    if (id) return host + ':' + id;
  }
  const ids = [];
  u.searchParams.forEach((value, key) => {
    if (ID_PARAM.test(key) && value) ids.push(key + '=' + value);
  });
  if (ids.length) return host + path + '?' + ids.sort().join('&');
  const kept = [];
  u.searchParams.forEach((value, key) => {
    if (!SIGNATURE_PARAM.test(key)) kept.push(key + '=' + value);
  });
  return host + path + (kept.length ? '?' + kept.sort().join('&') : '');
}

function mergeResource(prev, next) {
  const merged = Object.assign({}, prev);
  ['size', 'width', 'height', 'duration', 'score'].forEach((key) => {
    if ((Number(next[key]) || 0) > (Number(merged[key]) || 0)) merged[key] = next[key];
  });
  ['audioUrl', 'videoUrl', 'poster', 'title', 'kind'].forEach((key) => {
    if (!merged[key] && next[key]) merged[key] = next[key];
  });
  const sources = Array.from(new Set([
    ...(Array.isArray(prev.sources) ? prev.sources : [prev.source]),
    next.source
  ].filter(Boolean)));
  merged.sources = sources;
  merged.source = sources.join('+');
  return merged;
}

// 深度视图：按指纹全量重建逻辑视频集合，不再追加。
function integrateResources(resources) {
  setScanLoading(false);
  if (!modal || modal.hidden || scanMode !== 'deep') return;
  const grouped = new Map();
  (Array.isArray(resources) ? resources : []).forEach((res) => {
    if (!res || !res.url) return;
    const key = resourceFingerprint(res.url) || resourceFingerprint(res.videoUrl);
    if (!key) return;
    const prev = grouped.get(key);
    grouped.set(key, prev ? mergeResource(prev, res) : Object.assign({ sources: [res.source].filter(Boolean) }, res));
  });
  const completeness = (r) => {
    let value = 0;
    if ((Number(r.size) || 0) > 0) value += 4;
    if ((Number(r.width) || 0) > 0 && (Number(r.height) || 0) > 0) value += 4;
    if ((Number(r.duration) || 0) > 0) value += 1;
    if (r.audioUrl) value += 1;
    if (r.title) value += 1;
    return value;
  };
  const merged = Array.from(grouped.values()).sort((a, b) => {
    const completeDiff = completeness(b) - completeness(a);
    if (completeDiff) return completeDiff;
    if ((Number(b.size) || 0) !== (Number(a.size) || 0)) return (Number(b.size) || 0) - (Number(a.size) || 0);
    return (Number(b.score) || 0) - (Number(a.score) || 0);
  }).slice(0, 120);
  setCurrentItems(merged.map((res, index) => buildResourceItem(res, index)));
  currentItems.forEach((item) => {
    const videoTask = downloadTasks.get(itemKey(item));
    if (videoTask) videoTask.item = item;
  });
  if (numEl) numEl.textContent = String(currentItems.length);
  if (!currentItems.length) {
    grid.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'vi-empty';
    empty.textContent = t('deepEmpty');
    grid.appendChild(empty);
    return;
  }
  try {
    renderGrid();
    refreshDownloadButtons();
  } catch (error) {
    grid.replaceChildren();
  }
  loadSizes();
}

function buildResourceItem(res, index) {
  const size = Number(res.size) || 0;
  return {
    index,
    el: null,
    ox: 0,
    oy: 0,
    label: res.title || resourceDisplayName(res.url),
    customTitle: '',
    selected: (Number(res.score) || 0) >= 80,
    src: res.url,
    poster: res.poster || '',
    duration: res.duration ? formatDuration(res.duration) : '-',
    resolution: res.width && res.height ? res.width + '×' + res.height : '-',
    sizeText: formatSize(size),
    hasSize: size > 0,
    hasResolution: !!(res.width && res.height),
    hasDuration: !!(res.duration && Number(res.duration) > 0),
    paused: true,
    currentTime: 0,
    isResource: true,
    discovered: true,
    discoverySource: res.source || 'scan',
    discoveredScore: Number(res.score) || 0,
    videoUrl: res.videoUrl || '',
    audioUrl: res.audioUrl || '',
    resourceKind: res.kind || 'direct',
    resourceId: '',
    resourceType: '',
    resourceSize: size
  };
}

function resourceDisplayName(url) {
  try {
    const name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop());
    return name ? '资源 · ' + name.slice(0, 40) : '视频资源';
  } catch (_) {
    return '视频资源';
  }
}

function requestQualities() {
  if (!qualitySelect) return;
  const id = 'q-' + (++counters.quality);
  qualitySelect.replaceChildren();
  const loading = document.createElement('option');
  loading.value = '';
  loading.textContent = t('qualityLoading');
  qualitySelect.appendChild(loading);
  qualitySelect.disabled = true;

  let settled = false;
  const finish = (list) => {
    if (settled) return;
    settled = true;
    document.removeEventListener(QUALITIES, onResponse, true);
    clearTimeout(timer);
    qualitySelect.disabled = false;
    qualitySelect.replaceChildren();
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = t('qualityAuto');
    qualitySelect.appendChild(auto);
    (list || []).forEach((item) => {
      if (!item || item.id === undefined || item.id === null) return;
      const option = document.createElement('option');
      option.value = String(item.id);
      let label = item.label || String(item.id);
      if (item.width && item.height) label += ' · ' + item.width + '×' + item.height;
      option.textContent = label;
      qualitySelect.appendChild(option);
    });
  };
  const onResponse = (event) => {
    let data;
    try { data = JSON.parse(event.detail); } catch (_) { return; }
    if (!data || data.id !== id) return;
    finish(data.qualities || []);
  };
  const timer = setTimeout(() => finish([]), 10000);
  document.addEventListener(QUALITIES, onResponse, true);
  try {
    document.dispatchEvent(new CustomEvent(GET_QUALITIES, { detail: JSON.stringify({ id, pageUrl: location.href }) }));
  } catch (_) {
    finish([]);
  }
}


function applyCapturedResources(items) {
  if (!Array.isArray(items) || !items.length) return;
  if (!modal || modal.hidden) return;

  items.forEach((res) => {
    if (!res || !res.id) return;
    capturedResources.set(res.id, res);
    const keys = [res.matchUrl, res.url].filter((key) => typeof key === 'string' && key);
    keys.forEach((key) => {
      const prev = capturedByUrl.get(key);
      if (!prev || (Number(res.size) || 0) > (Number(prev.size) || 0)) capturedByUrl.set(key, res);
    });
  });

  currentItems.forEach((item) => {
    const src = item.src;
    if (!src) return;
    const res = capturedByUrl.get(src);
    if (!res || item.resourceId === res.id) return;
    item.resourceId = res.id;
    item.resourceType = res.type || '';
    item.resourceSize = Number(res.size) || 0;
    item.sizeText = formatSize(item.resourceSize);
    const card = shadow.querySelector('.vi-card[data-index="' + item.index + '"]');
    if (card) {
      const chip = card.querySelector('.vi-size');
      if (chip) chip.textContent = t('metaSize') + ' ' + item.sizeText;
    }
  });

  // 只为页面上真实存在的 video 补充资源信息，不再凭空生成嗅探卡片。
  // 之前这里会不断追加无对应元素的 blob/MSE，表现为“空白视频越来越多”。
}

function applyDownloadedSize(item, size) {
  if (!item || !Number.isFinite(size) || size <= 0) return;
  item.resourceSize = size;
  item.sizeText = formatSize(size);
  const card = shadow.querySelector('.vi-card[data-index="' + item.index + '"]');
  if (!card) return;
  const chip = card.querySelector('.vi-size');
  if (chip) chip.textContent = t('metaSize') + ' ' + item.sizeText;
}


function requestSize(url) {
  if (sizeCache.has(url)) return Promise.resolve(sizeCache.get(url));
  const id = 'vi-size-' + (++counters.size);
  return new Promise((resolve) => {
    let timer = 0;
    const finish = (size) => {
      clearTimeout(timer);
      document.removeEventListener(PROBE_SIZE_RESPONSE, onResponse, true);
      sizeCache.set(url, size);
      resolve(size);
    };
    const onResponse = (event) => {
      let data;
      try { data = JSON.parse(event.detail); } catch (_) { return; }
      if (data && data.id === id) finish(Number(data.size) || 0);
    };
    document.addEventListener(PROBE_SIZE_RESPONSE, onResponse, true);
    timer = setTimeout(() => finish(0), 12000);
    try {
      document.dispatchEvent(new CustomEvent(PROBE_SIZE, { detail: JSON.stringify({ id, url }) }));
    } catch (_) {
      finish(0);
    }
  });
}

function requestResumeState() {
  try {
    document.dispatchEvent(new CustomEvent(DL_RESUME_QUERY, {
      detail: JSON.stringify({ id: 'vi-resume-' + (++counters.resume), pageUrl: location.href })
    }));
  } catch (_) {}
}

function loadSizes() {
  currentItems.forEach((item) => {
    if (item.sizeText && item.sizeText !== '-') return;
    const url = item.src;
    if (!url || !/^https?:\/\//i.test(url)) return;
    requestSize(url).then((size) => {
      if (!size && item.sizeText && item.sizeText !== '-') return;
      item.sizeText = formatSize(size);
      const card = shadow.querySelector('.vi-card[data-index="' + item.index + '"]');
      if (!card) return;
      const chip = card.querySelector('.vi-size');
      if (chip) chip.textContent = t('metaSize') + ' ' + item.sizeText;
    });
  });
}


export { forwardManifest, blobToChunks, requestResumeState, updateScanModeUi, runSearch, openNormalView, startDeepView, requestCapturedResources, requestResourceScan, resourceFingerprint, mergeResource, integrateResources, buildResourceItem, resourceDisplayName, requestQualities, requestSize, loadSizes, applyCapturedResources, applyDownloadedSize };
