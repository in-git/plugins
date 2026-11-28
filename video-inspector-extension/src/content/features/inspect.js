import { active, areaMode, areaStart, areaToastTimer, cache, currentItems, downloadTasks, hovered, lastContextTarget, mouse, picked, rafId, setActive, setAreaMode, setAreaStart, setAreaToastTimer, setCache, setCurrentItems, setHovered, setLastContextTarget, setMouse, setPicked, setRafId, setScanMode, setSuppressClick, suppressClick } from '../core/state.js';
import { loadSizes, requestCapturedResources, requestQualities, updateScanModeUi } from './discovery.js';
import { buildItem, closeModal, openModal, renderGrid } from './modal.js';
import { t } from '../core/i18n.js';
import { areaOverlay, areaRect, areaTip, areaToast, boxes, grid, host, modal, numEl, selectAll, shadow, tip } from '../ui/mount.js';
import { collectVideos, deepestElement, describe, findVideoRoot, hitTest, isOwnEvent, itemKey } from '../core/utils.js';
import { MAX_DEPTH, PREVIEW_LIMIT } from '../core/constants.js';
import { refreshDownloadButtons } from './downloads.js';

function openAllVideos() {
  setScanMode('normal');
  updateScanModeUi();
  openModal(document.body || document.documentElement);
}

function startInspect() {
  setActive(true);
  setPicked(null);
  setScanMode('normal');
  updateScanModeUi();
  // 进入探查后立即按最后鼠标位置给出高亮，和“审查元素”手感一致
  computeHover();
  showAreaToast(t('badgeInspecting'));
}

function stopInspect() {
  setActive(false);
  setHovered(null);
  boxes.replaceChildren();
  tip.style.display = 'none';
}

function showAreaToast(text) {
  if (!areaToast) return;
  areaToast.textContent = text;
  areaToast.hidden = false;
  if (areaToastTimer) clearTimeout(areaToastTimer);
  setAreaToastTimer(setTimeout(() => { areaToast.hidden = true; }, 2600));
}

function startAreaMode() {
  if (!modal.hidden) closeModal();
  stopInspect();
  setAreaMode(true);
  setAreaStart(null);
  areaOverlay.hidden = false;
  areaTip.textContent = t('badgeArea');
  areaTip.hidden = false;
  areaRect.hidden = true;
}

function stopAreaMode() {
  setAreaMode(false);
  setAreaStart(null);
  areaOverlay.hidden = true;
  areaTip.hidden = true;
  areaRect.hidden = true;
}

function updateAreaRect(event) {
  if (!areaRect || !areaStart) return;
  const left = Math.min(areaStart.x, event.clientX);
  const top = Math.min(areaStart.y, event.clientY);
  const width = Math.abs(event.clientX - areaStart.x);
  const height = Math.abs(event.clientY - areaStart.y);
  areaRect.style.left = left + 'px';
  areaRect.style.top = top + 'px';
  areaRect.style.width = width + 'px';
  areaRect.style.height = height + 'px';
  areaRect.hidden = width < 2 || height < 2;
  if (width >= 2 && height >= 2) {
    const count = countVideosInRect({ left, top, width, height });
    areaTip.textContent = t('areaFound', { count });
  }
}

function countVideosInRect(rect) {
  const videos = collectVideos(document.body || document.documentElement, 0, 0, 0, [], new Set(), MAX_DEPTH);
  return videos.filter((item) => {
    const box = item.el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    return !(box.right < rect.left || box.left > rect.left + rect.width ||
      box.bottom < rect.top || box.top > rect.top + rect.height);
  }).length;
}

function finishAreaSelection() {
  if (!areaRect || areaRect.hidden || !areaStart) return;
  const rect = {
    left: parseFloat(areaRect.style.left) || 0,
    top: parseFloat(areaRect.style.top) || 0,
    width: parseFloat(areaRect.style.width) || 0,
    height: parseFloat(areaRect.style.height) || 0
  };
  stopAreaMode();
  if (rect.width < 8 || rect.height < 8) return;

  const videos = collectVideos(document.body || document.documentElement, 0, 0, 0, [], new Set(), MAX_DEPTH).filter((item) => {
    const box = item.el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return false;
    const visibleLeft = Math.max(box.left, rect.left);
    const visibleTop = Math.max(box.top, rect.top);
    const visibleRight = Math.min(box.right, rect.left + rect.width);
    const visibleBottom = Math.min(box.bottom, rect.top + rect.height);
    if (visibleRight <= visibleLeft || visibleBottom <= visibleTop) return false;
    const visibleArea = (visibleRight - visibleLeft) * (visibleBottom - visibleTop);
    return visibleArea >= Math.min(box.width * box.height * 0.25, 2500);
  });

  if (!videos.length) {
    showAreaToast(t('areaEmpty'));
    return;
  }
  showAreaToast(t('areaFound', { count: videos.length }));
  setCache(new WeakMap());
  setPicked(document.body || document.documentElement);
  openAreaModal(videos);
}

function openAreaModal(videos) {
  modal.hidden = false;
  if (numEl) numEl.textContent = '0';
  if (selectAll) selectAll.checked = true;
  setScanMode('normal');
  updateScanModeUi();
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
  }
  loadSizes();
  requestCapturedResources();
  requestQualities();
}

