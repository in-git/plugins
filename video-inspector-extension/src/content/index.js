import { DL_RESUME_LIST, MUX_REQUEST, MUX_RESPONSE, RESOURCES, SCAN_RESULT } from './core/constants.js';
import { currentItems, integratingScanId, lastContextTarget, pendingMux, picked, resumeJobs, setIntegratingScanId, setScanMode } from './core/state.js';
import { refreshDownloadButtons } from './features/downloads.js';
import { onContextMenu, onKeyDown, onMouseDown, onMouseMove, onMouseUp, onPageClick, openAllVideos, schedule, stopInspect } from './features/inspect.js';
import { grid, modal, mountUi, scanModeInputs, selectAll, shadow } from './ui/mount.js';
import { onShadowClick, openModal } from './features/modal.js';
import { applyCapturedResources, blobToChunks, forwardManifest, integrateResources, runSearch, updateScanModeUi } from './features/discovery.js';
import { findVideoRoot } from './core/utils.js';

// content script 入口：守卫 + 挂载 Shadow DOM + 绑定事件
if (!window.__videoInspectorLoaded) {
  window.__videoInspectorLoaded = true;
  mountUi();
  init();
}

function init() {
  document.addEventListener(DL_RESUME_LIST, (event) => {
    let data;
    try { data = JSON.parse(event.detail); } catch (_) { return; }
    resumeJobs.clear();
    (data && data.jobs || []).forEach((job) => {
      if (!job) return;
      const key = job.jobKey || String(job.filename || '').replace(/\.[^.]+$/, '');
      if (key) resumeJobs.set(key, job);
    });
    refreshDownloadButtons();
  }, true);

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('click', onPageClick, true);
  document.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);

  shadow.addEventListener('click', onShadowClick);
  scanModeInputs.forEach((input) => {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      setScanMode(input.value || 'normal');
      updateScanModeUi();
      if (!modal.hidden) runSearch();
    });
  });

  if (selectAll) {
    selectAll.addEventListener('change', () => {
      currentItems.forEach((item) => { item.selected = selectAll.checked; });
      grid.querySelectorAll('.vi-card-check input').forEach((box) => {
        box.checked = selectAll.checked;
      });
    });
  }

  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !message.type) return;
      const isTopFrame = window.top === window.self;
      if (message.type === 'vi-toggle') {
        if (!isTopFrame) return;
        stopInspect();
        openAllVideos();
      } else if (message.type === 'vi-open-last') {
        // 右键菜单只发到命中的 frame，iframe 里也要能打开，否则跨域播放器永远扫不到
        stopInspect();
        setScanMode('normal');
        updateScanModeUi();
        // 用右键命中的视频容器做扫描根；找不到再回退整页
        const root = (lastContextTarget && lastContextTarget.isConnected && findVideoRoot(lastContextTarget))
          || (picked && picked.isConnected && findVideoRoot(picked) ? picked : null)
          || document.body || document.documentElement;
        openModal(root);
      }
    });
  } catch (_) {}

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || msg.type !== 'vi-manifest-found') return;
      forwardManifest([{ url: msg.url, kind: msg.kind }]);
    });
    // 拉取注入前已发出的请求
    chrome.runtime.sendMessage({ type: 'vi-get-manifests' }, (resp) => {
      if (resp && resp.ok && Array.isArray(resp.items)) forwardManifest(resp.items);
    });
  } catch (_) {}

  document.addEventListener(RESOURCES, (event) => {
    let data;
    try { data = JSON.parse(event.detail); } catch (_) { return; }
    if (!data || !Array.isArray(data.items)) return;
    applyCapturedResources(data.items);
  });

  document.addEventListener(SCAN_RESULT, (event) => {
    let data;
    try { data = JSON.parse(event.detail); } catch (_) { return; }
    if (!data || !Array.isArray(data.items)) return;
    if (!integratingScanId || data.id !== integratingScanId) return;
    setIntegratingScanId('');
    integrateResources(data.items);
  });

  document.addEventListener(MUX_REQUEST, async (event) => {
    const data = event.detail;
    if (!data || !data.id) return;
    const { id, videoBlob, audioBlob, filename } = data;
    if (!videoBlob || !audioBlob) {
      document.dispatchEvent(new CustomEvent(MUX_RESPONSE, { detail: { id, ok: false, error: 'missing tracks' } }));
      return;
    }
    if (pendingMux.has(id)) return;
    pendingMux.add(id);
    try {
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'vi-mux-init', id, filename: filename || 'video.mp4' }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
      await blobToChunks(videoBlob, id, 'video');
      await blobToChunks(audioBlob, id, 'audio');
      await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type: 'vi-mux-go', id }, () => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve();
        });
      });
    } catch (e) {
      pendingMux.delete(id);
      document.dispatchEvent(new CustomEvent(MUX_RESPONSE, { detail: { id, ok: false, error: String(e && e.message || e) } }));
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'vi-mux-result') {
      return;
    }
    if (!pendingMux.has(msg.id)) return;
    pendingMux.delete(msg.id);
    document.dispatchEvent(new CustomEvent(MUX_RESPONSE, {
      detail: { id: msg.id, ok: !!msg.ok, size: msg.size || 0, error: msg.error || '', hasAudio: msg.hasAudio }
    }));
  });
}
