import { capturedResources, counters, currentItems, downloadQueue, downloadTasks, refreshTimer, resumeJobs, setRefreshTimer } from '../core/state.js';
import { DL_CANCEL, DL_PROGRESS, DL_REQUEST, DL_RESPONSE, DOWNLOAD_MAX_DURATION, DOWNLOAD_RESOURCE, DOWNLOAD_STALL_TIMEOUT, MAX_CONCURRENT_DOWNLOADS, MSE_DIRECT_PROGRESS, MSE_DIRECT_REQUEST, MSE_DIRECT_RESPONSE } from '../core/constants.js';
import { qualitySelect, shadow } from '../ui/mount.js';
import { t } from '../core/i18n.js';
import { candidateUrls, fileName, itemKey, jobKeyOf, resumeKeyOf } from '../core/utils.js';
import { setButtonLoading } from './modal.js';
import { applyDownloadedSize } from './discovery.js';
import { showAreaToast } from './inspect.js';

function requestDownload(url, filename, onProgress, task, options) {
  const id = 'vi-' + (++counters.download);
  if (task) task.id = id;
  options = options || {};
  return new Promise((resolve) => {
    if (task && task.cancelled) {
      resolve({ ok: false, error: 'cancelled' });
      return;
    }
    let settled = false;
    let stallTimer = 0;
    let maxTimer = 0;
    const cancelRequest = () => {
      try {
        document.dispatchEvent(new CustomEvent(DL_CANCEL, { detail: JSON.stringify({ id }) }));
      } catch (_) {}
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      clearTimeout(maxTimer);
      document.removeEventListener(DL_RESPONSE, onResponse, true);
      document.removeEventListener(DL_PROGRESS, onProgressEvent, true);
      resolve(value);
    };
    const resetStallTimer = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        cancelRequest();
        finish({ ok: false, error: 'stalled' });
      }, DOWNLOAD_STALL_TIMEOUT);
    };
    const onResponse = (event) => {
      let data;
      try { data = JSON.parse(event.detail); } catch (_) { return; }
      if (data && data.id === id) finish(data);
    };
    const onProgressEvent = (event) => {
      let data;
      try { data = JSON.parse(event.detail); } catch (_) { return; }
      if (!data || data.id !== id) return;
      if (onProgress && typeof data.percent === 'number') onProgress(data.percent, data.phase, data);
      if (data.phase === 'verifying') clearTimeout(stallTimer);
      else resetStallTimer();
    };
    document.addEventListener(DL_RESPONSE, onResponse, true);
    document.addEventListener(DL_PROGRESS, onProgressEvent, true);
    resetStallTimer();
    maxTimer = setTimeout(() => {
      cancelRequest();
      finish({ ok: false, error: 'timeout' });
    }, DOWNLOAD_MAX_DURATION);
    try {
      const detail = { id, url, filename };
      if (options.duration) detail.expectedDuration = options.duration;
      if (options.size) detail.expectedSize = options.size;
      if (options.kind) detail.forceKind = options.kind;
      if (options.videoUrl) detail.videoUrl = options.videoUrl;
      if (options.audioUrl) detail.audioUrl = options.audioUrl;
      if (options.pageUrl) detail.pageUrl = options.pageUrl;
      if (options.jobKey) detail.jobKey = options.jobKey;
      if (qualitySelect && qualitySelect.value) detail.qualityId = qualitySelect.value;
      document.dispatchEvent(new CustomEvent(DL_REQUEST, { detail: JSON.stringify(detail) }));
    } catch (_) {
      finish({ ok: false, error: 'dispatch failed' });
    }
  });
}