function schedule() {
  if (!active || rafId) return;
  setRafId(requestAnimationFrame(() => {
    setRafId(0);
    computeHover();
  }));
}

function onMouseMove(event) {
  if (areaMode) {
    if (areaStart) updateAreaRect(event);
    return;
  }
  if (!active || isOwnEvent(event)) return;
  setMouse({ x: event.clientX, y: event.clientY });
  schedule();
}

function onMouseDown(event) {
  if (areaMode) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setAreaStart({ x: event.clientX, y: event.clientY });
    areaRect.hidden = true;
    return;
  }
  if (!active || event.button !== 0 || isOwnEvent(event)) return;
  event.preventDefault();
  event.stopPropagation();
  setSuppressClick(true);
  setTimeout(() => { setSuppressClick(false); }, 400);

  const hit = hitTest(document, event.clientX, event.clientY);
  if (!hit) return;
  // 命中元素内确实有视频才打开模态框；没有就留在探查模式继续点
  const lookup = (node) => {
    let list = cache.get(node);
    if (!list) {
      list = collectVideos(node, 0, 0, 0);
      cache.set(node, list);
    }
    return list;
  };
  let target = hit.el;
  let videos = lookup(target);
  // 点到封面/控件等子元素时，向上（含 shadow host）找到最近含视频的容器
  if (!videos.length) {
    const near = findVideoRoot(hit.el);
    if (near) {
      target = near;
      videos = lookup(near);
    }
  }
  if (!videos.length) {
    setMouse({ x: event.clientX, y: event.clientY });
    setHovered({ ...hit, videos, label: describe(hit.el) });
    renderHover();
    showAreaToast(t('inspectEmpty'));
    return;
  }
  setPicked(target);
  stopInspect();
  openModal(picked);
}

function onMouseUp(event) {
  if (!areaMode || !areaStart) return;
  event.preventDefault();
  event.stopPropagation();
  finishAreaSelection();
}

function onPageClick(event) {
  if (areaMode) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (suppressClick && !isOwnEvent(event)) {
    setSuppressClick(false);
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (active && !isOwnEvent(event)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

function onContextMenu(event) {
  if (isOwnEvent(event)) return;
  const node = deepestElement(event);
  if (!node) return;
  setMouse({ x: event.clientX, y: event.clientY });
  // 右键常常落在播放器控件/浮层上，向上找最近一个真正包含视频的容器
  setLastContextTarget(findVideoRoot(node) || node);
  setPicked(lastContextTarget);
}

function onKeyDown(event) {
  if (event.altKey && (event.key === 's' || event.key === 'S')) {
    event.preventDefault();
    event.stopPropagation();
    if (areaMode) stopAreaMode();
    if (active) {
      stopInspect();
      return;
    }
    if (!modal.hidden) closeModal();
    startInspect();
    return;
  }
  if (areaMode) {
    if (event.key === 'Escape') {
      event.preventDefault();
      stopAreaMode();
    }
    return;
  }
  if (!modal.hidden) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
    }
    return;
  }
  if (event.key === 'Escape' && active) {
    event.preventDefault();
    stopInspect();
    return;
  }
}

function computeHover() {
  if (!active) return;
  const hit = hitTest(document, mouse.x, mouse.y);
  if (!hit) {
    setHovered(null);
    renderHover();
    return;
  }
  let videos = cache.get(hit.el);
  if (!videos) {
    videos = collectVideos(hit.el, 0, 0, 0);
    cache.set(hit.el, videos);
  }
  setHovered({ ...hit, videos, label: describe(hit.el) });
  renderHover();
}

function renderHover() {
  boxes.replaceChildren();
  if (!hovered) {
    tip.style.display = 'none';
    return;
  }
  addBox(hovered.rect, 'element', hovered.label);
  hovered.videos.slice(0, PREVIEW_LIMIT).forEach((item, index) => {
    const rect = item.el.getBoundingClientRect();
    addBox({
      left: rect.left + item.ox,
      top: rect.top + item.oy,
      width: rect.width,
      height: rect.height
    }, 'video', t('hoverVideoIndex', { index: index + 1 }));
  });
  tip.textContent = hovered.label + '  |  ' + t('hoverVideoCount', { count: hovered.videos.length });
  tip.style.display = 'block';
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  tip.style.left = Math.max(8, Math.min(mouse.x + 16, window.innerWidth - tw - 8)) + 'px';
  tip.style.top = Math.max(8, Math.min(mouse.y + 16, window.innerHeight - th - 8)) + 'px';
}

function addBox(rect, type, label) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return;
  const box = document.createElement('div');
  box.className = 'vi-box ' + type;
  box.style.left = rect.left + 'px';
  box.style.top = rect.top + 'px';
  box.style.width = rect.width + 'px';
  box.style.height = rect.height + 'px';
  const tag = document.createElement('span');
  tag.className = 'vi-box-label';
  tag.textContent = label;
  box.appendChild(tag);
  boxes.appendChild(box);
}


export { openAllVideos, startInspect, stopInspect, showAreaToast, startAreaMode, stopAreaMode, updateAreaRect, countVideosInRect, finishAreaSelection, openAreaModal, schedule, onMouseMove, onMouseDown, onMouseUp, onPageClick, onContextMenu, onKeyDown, computeHover, renderHover, addBox };
