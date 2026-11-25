import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import { Icon } from './icons.jsx';
import { childrenOf, displayTitle, sortByOrder, subtreeIds } from '../lib/utils.js';

function RenameInput({ initial, onCommit, onCancel }) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      className="tree-rename"
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
    />
  );
}

function TreeNode({
  node,
  depth,
  nodes,
  selectedId,
  expanded,
  renamingId,
  dropHint,
  searching,
  visibleIds,
  onSelect,
  onToggle,
  onContextMenu,
  onStartRename,
  onCommitRename,
  onCancelRename
}) {
  const kids =
    node.type === 'folder'
      ? childrenOf(nodes, node.id).filter((kid) => !searching || visibleIds.has(kid.id))
      : [];
  // 搜索时强制展开，便于看清匹配项所在层级
  const open = searching || expanded.has(node.id);

  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: node.id,
    data: { node },
    disabled: searching
  });
  const { setNodeRef: setDropRef } = useDroppable({
    id: 'drop:' + node.id,
    data: { node }
  });
  const setRefs = useCallback(
    (el) => {
      setDragRef(el);
      setDropRef(el);
    },
    [setDragRef, setDropRef]
  );

  const hit = dropHint && dropHint.id === node.id ? dropHint.position : null;
  const stateClass =
    (node.id === selectedId ? ' is-active' : '') +
    (isDragging ? ' is-dragging' : '') +
    (hit === 'before' ? ' is-drop-before' : '') +
    (hit === 'after' ? ' is-drop-after' : '') +
    (hit === 'inside' ? ' is-drop-inside' : '');

  return (
    <div>
      <div
        ref={setRefs}
        {...attributes}
        {...listeners}
        className={'tree-item' + stateClass}
        style={{ paddingLeft: 8 + depth * 12 }}
        title={displayTitle(node)}
        onClick={() => onSelect(node.id)}
        onDoubleClick={() => onStartRename(node.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, node);
        }}
      >
        {node.type === 'folder' && kids.length ? (
          <span
            className={'tree-chevron' + (open ? ' is-open' : '')}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
          >
            <Icon name="chevron" size={12} stroke={1.6} />
          </span>
        ) : (
          <span className="tree-chevron is-leaf" />
        )}
        <span className="tree-icon">
          <Icon name={node.type === 'folder' ? 'folder' : 'doc'} size={15} />
        </span>
        {renamingId === node.id ? (
          <RenameInput
            initial={node.title || ''}
            onCommit={(value) => onCommitRename(node.id, value)}
            onCancel={onCancelRename}
          />
        ) : (
          <span className="tree-title">{displayTitle(node)}</span>
        )}
      </div>

      {node.type === 'folder' && open && kids.length
        ? kids.map((kid) => (
            <TreeNode
              key={kid.id}
              node={kid}
              depth={depth + 1}
              nodes={nodes}
              selectedId={selectedId}
              expanded={expanded}
              renamingId={renamingId}
              dropHint={dropHint}
              searching={searching}
              visibleIds={visibleIds}
              onSelect={onSelect}
              onToggle={onToggle}
              onContextMenu={onContextMenu}
              onStartRename={onStartRename}
              onCommitRename={onCommitRename}
              onCancelRename={onCancelRename}
            />
          ))
        : null}
    </div>
  );
}

