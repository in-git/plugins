import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SidebarTree from './components/SidebarTree.jsx';
import ContextMenu from './components/ContextMenu.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import EditorView from './components/EditorView.jsx';
import FolderView from './components/FolderView.jsx';
import { Icon } from './components/icons.jsx';
import { getAllNodes, putNode, deleteNodes, deleteImages } from './db.js';
import {
  displayTitle,
  imageIdsInHtml,
  initialTheme,
  pathOf,
  readExpanded,
  readSelected,
  readSidebarWidth,
  sortByOrder,
  subtreeIds,
  uid
} from './lib/utils.js';

const SIDEBAR_DEFAULT = 268;
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 480;

function clampSidebarWidth(value) {
  const limit = Math.max(SIDEBAR_MIN, Math.round(window.innerWidth * 0.6));
  return Math.max(SIDEBAR_MIN, Math.min(Math.min(SIDEBAR_MAX, limit), Math.round(value)));
}

function saveSidebarWidth(value) {
  try { localStorage.setItem('notes-sidebar-width', String(value)); } catch (err) { /* 忽略 */ }
}

function parentForNode(node) {
  if (!node) return null;
  return node.type === 'folder' ? node.id : node.parentId || null;
}

function Crumbs({ path, onSelect }) {
  return (
    <>
      {path.map((item, index) => (
        <React.Fragment key={item.id}>
          {index > 0 ? <span>/</span> : null}
          <button
            type="button"
            className="rounded-[4px] px-0.5 transition-colors hover:text-ink"
            onClick={() => onSelect(item.id)}
          >
            {displayTitle(item)}
          </button>
        </React.Fragment>
      ))}
    </>
  );
}

function buildSeed() {
  const now = Date.now();
  const folderId = uid();
  const subId = uid();
  const welcomeId = uid();
  const todoId = uid();

  const nodes = [
    { id: folderId, parentId: null, type: 'folder', title: '我的笔记', order: now, createdAt: now, updatedAt: now },
    {
      id: welcomeId,
      parentId: folderId,
      type: 'doc',
      title: '欢迎使用',
      order: now + 1,
      createdAt: now,
      updatedAt: now,
      html:
        '<h1>欢迎使用笔记</h1>' +
        '<p>左侧是无限层级的目录树，右侧是 AiEditor 富文本编辑器，内容与图片全部保存在本地数据库。</p>' +
        '<ul>' +
        '<li>右键目录或文档：新建、重命名、删除</li>' +
        '<li>点击目录前的小箭头展开子级，支持无限嵌套</li>' +
        '<li>工具栏可直接上传图片，图片会写入 IndexedDB</li>' +
        '</ul>' +
        '<blockquote>数据只保存在当前设备，不会上传到任何服务器。</blockquote>'
    },
    { id: subId, parentId: folderId, type: 'folder', title: '工作', order: now + 2, createdAt: now, updatedAt: now },
    {
      id: todoId,
      parentId: subId,
      type: 'doc',
      title: '待办',
      order: now + 3,
      createdAt: now,
      updatedAt: now,
      html: '<ul><li>整理本周笔记</li><li>给目录补齐标签</li></ul>'
    }
  ];

  return { nodes, selectedId: welcomeId, expanded: new Set([folderId, subId]) };
}