// 独立 MSE 直连：所有常规候选都失败后，用页面缓存的 MSE 音视频分片合并下载。
// 走专用事件通道，完全独立于 REQUEST / resolvePlatform，与 __viMseMuxTest 同源。
function requestMseDirectMux(filename, onProgress, matchUrl, waitComplete) {
  const id = 'msedirect-' + (++counters.download);
  return new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      document.removeEventListener(MSE_DIRECT_RESPONSE, onResponse, true);
      document.removeEventListener(MSE_DIRECT_PROGRESS, onMseProgress, true);
      resolve(value);
    };
    const onResponse = (event) => {
      let data;
      try { data = JSON.parse(event.detail); } catch (_) { return; }
      if (data && data.id === id) finish(data);
    };
    const onMseProgress = (event) => {
      let data;
      try { data = JSON.parse(event.detail); } catch (_) { return; }
      if (!onProgress || !data || data.id !== id || typeof data.percent !== 'number') return;
      onProgress(data.percent, data.phase || (waitComplete ? 'waiting' : 'merging'), data);
    };
    document.addEventListener(MSE_DIRECT_RESPONSE, onResponse, true);
    document.addEventListener(MSE_DIRECT_PROGRESS, onMseProgress, true);
    if (onProgress) onProgress(0, waitComplete ? 'waiting' : 'merging', { note: '准备完整视频流' });
    // 完整流等待最长 15 分钟，ffmpeg 合并最长 20 分钟，外层再留余量避免提前判失败。
    timer = setTimeout(() => finish({ ok: false, error: 'MSE 直连合并超时' }), waitComplete ? 40 * 60 * 1000 : 4 * 60 * 1000);
    try {
      document.dispatchEvent(new CustomEvent(MSE_DIRECT_REQUEST, {
        detail: JSON.stringify({ id, filename, matchUrl, waitComplete: !!waitComplete })
      }));
    } catch (_) {
      finish({ ok: false, error: 'MSE 直连派发失败' });
    }
  });
}

// ===== 下载队列：最多 2 个并发，其余排队，批量下载有整体状态 =====

function scheduleRefresh() {
  if (refreshTimer) return;
  setRefreshTimer(setTimeout(() => {
    setRefreshTimer(0);
    refreshDownloadButtons();
  }, 200));
}

function activeDownloadCount() {
  let count = 0;
  downloadTasks.forEach((t) => { if (t.phase === 'downloading') count++; });
  return count;
}

function runTask(task) {
  if (!task || task.cancelled) return;
  task.phase = 'downloading';
  // 首次执行时冻结“已捕获资源”快照，重试沿用同一份，避免串到别的视频
  if (!task.capturedSnapshot) {
    task.capturedSnapshot = capturedResources ? Array.from(capturedResources.values()) : [];
  }
  refreshDownloadButtons();
  downloadItem(task.item, (percent, phase, data) => {
    if (typeof percent === 'number') task.percent = percent;
    if (data) {
      if (typeof data.loaded === 'number') task.loaded = data.loaded;
      if (typeof data.total === 'number' && data.total > 0) task.total = data.total;
      task.progressNote = data.note ? String(data.note) : '';
    }
    if (phase && task.phaseText !== phase) task.phaseText = phase;
    scheduleRefresh();
  }, task).then((ok) => {
    if (task.removed) return;
    task.phase = ok ? 'done' : (task.cancelled ? 'paused' : 'failed');
    task.phaseText = '';
    if (task.phase === 'done') {
      task.percent = 100;
      resumeJobs.delete(resumeKeyOf(task.item));
    }
    refreshDownloadButtons();
    pumpQueue();
  }).catch(() => {
    if (task.removed) return;
    task.phase = 'failed';
    task.phaseText = '';
    refreshDownloadButtons();
    pumpQueue();
  });
}

function pumpQueue() {
  while (downloadQueue.length && activeDownloadCount() < MAX_CONCURRENT_DOWNLOADS) {
    const next = downloadQueue.shift();
    if (!next || next.cancelled) continue;
    runTask(next);
  }
}

