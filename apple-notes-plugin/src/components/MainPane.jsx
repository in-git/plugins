import React from 'react';
import EditorView from './EditorView.jsx';
import FolderView from './FolderView.jsx';

function EmptyState() {
  return (
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
  );
}

/** 右侧主区：数据库错误 / 加载中 / 文档编辑 / 目录视图 / 空态 */
export default function MainPane({
  dbError,
  ready,
  selectedNode,
  nodes,
  theme,
  autoFocusId,
  crumbs,
  onPatch,
  onSelect,
  onCreateDoc,
  onCreateFolder
}) {
  if (dbError) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <h2 className="text-lead font-medium text-ink">本地数据库不可用</h2>
        <p className="mt-2 max-w-[420px] text-meta leading-relaxed text-subtle">
          {dbError}
          <br />
          请通过扩展页面或本地服务器打开，并允许站点存储数据。
        </p>
      </div>
    );
  }

  if (!ready) {
    return <div className="flex h-full items-center justify-center text-meta text-muted">正在读取本地数据库…</div>;
  }

  if (selectedNode && selectedNode.type === 'doc') {
    return (
      <EditorView
        key={selectedNode.id}
        node={selectedNode}
        theme={theme}
        autoFocusTitle={autoFocusId === selectedNode.id}
        crumbs={crumbs}
        onPatch={onPatch}
      />
    );
  }

  if (selectedNode) {
    return (
      <FolderView
        node={selectedNode}
        nodes={nodes}
        crumbs={crumbs}
        onSelect={onSelect}
        onCreateDoc={onCreateDoc}
        onCreateFolder={onCreateFolder}
        onPatchTitle={(id, title) => onPatch(id, { title })}
      />
    );
  }

  return <EmptyState />;
}
