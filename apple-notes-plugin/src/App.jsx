import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import MainPane from './components/MainPane.jsx';
import Crumbs from './components/Crumbs.jsx';
import ContextMenu from './components/ContextMenu.jsx';
import ConfirmDialog from './components/ConfirmDialog.jsx';
import useNotesStore from './hooks/useNotesStore.js';
import useSidebarWidth from './hooks/useSidebarWidth.js';
import { initialTheme, pathOf } from './lib/utils.js';

function parentForNode(node) {
  if (!node) return null;
  return node.type === 'folder' ? node.id : node.parentId || null;
}

export default function App() {
  const store = useNotesStore();
  const {
    width: sidebarWidth,
    startResize: startSidebarResize,
    resetWidth: resetSidebarWidth
  } = useSidebarWidth();
  const [theme, setTheme] = useState(initialTheme);
  const [searchQuery, setSearchQuery] = useState('');
  const [menu, setMenu] = useState(null);

  // ---------- 主题 ----------
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('notes-theme', theme); } catch (err) { /* 忽略 */ }
  }, [theme]);

  const crumbsPath = useMemo(
    () => (store.selectedNode ? pathOf(store.selectedNode, store.nodeMap) : []),
    [store.selectedNode, store.nodeMap]
  );
  const crumbs = <Crumbs path={crumbsPath} onSelect={store.selectNode} />;

  // ---------- 右键菜单 ----------
  const openMenu = useCallback((event, node) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, node });
  }, []);

  const openBlankMenu = useCallback((event) => {
    if (event.target.closest('.tree-item')) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, node: null });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  const { createNode, startRename, copyNode, cutNode, pasteClip, setPendingDeleteId } = store;
  const handleMenuAction = useCallback(
    (action, node) => {
      if (action === 'newDoc') createNode('doc', parentForNode(node));
      else if (action === 'newFolder') createNode('folder', parentForNode(node));
      else if (action === 'rename' && node) startRename(node.id);
      else if (action === 'delete' && node) setPendingDeleteId(node.id);
      else if (action === 'copy' && node) copyNode(node);
      else if (action === 'cut' && node) cutNode(node);
      else if (action === 'paste') pasteClip(node);
    },
    [createNode, startRename, copyNode, cutNode, pasteClip, setPendingDeleteId]
  );

  return (
    <div className="flex h-full">
      <Sidebar
        width={sidebarWidth}
        nodes={store.nodes}
        docCount={store.docCount}
        selectedId={store.selectedId}
        expanded={store.expanded}
        renamingId={store.renamingId}
        query={searchQuery}
        theme={theme}
        onQueryChange={setSearchQuery}
        onSelect={store.selectNode}
        onToggle={store.toggleExpand}
        onCreateDoc={() => store.createNode('doc', null)}
        onCreateSubfolder={(folderId) => store.createNode('folder', folderId)}
        onContextMenu={openMenu}
        onBlankContextMenu={openBlankMenu}
        onStartRename={store.startRename}
        onCommitRename={store.commitRename}
        onCancelRename={() => store.setRenamingId(null)}
        onMove={store.moveNode}
        onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      />

      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整侧栏宽度"
        className="nb-splitter"
        title="拖动调整宽度，双击恢复默认"
        onPointerDown={startSidebarResize}
        onDoubleClick={resetSidebarWidth}
      />

      <main className="relative flex min-w-0 flex-1 flex-col bg-canvas">
        <MainPane
          dbError={store.dbError}
          ready={store.ready}
          selectedNode={store.selectedNode}
          nodes={store.nodes}
          theme={theme}
          autoFocusId={store.autoFocusId}
          crumbs={crumbs}
          onPatch={store.handlePatch}
          onSelect={store.selectNode}
          onCreateDoc={() => store.createNode('doc', store.selectedNode.id)}
          onCreateFolder={() => store.createNode('folder', store.selectedNode.id)}
        />
      </main>

      <ContextMenu menu={menu} onClose={closeMenu} onAction={handleMenuAction} canPaste={!!store.clip} />
      <ConfirmDialog
        node={store.pendingNode}
        onCancel={() => store.setPendingDeleteId(null)}
        onConfirm={store.confirmDelete}
      />
    </div>
  );
}