export default function App() {
  const [nodes, setNodes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [renamingId, setRenamingId] = useState(null);
  const [autoFocusId, setAutoFocusId] = useState(null);
  const [menu, setMenu] = useState(null);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [theme, setTheme] = useState(initialTheme);
  const [searchQuery, setSearchQuery] = useState('');
  const [ready, setReady] = useState(false);
  const [dbError, setDbError] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebarWidth(readSidebarWidth() || SIDEBAR_DEFAULT));

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  // ---------- 主题 ----------
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('notes-theme', theme); } catch (err) { /* 忽略 */ }
  }, [theme]);

  // ---------- 初始化：读取 IndexedDB ----------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const list = await getAllNodes();
        if (cancelled) return;

        if (!list.length) {
          const seed = buildSeed();
          await Promise.all(seed.nodes.map((node) => putNode(node)));
          if (cancelled) return;
          setNodes(seed.nodes);
          setExpanded(seed.expanded);
          setSelectedId(seed.selectedId);
        } else {
          setNodes(list);
          setExpanded(readExpanded());
          const last = readSelected();
          const valid = last && list.some((node) => node.id === last) ? last : null;
          const firstDoc = list
            .filter((node) => node.type === 'doc')
            .sort((a, b) => (a.order || 0) - (b.order || 0))[0];
          setSelectedId(valid || (firstDoc ? firstDoc.id : null));
        }
        setReady(true);
      } catch (err) {
        console.error('[笔记] 本地数据库初始化失败', err);
        if (!cancelled) {
          setDbError(err && err.message ? err.message : String(err));
          setReady(true);
        }
      }
    })();

    return () => { cancelled = true; };
  }, []);

  // ---------- 本地偏好持久化 ----------
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem('notes-expanded', JSON.stringify(Array.from(expanded))); } catch (err) { /* 忽略 */ }
  }, [expanded, ready]);

  useEffect(() => {
    if (!ready) return;
    try {
      if (selectedId) localStorage.setItem('notes-selected', selectedId);
      else localStorage.removeItem('notes-selected');
    } catch (err) { /* 忽略 */ }
  }, [selectedId, ready]);

  // ---------- 数据操作 ----------
  const handlePatch = useCallback(async (id, patch) => {
    const current = nodesRef.current.find((node) => node.id === id);
    if (!current) return;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    setNodes((prev) => prev.map((node) => (node.id === id ? next : node)));
    await putNode(next);
  }, []);

  const createNode = useCallback(async (type, parentId) => {
    const now = Date.now();
    const node = {
      id: uid(),
      parentId: parentId || null,
      type,
      title: type === 'doc' ? '无标题文档' : '新建目录',
      order: now,
      createdAt: now,
      updatedAt: now
    };
    if (type === 'doc') node.html = '';

    setNodes((prev) => [...prev, node]);
    if (node.parentId) setExpanded((prev) => new Set(prev).add(node.parentId));
    setSelectedId(node.id);
    setRenamingId(type === 'folder' ? node.id : null);
    if (type === 'doc') {
      setAutoFocusId(node.id);
      window.setTimeout(() => setAutoFocusId(null), 800);
    }
    try { await putNode(node); } catch (err) { console.warn('[笔记] 新建保存失败', err); }
  }, []);

  const selectNode = useCallback((id) => {
    setSelectedId(id);
    setRenamingId(null);
  }, []);

  const toggleExpand = useCallback((id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    setExpanded(new Set(nodesRef.current.filter((node) => node.type === 'folder').map((node) => node.id)));
  }, []);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  const startRename = useCallback((id) => {
    const node = nodesRef.current.find((item) => item.id === id);
    if (!node) return;
    if (node.parentId) setExpanded((prev) => new Set(prev).add(node.parentId));
    setRenamingId(id);
  }, []);

  const commitRename = useCallback((id, value) => {
    setRenamingId(null);
    const current = nodesRef.current.find((node) => node.id === id);
    if (!current) return;
    const title = value.trim() || (current.type === 'doc' ? '无标题文档' : '未命名目录');
    const next = { ...current, title, updatedAt: Date.now() };
    setNodes((prev) => prev.map((node) => (node.id === id ? next : node)));
    putNode(next).catch((err) => console.warn('[笔记] 重命名保存失败', err));
  }, []);

  const confirmDelete = useCallback(async () => {
    const targetId = pendingDeleteId;
    setPendingDeleteId(null);
    if (!targetId) return;

    const list = nodesRef.current;
    const target = list.find((node) => node.id === targetId);
    if (!target) return;

    const ids = subtreeIds(list, targetId);
    const imageIds = new Set();
    ids.forEach((id) => {
      const node = list.find((item) => item.id === id);
      if (node && node.html) imageIdsInHtml(node.html).forEach((imageId) => imageIds.add(imageId));
    });
    // 其余笔记仍在引用的图片不删除
    const stillUsed = new Set();
    list.forEach((node) => {
      if (ids.includes(node.id) || !node.html) return;
      imageIdsInHtml(node.html).forEach((imageId) => stillUsed.add(imageId));
    });

    setNodes((prev) => prev.filter((node) => !ids.includes(node.id)));
    setExpanded((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    setRenamingId((prev) => (prev && ids.includes(prev) ? null : prev));
    if (ids.includes(selectedIdRef.current)) {
      const fallback = target.parentId && !ids.includes(target.parentId) ? target.parentId : null;
      setSelectedId(fallback);
    }

    try {
      await deleteNodes(ids);
      const removable = Array.from(imageIds).filter((imageId) => !stillUsed.has(imageId));
      if (removable.length) await deleteImages(removable);
    } catch (err) {
      console.warn('[笔记] 删除失败', err);
    }
  }, [pendingDeleteId]);

  // 拖拽移动：同一层调整顺序，或移动到新的父级
  const moveNode = useCallback(async ({ id, parentId, index }) => {
    const list = nodesRef.current;
    const active = list.find((node) => node.id === id);
    if (!active) return;

    const targetParent = parentId || null;
    if (targetParent && subtreeIds(list, id).includes(targetParent)) return;

    const siblings = list
      .filter((node) => (node.parentId || null) === targetParent && node.id !== id)
      .sort(sortByOrder);
    const pos = Math.max(0, Math.min(index, siblings.length));
    const moved = { ...active, parentId: targetParent, updatedAt: Date.now() };
    siblings.splice(pos, 0, moved);

    // 同级重新编号，保证 order 连续（只写真正变化的节点）
    const changes = new Map();
    siblings.forEach((node, i) => {
      if (node.id === id || (node.order || 0) !== i) changes.set(node.id, { ...node, order: i });
    });

    setNodes((prev) => prev.map((node) => changes.get(node.id) || node));
    setRenamingId(null);
    if (targetParent) setExpanded((prev) => new Set(prev).add(targetParent));

    try {
      await Promise.all(Array.from(changes.values()).map((node) => putNode(node)));
    } catch (err) {
      console.warn('[笔记] 移动保存失败', err);
    }
  }, []);

  // 侧栏宽度：拖动分隔条调整，双击恢复默认
  const startSidebarResize = useCallback((event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    let current = startWidth;
    document.body.classList.add('is-resizing-sidebar');

    const onMove = (ev) => {
      current = clampSidebarWidth(startWidth + (ev.clientX - startX));
      setSidebarWidth(current);
    };
    const onEnd = () => {
      document.body.classList.remove('is-resizing-sidebar');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      saveSidebarWidth(current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
  }, [sidebarWidth]);

  const resetSidebarWidth = useCallback(() => {
    const next = SIDEBAR_DEFAULT;
    setSidebarWidth(next);
    saveSidebarWidth(next);
  }, []);

  useEffect(() => {
    const onResize = () => setSidebarWidth((prev) => clampSidebarWidth(prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const openMenu = useCallback((event, node) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, node });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const handleMenuAction = useCallback(
    (action, node) => {
      if (action === 'newDoc') createNode('doc', parentForNode(node));
      else if (action === 'newFolder') createNode('folder', parentForNode(node));
      else if (action === 'rename' && node) startRename(node.id);
      else if (action === 'delete' && node) setPendingDeleteId(node.id);
    },
    [createNode, startRename]
  );

  // ---------- 派生数据 ----------
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selectedNode = selectedId ? nodeMap.get(selectedId) || null : null;
  const crumbsPath = useMemo(
    () => (selectedNode ? pathOf(selectedNode, nodeMap) : []),
    [selectedNode, nodeMap]
  );
  const docCount = useMemo(() => nodes.filter((node) => node.type === 'doc').length, [nodes]);
  const pendingNode = pendingDeleteId ? nodeMap.get(pendingDeleteId) || null : null;

  const crumbs = <Crumbs path={crumbsPath} onSelect={selectNode} />;

  return (
    <div className="flex h-full">
      {/* ============ 侧栏：无限递归目录树 ============ */}
      <aside
        className="flex shrink-0 flex-col border-r border-hairline bg-panel"
        style={{ width: sidebarWidth }}
      >
        <div className="px-3 pb-1.5 pt-4">
          <div className="flex items-start justify-between gap-2 px-1">
            <div className="min-w-0">
              <div className="text-[16px] font-semibold leading-6 text-ink">多功能记事本</div>
              <div className="mt-0.5 text-[16px] leading-6 text-muted">{docCount} 篇文档 · 本地数据库</div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                className="nb-icon-btn"
                title="全部展开"
                onClick={expandAll}
              >
                <Icon name="expandAll" size={17} />
              </button>
              <button
                type="button"
                className="nb-icon-btn"
                title="全部收起"
                onClick={collapseAll}
              >
                <Icon name="collapseAll" size={17} />
              </button>
            </div>
          </div>

          <div className="mt-2.5 flex h-9 items-center gap-1.5 rounded-[8px] border border-hairline bg-canvas px-2.5 transition-shadow focus-within:ring-2 focus-within:ring-accent/20">
            <span className="shrink-0 text-muted">
              <Icon name="search" size={15} />
            </span>
            <input
              value={searchQuery}
              spellCheck={false}
              placeholder="搜索笔记"
              onChange={(e) => setSearchQuery(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-muted"
            />
            {searchQuery ? (
              <button
                type="button"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-ink/[0.06] hover:text-ink"
                title="清除搜索"
                onClick={() => setSearchQuery('')}
              >
                <Icon name="close" size={12} />
              </button>
            ) : null}
          </div>
        </div>

        <div
          id="tree"
          className="nb-scroll min-h-0 flex-1 overflow-y-auto px-2.5 pb-4 pt-2"
          onContextMenu={(e) => {
            if (e.target.closest('.tree-item')) return;
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, node: null });
          }}
        >
          <SidebarTree
            nodes={nodes}
            selectedId={selectedId}
            expanded={expanded}
            renamingId={renamingId}
            query={searchQuery}
            onSelect={selectNode}
            onToggle={toggleExpand}
            onContextMenu={openMenu}
            onStartRename={startRename}
            onCommitRename={commitRename}
            onCancelRename={() => setRenamingId(null)}
            onMove={moveNode}
          />
        </div>

        <div className="flex items-center justify-between border-t border-hairline px-3 py-2">
          <span className="text-[16px] leading-6 text-muted">本地存储 · 仅此设备</span>
          <button
            type="button"
            className="nb-icon-btn h-7 w-7"
            title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
          </button>
        </div>
      </aside>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整侧栏宽度"
        className="nb-splitter"
        title="拖动调整宽度，双击恢复默认"
        onPointerDown={startSidebarResize}
        onDoubleClick={resetSidebarWidth}
      />

      {/* ============ 右侧：目录 / 文档 ============ */}
      <main className="relative flex min-w-0 flex-1 flex-col bg-canvas">
        {dbError ? (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <h2 className="text-lead font-medium text-ink">本地数据库不可用</h2>
            <p className="mt-2 max-w-[420px] text-meta leading-relaxed text-subtle">
              {dbError}
              <br />
              请通过扩展页面或本地服务器打开，并允许站点存储数据。
            </p>
          </div>
        ) : !ready ? (
          <div className="flex h-full items-center justify-center text-meta text-muted">正在读取本地数据库…</div>
        ) : selectedNode && selectedNode.type === 'doc' ? (
          <EditorView
            key={selectedNode.id}
            node={selectedNode}
            theme={theme}
            autoFocusTitle={autoFocusId === selectedNode.id}
            crumbs={crumbs}
            onPatch={handlePatch}
          />
        ) : selectedNode ? (
          <FolderView
            node={selectedNode}
            nodes={nodes}
            crumbs={crumbs}
            onSelect={selectNode}
            onCreateDoc={() => createNode('doc', selectedNode.id)}
            onCreateFolder={() => createNode('folder', selectedNode.id)}
            onPatchTitle={(id, title) => handlePatch(id, { title })}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center px-8 text-center">
            <span className="text-muted">
              <svg
                viewBox="0 0 48 48"
                width="46"
                height="46"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="9" y="7" width="30" height="34" rx="4" />
                <path d="M16 16h16M16 23h16M16 30h9" />
              </svg>
            </span>
            <h2 className="mt-6 text-lead font-medium text-ink">选择一篇笔记</h2>
            <p className="mt-2 max-w-[360px] text-meta leading-relaxed text-subtle">
              左侧目录支持无限层级；右键可新建文档或目录。
            </p>
          </div>
        )}
      </main>

      <ContextMenu menu={menu} onClose={closeMenu} onAction={handleMenuAction} />
      <ConfirmDialog node={pendingNode} onCancel={() => setPendingDeleteId(null)} onConfirm={confirmDelete} />
    </div>
  );
}
