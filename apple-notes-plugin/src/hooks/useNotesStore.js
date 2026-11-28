import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteImages, deleteNodes, getAllNodes, putNode } from '../lib/db.js';
import buildSeed from '../lib/seed.js';
import {
  imageIdsInHtml,
  readExpanded,
  readSelected,
  sortByOrder,
  subtreeIds,
  uid
} from '../lib/utils.js';

/**
 * 笔记数据层：IndexedDB 读写、树结构与选中/展开状态、增删改移、右键剪贴。
 * 所有写操作都会同步落到本地数据库。
 */
export default function useNotesStore() {
  const [nodes, setNodes] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [renamingId, setRenamingId] = useState(null);
  const [autoFocusId, setAutoFocusId] = useState(null);
  // 右键复制 / 剪切暂存：{ mode: 'copy' | 'cut', id }
  const [clip, setClip] = useState(null);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [ready, setReady] = useState(false);
  const [dbError, setDbError] = useState('');

  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

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

  const copyNode = useCallback((node) => {
    if (node) setClip({ mode: 'copy', id: node.id });
  }, []);

  const cutNode = useCallback((node) => {
    if (node) setClip({ mode: 'cut', id: node.id });
  }, []);

  // 粘贴：目录 → 粘到目录内部；文档 → 粘到同级；空白处 → 粘到根
  const pasteClip = useCallback(
    async (targetNode) => {
      if (!clip) return;
      const list = nodesRef.current;
      const source = list.find((node) => node.id === clip.id);
      if (!source) {
        setClip(null);
        return;
      }

      const parentId = targetNode
        ? targetNode.type === 'folder'
          ? targetNode.id
          : targetNode.parentId || null
        : null;

      if (parentId === source.id) return;
      if (parentId && subtreeIds(list, source.id).includes(parentId)) return;

      // 剪切 = 移动，复用拖拽的移动逻辑
      if (clip.mode === 'cut') {
        setClip(null);
        await moveNode({ id: source.id, parentId, index: Number.MAX_SAFE_INTEGER });
        return;
      }

      // 复制整棵子树（图片引用共享，删除时会检查其他笔记是否仍在引用）
      const ids = subtreeIds(list, source.id);
      const idMap = new Map(ids.map((id) => [id, uid()]));
      const now = Date.now();
      const copies = ids.map((id) => {
        const node = list.find((item) => item.id === id);
        return {
          ...node,
          id: idMap.get(id),
          parentId:
            id === source.id
              ? parentId
              : node.parentId
                ? idMap.get(node.parentId) || parentId
                : null,
          order: id === source.id ? now : node.order,
          createdAt: now,
          updatedAt: now
        };
      });

      setNodes((prev) => [...prev, ...copies]);
      if (parentId) setExpanded((prev) => new Set(prev).add(parentId));

      try {
        await Promise.all(copies.map((node) => putNode(node)));
      } catch (err) {
        console.warn('[笔记] 粘贴保存失败', err);
      }
    },
    [clip, moveNode]
  );

  // ---------- 派生数据 ----------
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const selectedNode = selectedId ? nodeMap.get(selectedId) || null : null;
  const docCount = useMemo(() => nodes.filter((node) => node.type === 'doc').length, [nodes]);
  const pendingNode = pendingDeleteId ? nodeMap.get(pendingDeleteId) || null : null;

  return {
    nodes,
    nodeMap,
    docCount,
    selectedId,
    selectedNode,
    expanded,
    renamingId,
    autoFocusId,
    clip,
    pendingDeleteId,
    pendingNode,
    ready,
    dbError,
    setRenamingId,
    setPendingDeleteId,
    handlePatch,
    createNode,
    selectNode,
    toggleExpand,
    expandAll,
    collapseAll,
    startRename,
    commitRename,
    confirmDelete,
    moveNode,
    copyNode,
    cutNode,
    pasteClip
  };
}
