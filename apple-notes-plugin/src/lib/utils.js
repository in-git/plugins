export function uid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'n-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function displayTitle(node) {
  const title = ((node && node.title) || '').trim();
  if (title) return title;
  return node && node.type === 'doc' ? '无标题文档' : '未命名目录';
}

export function sortByOrder(a, b) {
  return (a.order || 0) - (b.order || 0);
}

export function childrenOf(nodes, parentId) {
  const parent = parentId || null;
  return nodes
    .filter((node) => (node.parentId || null) === parent)
    .sort(sortByOrder);
}

export function pathOf(node, nodeMap) {
  const path = [];
  let cur = node;
  let guard = 0;
  while (cur && guard++ < 200) {
    path.unshift(cur);
    cur = cur.parentId ? nodeMap.get(cur.parentId) : null;
  }
  return path;
}

export function subtreeIds(nodes, rootId) {
  const out = [rootId];
  childrenOf(nodes, rootId).forEach((child) => out.push(...subtreeIds(nodes, child.id)));
  return out;
}

export function imageIdsInHtml(html) {
  const ids = [];
  const re = /idb:\/\/([A-Za-z0-9-]+)/g;
  let match;
  while ((match = re.exec(html || '')) !== null) ids.push(match[1]);
  return Array.from(new Set(ids));
}

export function fmtTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  if (date.toDateString() === now.toDateString()) {
    return '今天 ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }
  const yesterday = new Date(now.getTime() - 86400000);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  if (date.getFullYear() === now.getFullYear()) {
    return date.getMonth() + 1 + '月' + date.getDate() + '日';
  }
  return date.getFullYear() + '年' + (date.getMonth() + 1) + '月' + date.getDate() + '日';
}

export function initialTheme() {
  try {
    const saved = localStorage.getItem('notes-theme');
    if (saved === 'dark' || saved === 'light') return saved;
  } catch (err) {
    /* 忽略 */
  }
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return prefersDark ? 'dark' : 'light';
}

export function readExpanded() {
  try {
    const raw = localStorage.getItem('notes-expanded');
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (err) {
    return new Set();
  }
}

export function readSelected() {
  try {
    return localStorage.getItem('notes-selected') || null;
  } catch (err) {
    return null;
  }
}

export function readSidebarWidth() {
  try {
    const value = Number(localStorage.getItem('notes-sidebar-width-v2'));
    if (Number.isFinite(value) && value > 0) return value;
  } catch (err) {
    /* 忽略 */
  }
  return null;
}