function startDownload(item) {
  if (!item) return null;
  const key = itemKey(item);
  const prev = downloadTasks.get(key);
  if (prev && (prev.phase === 'downloading' || prev.phase === 'queued')) return prev;

  const baseName = String(fileName(item)).replace(/\.[^.]+$/, '');
  const job = resumeJobs.get(jobKeyOf(item) || baseName);
  const startPercent = (prev && prev.phase === 'paused' && prev.percent) || (job ? job.percent : 0);
  const task = {
    cancelled: false,
    id: null,
    phase: 'queued',
    item,
    phaseText: '',
    lastError: '',
    percent: startPercent,
    loaded: (prev && prev.phase === 'paused' && prev.loaded) || (job ? job.size || 0 : 0),
    total: (prev && prev.phase === 'paused' && prev.total) || 0,
    // 记录发起时的页面地址与已解析成功的源，重试时优先复用，避免解析到页面当前播放的另一个视频
    pageUrl: (prev && prev.pageUrl) || location.href,
    sourceUrl: (prev && prev.sourceUrl) || '',
    sourceVideoUrl: (prev && prev.sourceVideoUrl) || '',
    sourceAudioUrl: (prev && prev.sourceAudioUrl) || '',
    sourceKind: (prev && prev.sourceKind) || '',
    capturedSnapshot: (prev && prev.capturedSnapshot) || null
  };
  downloadTasks.set(key, task);
  downloadQueue.push(task);
  refreshDownloadButtons();
  pumpQueue();
  return task;
}

function pauseAllDownloads() {
  downloadTasks.forEach((task) => {
    if (task.phase === 'downloading') {
      task.cancelled = true;
      task.phase = 'paused';
      if (task.id) {
        try { document.dispatchEvent(new CustomEvent(DL_CANCEL, { detail: JSON.stringify({ id: task.id }) })); } catch (_) {}
      }
    } else if (task.phase === 'queued') {
      task.cancelled = true;
      task.phase = 'paused';
    }
  });
  pumpQueue();
  refreshDownloadButtons();
}

// 单个任务取消：中断网络请求、从队列与列表中移除
function cancelTask(task) {
  if (!task || task.removed) return;
  task.removed = true;
  task.cancelled = true;
  if (task.id) {
    try { document.dispatchEvent(new CustomEvent(DL_CANCEL, { detail: JSON.stringify({ id: task.id }) })); } catch (_) {}
  }
  const qi = downloadQueue.indexOf(task);
  if (qi >= 0) downloadQueue.splice(qi, 1);
  downloadTasks.forEach((value, key) => {
    if (value === task) downloadTasks.delete(key);
  });
  resumeJobs.delete(resumeKeyOf(task.item));
  pumpQueue();
  refreshDownloadButtons();
}

function retryFailedDownloads() {
  const retry = [];
  downloadTasks.forEach((task) => {
    if (task.phase === 'failed') retry.push(task);
  });
  retry.forEach((task) => {
    task.cancelled = false;
    task.phase = 'queued';
    task.lastError = '';
    task.phaseText = '';
    downloadQueue.push(task);
  });
  pumpQueue();
  refreshDownloadButtons();
}

function clearFinishedDownloads() {
  downloadTasks.forEach((task, key) => {
    if (task.phase === 'done') downloadTasks.delete(key);
  });
  refreshDownloadButtons();
}

function activeStatusText(task) {
  const phaseKey = task.phaseText === 'waiting' ? 'phaseWaiting'
    : task.phaseText === 'merging' ? 'phaseMerging'
    : task.phaseText === 'verifying' ? 'phaseVerifying'
    : task.phaseText === 'resolving' ? 'phaseResolving' : '';
  const pct = task.percent > 0 ? ' ' + Math.min(100, Math.round(task.percent)) + '%' : '';
  return phaseKey ? t(phaseKey) + pct : t('downloading') + pct;
}

function taskStatusText(task) {
  if (task.phase === 'done') return t('downloadDone');
  if (task.phase === 'queued') return t('queuedText');
  if (task.phase === 'paused') return t('resumeText', { percent: task.percent || 0 });
  if (task.phase === 'failed') return t('downloadFailed');
  return activeStatusText(task);
}

