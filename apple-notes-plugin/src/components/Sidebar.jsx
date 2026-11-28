import React from 'react';
import { Icon } from './icons.jsx';
import SidebarTree from './SidebarTree.jsx';
import Tooltip from './Tooltip.jsx';

// 扩展页内可读到 manifest 版本；在纯浏览器调试环境下忽略
const APP_VERSION = (() => {
  try {
    return chrome.runtime.getManifest().version;
  } catch {
    return '';
  }
})();

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
  onCreateDoc,
  onCreateSubfolder,
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
        <div className="px-1">
          <div className="text-[16px] font-semibold leading-6 text-ink">文龙多功能记事本</div>
          <div className="mt-0.5 text-[16px] leading-6 text-muted">{docCount} 篇文档</div>
        </div>

        <div className="mt-2.5 flex items-center gap-1.5">
          <div className="flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-[8px] border border-hairline bg-canvas px-2.5 transition-shadow focus-within:ring-2 focus-within:ring-accent/20">
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

          <button
            type="button"
            className="nb-icon-btn h-9 w-9 shrink-0"
            title="新建笔记"
            aria-label="新建笔记"
            onClick={onCreateDoc}
          >
            <Icon name="plus" size={18} />
          </button>
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
          onCreateSubfolder={onCreateSubfolder}
          onContextMenu={onContextMenu}
          onStartRename={onStartRename}
          onCommitRename={onCommitRename}
          onCancelRename={onCancelRename}
          onMove={onMove}
        />
      </div>

      <div className="flex items-center justify-between border-t border-hairline px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Tooltip content="联系作者：吴文龙">
            <a
              href="https://space.bilibili.com/3706965849016893"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="联系作者：吴文龙"
              className="nb-icon-btn h-7 w-7"
            >
              <img src="/bilibili.png" alt="B站" className="h-[18px] w-[18px] rounded-[5px] object-contain" />
            </a>
          </Tooltip>
          {APP_VERSION ? (
            <span className="select-none text-[12px] leading-4 text-muted">v{APP_VERSION}</span>
          ) : null}
        </div>
        <Tooltip content={theme === 'dark' ? '切换到浅色' : '切换到深色'}>
          <button
            type="button"
            aria-label={theme === 'dark' ? '切换到浅色' : '切换到深色'}
            className="nb-icon-btn h-7 w-7"
            onClick={onToggleTheme}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
          </button>
        </Tooltip>
      </div>
    </aside>
  );
}
