import { boxes, grid, modal, numEl, selectAll, tip } from '../ui/mount.js';
import { capturePollTimer, currentItems, deepScanTimer, downloadTasks, scanMode, setCache, setCapturePollTimer, setCurrentItems, setDeepScanTimer, setIntegratingScanId, setPicked, setScanLoading, sizeCache } from '../core/state.js';
import { openNormalView, requestCapturedResources, requestQualities, requestResumeState, runSearch, startDeepView, updateScanModeUi } from './discovery.js';
import { cleanPageTitle, copyText, describe, formatDuration, formatSize, itemKey, videoSrc } from '../core/utils.js';
import { t } from '../core/i18n.js';
import { FEEDBACK_URL } from '../core/constants.js';
import { clearFinishedDownloads, pauseAllDownloads, retryFailedDownloads, startDownload, toggleQueuePanel } from './downloads.js';

function openModal(root) {
  if (!root || !root.isConnected) root = document.body || document.documentElement;
  setCache(new WeakMap());
  setPicked(root);
  modal.hidden = false;
  if (numEl) numEl.textContent = '0';
  if (selectAll) selectAll.checked = true;
  updateScanModeUi();

  if (scanMode === 'deep') {
    startDeepView();
  } else {
    openNormalView(root);
  }

  requestCapturedResources();
  requestQualities();
  requestResumeState();
  if (deepScanTimer) clearTimeout(deepScanTimer);
  if (capturePollTimer) clearInterval(capturePollTimer);
  setDeepScanTimer(setTimeout(requestCapturedResources, 2500));
  setCapturePollTimer(setInterval(requestCapturedResources, 5000));
}


function closeModal() {
  modal.hidden = true;
  setIntegratingScanId('');
  setScanLoading(false);
  if (deepScanTimer) clearTimeout(deepScanTimer);
  if (capturePollTimer) clearInterval(capturePollTimer);
  grid.querySelectorAll('.vi-thumb, video').forEach((el) => {
    try { el.pause && el.pause(); } catch (_) {}
  });
  setCurrentItems([]);
  boxes.replaceChildren();
  tip.style.display = 'none';
}

function buildItem(item, index) {
  const video = item.el;
  const src = item.src || videoSrc(video);
  const size = item.resourceSize || sizeCache.get(src) || 0;
  return {
    index,
    el: video,
    ox: item.ox,
    oy: item.oy,
    label: item.label || (video ? describe(video) : '视频资源'),
    customTitle: '',
    selected: true,
    src,
    poster: video ? (video.poster || '') : (item.poster || ''),
    duration: video ? formatDuration(video.duration) : '-',
    resolution: video && video.videoWidth && video.videoHeight ? video.videoWidth + '×' + video.videoHeight : '-',
    sizeText: formatSize(size),
    paused: video ? video.paused : true,
    currentTime: video ? (video.currentTime || 0) : 0,
    isResource: !video,
    resourceId: item.resourceId || '',
    resourceType: item.resourceType || '',
    resourceSize: item.resourceSize || 0
  };
}

