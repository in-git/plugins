import React from 'react';
import { Icon } from './icons.jsx';
import SidebarTree from './SidebarTree.jsx';

export default function Sidebar({
  width,
  nodes,
  docCount,
  selectedId,
  expanded,
  renamingId,
  query,
  theme,
  onQueryChange,
  onSelect,
  onToggle,
  onExpandAll,
  onCollapseAll,
  onContextMenu,
  onBlankContextMenu,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onMove,
  onToggleTheme
}) {
  return (
    <aside
      className="flex shrink-0 flex-col border-r border-hairline bg-panel"
      style={{ width }}
    >
      <div className="px-3 pb-1.5 pt-4">
        <div className="flex items-start justify-between gap-2 px-1">
          <div className="min-w-0">
            <div className="text-[16px] font-semibold leading-6 text-ink">多功能记事本</div>
            <div className="mt-0.5 text-[16px] leading-6 text-muted">{docCount} 篇文档 · 本地数据库</div>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <button type="button" className="nb-icon-btn" title="全部展开" onClick={onExpandAll}>
              <Icon name="expandAll" size={17} />
            </button>
            <button type="button" className="nb-icon-btn" title="全部收起" onClick={onCollapseAll}>
              <Icon name="collapseAll" size={17} />
            </button>
          </div>
        </div>

        <div className="mt-2.5 flex h-9 items-center gap-1.5 rounded-[8px] border border-hairline bg-canvas px-2.5 transition-shadow focus-within:ring-2 focus-within:ring-accent/20">
          <span className="shrink-0 text-muted">
            <Icon name="search" size={15} />
          </span>
          <input
            value={query}
            spellCheck={false}
            placeholder="搜索笔记"
            onChange={(e) => onQueryChange(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[16px] text-ink outline-none placeholder:text-muted"
          />
          {query ? (
            <button
              type="button"
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-ink/[0.06] hover:text-ink"
              title="清除搜索"
              onClick={() => onQueryChange('')}
            >
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </div>
      </div>

      <div
        id="tree"
        className="nb-scroll min-h-0 flex-1 overflow-y-auto px-2.5 pb-4 pt-2"
        onContextMenu={onBlankContextMenu}
      >
        <SidebarTree
          nodes={nodes}
          selectedId={selectedId}
          expanded={expanded}
          renamingId={renamingId}
          query={query}
          onSelect={onSelect}
          onToggle={onToggle}
          onContextMenu={onContextMenu}
          onStartRename={onStartRename}
          onCommitRename={onCommitRename}
          onCancelRename={onCancelRename}
          onMove={onMove}
        />
      </div>

      <div className="flex items-center justify-between border-t border-hairline px-3 py-2">
        <span className="text-[16px] leading-6 text-muted">本地存储 · 仅此设备</span>
        <button
          type="button"
          className="nb-icon-btn h-7 w-7"
          title={theme === 'dark' ? '切换到浅色' : '切换到深色'}
          onClick={onToggleTheme}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
        </button>
      </div>
    </aside>
  );
}