export default function SidebarTree({
  nodes,
  selectedId,
  expanded,
  renamingId,
  onSelect,
  onToggle,
  onContextMenu,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onMove,
  query
}) {
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 5 } }));

  const keyword = (query || '').trim().toLowerCase();
  const searching = keyword.length > 0;

  // 搜索时保留命中节点及其完整祖先链，维持层级上下文
  const visibleIds = useMemo(() => {
    if (!searching) return null;
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const ids = new Set();
    nodes.forEach((node) => {
      if (!displayTitle(node).toLowerCase().includes(keyword)) return;
      let cur = node;
      let guard = 0;
      while (cur && guard++ < 200) {
        ids.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : null;
      }
    });
    return ids;
  }, [nodes, keyword, searching]);

  const roots = childrenOf(nodes, null).filter((node) => !searching || visibleIds.has(node.id));

  const [dragId, setDragId] = useState(null);
  const [dropHint, setDropHint] = useState(null);
  const hintRef = useRef(null);
  // 拖拽结束后浏览器仍会派发 click，短暂屏蔽，避免误选中 / 误触发重命名
  const clickGuardRef = useRef(0);

  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const dragNode = dragId ? nodeMap.get(dragId) || null : null;

  const setHint = (next) => {
    const prev = hintRef.current;
    if (prev === next) return;
    if (prev && next && prev.id === next.id && prev.position === next.position) return;
    hintRef.current = next;
    setDropHint(next);
  };

  const resetDrag = () => {
    setDragId(null);
    setHint(null);
  };

  const handleDragStart = ({ active }) => {
    setDragId(active.id);
    setHint(null);
  };

  const handleDragMove = (event) => {
    const { active, over } = event;
    const overNode = over && over.data.current ? over.data.current.node : null;
    if (!overNode || overNode.id === active.id) {
      setHint(null);
      return;
    }
    // 不能拖进自己的子树
    if (subtreeIds(nodes, active.id).includes(overNode.id)) {
      setHint(null);
      return;
    }

    // 指针纵坐标 = 按下点 + 拖拽位移
    const activator = event.activatorEvent;
    const startY = activator && typeof activator.clientY === 'number' ? activator.clientY : 0;
    const pointerY = startY + event.delta.y;
    const rect = over.rect;
    const ratio = rect.height ? (pointerY - rect.top) / rect.height : 0.5;

    let position;
    if (overNode.type === 'folder') {
      // 目录：上沿排序 / 中间放入 / 下沿排序
      if (ratio < 0.3) position = 'before';
      else if (ratio > 0.7) position = 'after';
      else position = 'inside';
    } else {
      position = ratio < 0.5 ? 'before' : 'after';
    }
    setHint({ id: overNode.id, position });
  };

  const handleDragEnd = (event) => {
    const { active, over } = event;
    const hint = hintRef.current;
    const overNode = over && over.data.current ? over.data.current.node : null;
    resetDrag();

    if (!hint || !overNode || overNode.id === active.id) return;
    const activeNode = nodeMap.get(active.id);
    if (!activeNode) return;

    const inside = hint.position === 'inside';
    const targetParent = inside ? overNode.id : overNode.parentId || null;
    if (targetParent === active.id) return;
    if (targetParent && subtreeIds(nodes, active.id).includes(targetParent)) return;

    const siblings = nodes
      .filter((node) => (node.parentId || null) === targetParent && node.id !== active.id)
      .sort(sortByOrder);

    let index;
    if (inside) {
      index = siblings.length;
    } else {
      const i = siblings.findIndex((node) => node.id === overNode.id);
      index = i < 0 ? siblings.length : i + (hint.position === 'after' ? 1 : 0);
    }

    clickGuardRef.current = Date.now() + 300;
    onMove({ id: active.id, parentId: targetParent, index });
  };

  const handleSelect = (id) => {
    if (Date.now() < clickGuardRef.current) return;
    onSelect(id);
  };

  if (!roots.length) {
    return (
      <div className="px-3 py-10 text-center text-[16px] leading-7 text-muted">
        {searching ? (
          <>没有找到匹配的笔记</>
        ) : (
          <>
            还没有内容
            <br />
            右键空白处可新建文档或目录
          </>
        )}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={resetDrag}
    >
      <div className="space-y-0.5">
        {roots.map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            depth={0}
            nodes={nodes}
            selectedId={selectedId}
            expanded={expanded}
            renamingId={renamingId}
            dropHint={dropHint}
            searching={searching}
            visibleIds={visibleIds}
            onSelect={handleSelect}
            onToggle={onToggle}
            onContextMenu={onContextMenu}
            onStartRename={onStartRename}
            onCommitRename={onCommitRename}
            onCancelRename={onCancelRename}
          />
        ))}
      </div>

      {createPortal(
        <DragOverlay dropAnimation={null}>
          {dragNode ? (
            <div className="tree-drag-overlay">
              <span className="tree-icon">
                <Icon name={dragNode.type === 'folder' ? 'folder' : 'doc'} size={15} />
              </span>
              <span className="tree-title">{displayTitle(dragNode)}</span>
            </div>
          ) : null}
        </DragOverlay>,
        document.body
      )}
    </DndContext>
  );
}