function renderGrid() {
  grid.replaceChildren();
  grid.classList.toggle('vi-list-mode', scanMode === 'deep');

  if (!currentItems.length) {
    const empty = document.createElement('div');
    empty.className = 'vi-empty';
    const title = document.createElement('strong');
    title.textContent = t('emptyTitle');
    const desc = document.createElement('div');
    desc.textContent = t('emptyDesc');
    empty.append(title, desc);
    grid.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  if (scanMode === 'deep') {
    const header = document.createElement('div');
    header.className = 'vi-list-header';
    ['', '#', t('customTitle'), t('metaResolution'), t('metaSize'), t('source'), t('download')].forEach((label) => {
      const cell = document.createElement('span');
      cell.textContent = label;
      header.appendChild(cell);
    });
    frag.appendChild(header);
  }
  currentItems.forEach((item) => frag.appendChild(scanMode === 'deep' ? createListRow(item) : createCard(item)));
  grid.appendChild(frag);
}

function listCell(className, text, strong) {
  const cell = document.createElement('div');
  cell.className = 'vi-list-cell' + (strong ? ' strong' : '') + (className ? ' ' + className : '');
  cell.textContent = text;
  cell.title = text;
  return cell;
}

function createListRow(item) {
  const row = document.createElement('article');
  row.className = 'vi-list-row';
  if (item.hasSize && item.hasResolution) row.classList.add('vi-row-complete');
  row.setAttribute('data-index', String(item.index));
  const key = itemKey(item);
  const task = downloadTasks.get(key);

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'vi-list-check';
  check.checked = !!item.selected;
  check.title = t('selectAll');
  check.addEventListener('change', () => {
    item.selected = check.checked;
    if (selectAll) selectAll.checked = currentItems.length > 0 && currentItems.every((i) => i.selected);
  });
  row.appendChild(check);

  const index = document.createElement('span');
  index.className = 'vi-list-index';
  index.textContent = '#' + (item.index + 1);
  row.appendChild(index);

  const titleCell = document.createElement('div');
  titleCell.className = 'vi-list-title-cell';
  const titleText = item.label || (item.isResource ? t('resourcePreview') : 'video');
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'vi-list-title-input';
  titleInput.placeholder = t('customTitlePlaceholder');
  if (!item.customTitle) item.customTitle = cleanPageTitle();
  titleInput.value = item.customTitle;
  titleInput.title = titleText;
  titleInput.setAttribute('data-index', String(item.index));
  titleInput.addEventListener('input', () => { item.customTitle = titleInput.value; });
  titleCell.appendChild(titleInput);
  row.appendChild(titleCell);

  row.appendChild(listCell('', item.resolution, item.hasResolution));
  row.appendChild(listCell('', item.sizeText, item.hasSize));
  row.appendChild(listCell('', '发现 · ' + (item.discoverySource || 'scan'), false));

  const actions = document.createElement('div');
  actions.className = 'vi-list-actions';
  const downloadBtn = makeButton(t('download'), 'download', item.index, 'primary');
  if (task && task.phase === 'downloading') {
    setButtonLoading(downloadBtn, true, t('downloading'));
  } else if (task && task.phase === 'done') {
    downloadBtn.textContent = t('downloadDone');
  } else if (task && (task.phase === 'failed' || task.phase === 'cancelled')) {
    downloadBtn.textContent = t('downloadFailed');
    downloadBtn.title = task.lastError || '';
  }
  actions.appendChild(downloadBtn);
  row.appendChild(actions);

  return row;
}

function createCard(item) {
  const card = document.createElement('article');
  card.className = 'vi-card';
  card.setAttribute('data-index', String(item.index));
  const key = itemKey(item);
  const task = downloadTasks.get(key);

  const media = document.createElement('div');
  media.className = 'vi-media';
  const preview = createPreview(item);
  media.appendChild(preview);

  const index = document.createElement('span');
  index.className = 'vi-index';
  index.textContent = '#' + (item.index + 1);
  media.appendChild(index);

  const check = document.createElement('label');
  check.className = 'vi-card-check';
  const checkBox = document.createElement('input');
  checkBox.type = 'checkbox';
  checkBox.checked = !!item.selected;
  checkBox.addEventListener('change', () => {
    item.selected = checkBox.checked;
    const all = currentItems.length > 0 && currentItems.every((i) => i.selected);
    selectAll.checked = all;
  });
  check.appendChild(checkBox);
  media.appendChild(check);

  const info = document.createElement('div');
  info.className = 'vi-info';
  const infoTitle = document.createElement('div');
  infoTitle.className = 'vi-info-title';
  infoTitle.textContent = item.label || (item.isResource ? t('resourcePreview') : 'video');
  infoTitle.title = infoTitle.textContent;
  info.appendChild(infoTitle);

  const meta = document.createElement('div');
  meta.className = 'vi-meta';
  [
    t('metaResolution') + ' ' + item.resolution,
    t('metaSize') + ' ' + item.sizeText
  ].forEach((text, metaIndex) => {
    const chip = document.createElement('span');
    chip.className = 'vi-chip' + (metaIndex === 1 ? ' vi-size' : '');
    chip.textContent = text;
    meta.appendChild(chip);
  });
  if (item.discovered) {
    const sourceChip = document.createElement('span');
    sourceChip.className = 'vi-chip';
    sourceChip.textContent = '发现 · ' + (item.discoverySource || 'scan');
    meta.appendChild(sourceChip);
  }
  if (task && task.phase === 'done') {
    const doneChip = document.createElement('span');
    doneChip.className = 'vi-chip done';
    doneChip.textContent = '✓ ' + t('completed');
    meta.appendChild(doneChip);
  }
  info.appendChild(meta);
  media.appendChild(info);

  const body = document.createElement('div');
  body.className = 'vi-body';

  const titleRow = document.createElement('label');
  titleRow.className = 'vi-title-field';
  const titleLabel = document.createElement('span');
  titleLabel.className = 'vi-title-label';
  titleLabel.textContent = t('customTitle');
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'vi-title-input';
  titleInput.placeholder = t('customTitlePlaceholder');
  if (!item.customTitle) item.customTitle = cleanPageTitle();
  titleInput.value = item.customTitle;
  titleInput.setAttribute('data-index', String(item.index));
  titleInput.addEventListener('input', () => {
    item.customTitle = titleInput.value;
  });
  titleRow.append(titleLabel, titleInput);

  const actions = document.createElement('div');
  actions.className = 'vi-card-actions';
  const downloadBtn = makeButton(t('download'), 'download', item.index, 'primary vi-card-download');
  if (task && task.phase === 'downloading') {
    setButtonLoading(downloadBtn, true, t('downloading'));
  } else if (task && task.phase === 'done') {
    downloadBtn.textContent = t('downloadDone');
  } else if (task && (task.phase === 'failed' || task.phase === 'cancelled')) {
    downloadBtn.textContent = t('downloadFailed');
    downloadBtn.title = task.lastError || '';
  }
  actions.appendChild(downloadBtn);

  const row = document.createElement('div');
  row.className = 'vi-card-row';
  row.append(titleRow, actions);
  body.appendChild(row);

  card.append(media, body);
  return card;
}

function makeButton(text, action, index, extra) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'vi-btn ' + (extra || '');
  button.textContent = text;
  button.setAttribute('data-action', action);
  button.setAttribute('data-index', String(index));
  return button;
}