function renderQueueList(tasks) {
  const panel = shadow.querySelector('.vi-queue-panel');
  const list = shadow.querySelector('.vi-queue-list');
  if (!panel || !list || panel.hidden) return;
  if (!tasks.length) {
    const empty = document.createElement('div');
    empty.className = 'vi-queue-empty';
    empty.textContent = t('queueEmpty');
    list.replaceChildren(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  tasks.forEach((task) => {
    const row = document.createElement('div');
    row.className = 'vi-queue-item';
    const top = document.createElement('div');
    top.className = 'vi-queue-item-top';
    const name = document.createElement('span');
    name.className = 'vi-queue-name';
    name.textContent = fileName(task.item) || t('queueItemFallback');
    name.title = name.textContent;
    const state = document.createElement('span');
    const stateClass = task.phase === 'done' ? 'is-done'
      : task.phase === 'failed' ? 'is-failed'
      : task.phase === 'downloading' ? 'is-active' : '';
    state.className = 'vi-queue-state ' + stateClass;
    state.textContent = taskStatusText(task);
    if (task.progressNote) state.title = task.progressNote;
    top.append(name, state);
    if (task.phase !== 'done') {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'vi-queue-cancel';
      cancel.title = t('cancelDownload');
      cancel.setAttribute('aria-label', t('cancelDownload'));
      cancel.textContent = '×';
      cancel.addEventListener('click', (event) => {
        event.stopPropagation();
        cancelTask(task);
      });
      top.append(cancel);
    }
    row.append(top);
    if (task.phase === 'downloading' || task.phase === 'paused') {
      const bar = document.createElement('div');
      bar.className = 'vi-queue-item-bar';
      const fill = document.createElement('i');
      fill.style.width = Math.max(0, Math.min(100, task.percent || 0)) + '%';
      bar.append(fill);
      row.append(bar);
    }
    frag.append(row);
  });
  list.replaceChildren(frag);
}

function toggleQueuePanel(show) {
  const panel = shadow.querySelector('.vi-queue-panel');
  if (!panel) return;
  const next = typeof show === 'boolean' ? show : panel.hidden;
  panel.hidden = !next;
  if (next) renderDownloadSummary();
}

function renderDownloadSummary() {
  const fab = shadow.querySelector('.vi-queue-fab');
  const panel = shadow.querySelector('.vi-queue-panel');
  if (!fab || !panel) return;
  const tasks = Array.from(downloadTasks.values());
  if (!tasks.length) {
    fab.hidden = true;
    panel.hidden = true;
    return;
  }
  const counts = { done: 0, failed: 0, active: 0, queued: 0, paused: 0 };
  let loaded = 0;
  let total = 0;
  tasks.forEach((task) => {
    if (task.phase === 'done') counts.done++;
    else if (task.phase === 'failed') counts.failed++;
    else if (task.phase === 'queued') counts.queued++;
    else if (task.phase === 'paused') counts.paused++;
    else counts.active++;
    loaded += task.loaded || 0;
    total += task.total || 0;
  });
  // 暂停中的任务也计入“未完成”，进度条按字节优先、否则按完成条数
  const percent = total > 0
    ? Math.round((loaded / total) * 100)
    : Math.round((counts.done / tasks.length) * 100);
  fab.hidden = false;
  fab.classList.toggle('active', counts.active > 0);
  const countEl = fab.querySelector('.vi-queue-fab-count');
  if (countEl) countEl.textContent = String(tasks.length);
  if (panel.hidden) return;
  const fill = panel.querySelector('.vi-queue-fill');
  if (fill) fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
  const stats = panel.querySelector('.vi-queue-stats');
  if (stats) {
    stats.textContent = t('dlStats', {
      done: counts.done,
      total: tasks.length,
      active: counts.active,
      queued: counts.queued,
      failed: counts.failed
    }) + (counts.paused ? ' · ' + t('pausedCount', { count: counts.paused }) : '');
  }
  renderQueueList(tasks);
}

function refreshDownloadButtons() {
  if (!currentItems || !currentItems.length) {
    renderDownloadSummary();
    return;
  }
  currentItems.forEach((item) => {
    const task = downloadTasks.get(itemKey(item));
    const card = shadow.querySelector('.vi-card[data-index="' + item.index + '"]');
    if (!card) return;
    const button = card.querySelector('[data-action="download"]');
    if (button) {
      if (task && task.phase === 'downloading') {
        setButtonLoading(button, true, activeStatusText(task));
      } else {
        setButtonLoading(button, false);
        if (task && task.phase === 'done') button.textContent = t('downloadDone');
        else if (task && task.phase === 'queued') button.textContent = t('queuedText');
        else if (task && task.phase === 'paused') {
          button.textContent = t('resumeText', { percent: task.percent || 0 });
        } else if (task && task.phase === 'failed') {
          button.textContent = t('downloadFailed');
          button.title = task.lastError || '';
        } else if (!task) {
          const job = resumeJobs.get(resumeKeyOf(item));
          button.textContent = job ? t('resumeText', { percent: job.percent }) : t('download');
        }
      }
    }
    syncDoneBadge(card, !!(task && task.phase === 'done'));
  });
  const allButton = shadow.querySelector('[data-action="download-all"]');
  if (allButton) {
    let active = 0;
    downloadTasks.forEach((t) => { if (t.phase === 'downloading') active++; });
    if (active > 0) setButtonLoading(allButton, true, t('downloading'));
    else setButtonLoading(allButton, false);
  }
  renderDownloadSummary();
}

function downloadCapturedResource(item, task, forceExt) {
  return new Promise((resolve) => {
    const id = 'vi-res-' + (++counters.download);
    if (task) task.id = id;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      document.removeEventListener(DL_RESPONSE, onResponse, true);
      clearTimeout(timer);
      resolve(value);
    };
    const onResponse = (event) => {
      let data;
      try { data = JSON.parse(event.detail); } catch (_) { return; }
      if (data && data.id === id) finish(data);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), 120000);
    document.addEventListener(DL_RESPONSE, onResponse, true);
    try {
      document.dispatchEvent(new CustomEvent(DOWNLOAD_RESOURCE, {
        detail: JSON.stringify({
          id: item.resourceId,
          requestId: id,
          filename: fileName(item, forceExt),
          expectedDuration: item.el && Number.isFinite(item.el.duration) ? item.el.duration : 0
        })
      }));
    } catch (_) {
      finish({ ok: false, error: 'dispatch failed' });
    }
  });
}

