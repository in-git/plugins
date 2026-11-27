import { useCallback, useEffect, useState } from 'react';
import { readSidebarWidth } from '../lib/utils.js';

const DEFAULT_WIDTH = 320;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

function clampWidth(value) {
  const limit = Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.6));
  return Math.max(MIN_WIDTH, Math.min(Math.min(MAX_WIDTH, limit), Math.round(value)));
}

function saveWidth(value) {
  try { localStorage.setItem('notes-sidebar-width-v2', String(value)); } catch (err) { /* 忽略 */ }
}

/** 侧栏宽度：拖动分隔条调整、双击恢复默认，宽度持久化到 localStorage */
export default function useSidebarWidth() {
  const [width, setWidth] = useState(() => clampWidth(readSidebarWidth() || DEFAULT_WIDTH));

  const startResize = useCallback((event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    let current = startWidth;
    document.body.classList.add('is-resizing-sidebar');

    const onMove = (ev) => {
      current = clampWidth(startWidth + (ev.clientX - startX));
      setWidth(current);
    };
    const onEnd = () => {
      document.body.classList.remove('is-resizing-sidebar');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      saveWidth(current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }, [width]);

  const resetWidth = useCallback(() => {
    setWidth(DEFAULT_WIDTH);
    saveWidth(DEFAULT_WIDTH);
  }, []);

  useEffect(() => {
    const onResize = () => setWidth((prev) => clampWidth(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return { width, startResize, resetWidth };
}
