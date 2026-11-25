import React, { useEffect, useState } from 'react';
import { Icon } from './icons.jsx';
import { childrenOf, displayTitle, fmtTime } from '../lib/utils.js';

export default function FolderView({
  node,
  nodes,
  crumbs,
  onSelect,
  onCreateDoc,
  onCreateFolder,
  onPatchTitle
}) {
  const [title, setTitle] = useState(node.title || '');
  const kids = childrenOf(nodes, node.id);

  useEffect(() => {
    setTitle(node.title || '');
  }, [node.id, node.title]);

  useEffect(() => {
    if ((node.title || '') === title) return undefined;
    const timer = setTimeout(() => onPatchTitle(node.id, title), 400);
    return () => clearTimeout(timer);
  }, [title]);

  return (
    <section className="flex h-full flex-col">
      <header className="shrink-0 px-10 pb-4 pt-7">
        <div className="mb-2.5 flex flex-wrap items-center gap-1 text-caption text-muted">{crumbs}</div>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="未命名目录"
              spellCheck={false}
              className="w-full min-w-[200px] bg-transparent text-display font-semibold text-ink outline-none placeholder:text-muted"
            />
            <div className="mt-1 text-caption text-muted">
              {kids.length ? kids.length + ' 项内容 · ' + fmtTime(node.updatedAt) : '空目录'}
            </div>
          </div>
          <div className="flex items-center gap-2 pb-1">
            <button type="button" className="nb-btn-primary" onClick={onCreateDoc}>
              <Icon name="plus" size={15} stroke={1.6} />
              新建文档
            </button>
            <button type="button" className="nb-btn" onClick={onCreateFolder}>
              新建目录
            </button>
          </div>
        </div>
      </header>

      <div className="shrink-0 px-10">
        <div className="h-px bg-hairline" />
      </div>

      <div className="nb-scroll min-h-0 flex-1 overflow-y-auto px-10 pb-24 pt-4">
        <div className="mx-auto w-full max-w-[760px]">
          {kids.length ? (
            <div className="space-y-0.5">
              {kids.map((kid) => (
                <button key={kid.id} type="button" className="nb-row" onClick={() => onSelect(kid.id)}>
                  <span className="nb-tile">
                    <Icon name={kid.type === 'folder' ? 'folder' : 'doc'} size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body text-ink">{displayTitle(kid)}</span>
                    <span className="mt-0.5 block truncate text-caption text-muted">
                      {kid.type === 'folder' ? '目录' : '文档'} · {fmtTime(kid.updatedAt)}
                    </span>
                  </span>
                  <span className="text-muted">
                    <Icon name="chevron" size={14} stroke={1.5} />
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="nb-empty py-24">
              <span className="text-muted">
                <Icon name="folder" size={40} stroke={1.1} />
              </span>
              <div className="mt-5 text-lead font-medium text-ink">这个目录还是空的</div>
              <div className="mt-2 text-meta text-subtle">新建文档，或继续嵌套子目录。</div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