function buildCandidates(item, task) {
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate) return;
    const key = candidate.kind && candidate.url ? candidate.kind + ':' + candidate.url : (candidate.url || candidate.resourceId);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  // 0. 重试时优先复用上次真正下载成功的那个地址，保证还是同一个视频；
  //    地址过期（403/404）时再走后面的重新解析。
  if (task && task.sourceUrl) {
    add({
      url: task.sourceUrl,
      videoUrl: task.sourceVideoUrl || '',
      audioUrl: task.sourceAudioUrl || '',
      kind: task.sourceKind || ''
    });
  }

  const fallbackPageUrl = (task && task.pageUrl) || location.href;

  if (item && item.discovered) {
    // 发现的资源：按其自身类型下载，不用当前页面 URL 做平台解析（会串台）。
    if (item.audioUrl && item.videoUrl) {
      add({ kind: 'streams', url: item.videoUrl, videoUrl: item.videoUrl, audioUrl: item.audioUrl });
    } else if (item.resourceKind === 'hls') {
      add({ kind: 'hls', url: item.src });
    } else if (item.resourceKind === 'dash') {
      add({ kind: 'dash', url: item.src });
    } else if (item.resourceKind === 'platform') {
      add({ kind: 'platform', url: item.src, pageUrl: item.src });
    } else if (item.src) {
      add({ url: item.src });
    }
    return candidates;
  }

  // 0. 平台解析（B站/抖音主动调接口），最高优先级。
  add({ kind: 'platform', url: (item && item.src) || fallbackPageUrl });

  // 1. B站/通用 DASH 双流（playurl 解析）——完整音视频，优先下载。
  //    重试时用任务创建时的快照，避免把页面后来新捕获的、属于别的视频的流拿过来。
  const capturedList = (task && task.capturedSnapshot) || (capturedResources ? Array.from(capturedResources.values()) : []);
  capturedList.forEach((res) => {
    if (!res) return;
    if (res.kind === 'streams' && res.videoUrl) {
      add({ kind: 'streams', url: res.url, videoUrl: res.videoUrl, audioUrl: res.audioUrl || '' });
    }
  });

  // 2. 嗅探到的 m3u8/mpd 清单。
  capturedList.forEach((res) => {
    if (!res || !res.url) return;
    if (/\.m3u8(\?|#|$)/i.test(res.url)) add({ kind: 'hls', url: res.url });
    else if (/\.mpd(\?|#|$)/i.test(res.url)) add({ kind: 'dash', url: res.url });
  });

  // 2. video 元素自身的可下载源。
  candidateUrls(item).forEach((url) => {
    if (/^blob:/i.test(url) || /^mse:/i.test(url)) return;
    add({ url });
  });

  // 3. 捕获到的真实网络资源（由引擎校验完整性后才保存）。
  if (item.resourceId) add({ resourceId: item.resourceId });

  return candidates;
}

async function downloadItem(item, onProgress, task) {
  if (task && task.cancelled) return false;
  const filename = fileName(item);
  const video = item.el;
  const duration = video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const candidates = buildCandidates(item, task);
  const errors = [];
  const pageUrl = (task && task.pageUrl) || location.href;

  // 先把远端音视频流完整下载下来，合并交给 downloader 在下载结束后执行。
  // MSE 分流只有已缓冲的部分，不能再抢在下载前面，否则点一下就把半截文件合成了。
  for (const candidate of candidates) {
    if (task && task.cancelled) return false;

    let result;
    if (candidate.resourceId) {
      result = await downloadCapturedResource(item, task);
    } else {
      result = await requestDownload(candidate.url, filename, onProgress, task, {
        duration,
        kind: candidate.kind || '',
        videoUrl: candidate.videoUrl || '',
        audioUrl: candidate.audioUrl || '',
        pageUrl: candidate.pageUrl || pageUrl,
        jobKey: jobKeyOf(item)
      });
    }
    if (task && task.cancelled) return false;
    if (task && result && result.sourceUrl) {
      task.sourceUrl = result.sourceUrl;
      task.sourceVideoUrl = result.sourceVideoUrl || '';
      task.sourceAudioUrl = result.sourceAudioUrl || '';
      task.sourceKind = result.sourceKind || '';
    }
    if (result && result.ok) {
      if (result.size) applyDownloadedSize(item, result.size);
      if (result.separateTracks) showAreaToast(t('separateTracks'));
      return true;
    }
    if (result && result.error && result.error) errors.push(result.error);
  }

  // 所有远端候选都失败，才用 MSE 分流兜底；且必须等流真正结束才合并，保证完整。
  if (!task || !task.cancelled) {
    const mseResult = await requestMseDirectMux(filename, onProgress, item.src, true);
    if (mseResult && mseResult.ok) return true;
    if (mseResult && mseResult.error) errors.push(mseResult.error);
  }
  if (task) task.lastError = errors[errors.length - 1] || t('errorNoSource');
  return false;
}


function syncDoneBadge(card, done) {
  if (!card) return;
  const meta = card.querySelector('.vi-meta');
  if (!meta) return;
  let chip = meta.querySelector('.vi-chip.done');
  if (done) {
    if (!chip) {
      chip = document.createElement('span');
      chip.className = 'vi-chip done';
      chip.textContent = '✓ ' + t('completed');
      meta.appendChild(chip);
    }
  } else if (chip) {
    chip.remove();
  }
}


export { requestDownload, requestMseDirectMux, scheduleRefresh, activeDownloadCount, runTask, pumpQueue, startDownload, pauseAllDownloads, cancelTask, retryFailedDownloads, clearFinishedDownloads, taskStatusText, renderQueueList, toggleQueuePanel, renderDownloadSummary, refreshDownloadButtons, downloadCapturedResource, buildCandidates, downloadItem, syncDoneBadge };