function makePlaceholder(text) {
  const placeholder = document.createElement('div');
  placeholder.className = 'vi-ph';
  const icon = document.createElement('span');
  icon.className = 'vi-ph-icon';
  icon.textContent = '▶';
  const label = document.createElement('span');
  label.textContent = text;
  placeholder.append(icon, label);
  return placeholder;
}

function frameFromVideo(video) {
  try {
    if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 2) return null;
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 480 / video.videoWidth);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } catch (_) {
    return null;
  }
}

function createPreview(item) {
  const frame = frameFromVideo(item.el) || item.poster;
  if (frame) {
    const image = document.createElement('img');
    image.className = 'vi-thumb';
    image.src = frame;
    image.alt = item.label;
    return image;
  }
  const placeholder = makePlaceholder(item.isResource ? (t('resourcePreview') || item.label.slice(0, 20)) : t('previewUnavailable'));
  if (item.label && /音频|audio/i.test(item.label)) {
    const icon = placeholder.querySelector('.vi-ph-icon');
    if (icon) icon.textContent = '♫';
  }
  return placeholder;
}


function onShadowClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;

  if (target === modal) {
    closeModal();
    return;
  }

  const actionEl = target.closest('[data-action]');
  if (!actionEl) return;
  const action = actionEl.getAttribute('data-action');
  const index = Number(actionEl.getAttribute('data-index'));

  if (action === 'close') closeModal();
  else if (action === 'feedback') window.open(FEEDBACK_URL, '_blank', 'noopener,noreferrer');
  else if (action === 'refresh' || action === 'search') runSearch();
  else if (action === 'download-all') {
    currentItems.filter((item) => item.selected).forEach((item) => startDownload(item));
  } else if (action === 'dl-pause') {
    pauseAllDownloads();
  } else if (action === 'dl-retry') {
    retryFailedDownloads();
  } else if (action === 'dl-clear') {
    clearFinishedDownloads();
  } else if (action === 'queue-toggle') {
    toggleQueuePanel();
  } else if (action === 'queue-close') {
    toggleQueuePanel(false);
  } else if (action === 'download') {
    const item = currentItems[index];
    if (item) startDownload(item);
  } else if (action === 'copy-all') {
    copyText(currentItems.filter((item) => item.selected).map((item) => item.src).filter(Boolean).join('\n'));
    flashButton(actionEl, t('copied'));
  } else if (action === 'copy') {
    const item = currentItems[index];
    if (item) copyText(item.src);
    flashButton(actionEl, t('copied'));
  }
}

function setButtonLoading(button, loading, loadingText) {
  if (!button || !button.isConnected) return;
  if (button.dataset.viOriginalText === undefined) button.dataset.viOriginalText = button.textContent;
  if (loading) {
    button.classList.add('vi-loading');
    button.disabled = true;
    button.replaceChildren();
    const spinner = document.createElement('span');
    spinner.className = 'vi-spinner';
    const label = document.createElement('span');
    label.textContent = loadingText || t('downloading');
    button.append(spinner, label);
  } else {
    button.classList.remove('vi-loading');
    button.disabled = false;
    const original = button.dataset.viOriginalText;
    delete button.dataset.viOriginalText;
    button.textContent = original !== undefined ? original : t('download');
  }
}

function flashButton(button, text) {
  const old = button.textContent;
  button.textContent = text;
  setTimeout(() => {
    if (button.isConnected) button.textContent = old;
  }, 1200);
}


export { openModal, closeModal, buildItem, renderGrid, listCell, createListRow, createCard, makeButton, makePlaceholder, createPreview, onShadowClick, setButtonLoading, flashButton };
