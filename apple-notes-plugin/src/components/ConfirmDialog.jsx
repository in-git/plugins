import React, { useEffect } from 'react';

export default function ConfirmDialog({ node, onCancel, onConfirm }) {
  useEffect(() => {
    if (!node) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [node, onCancel]);

  if (!node) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/20 p-6 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="nb-dialog w-full max-w-[380px] p-6" role="dialog" aria-modal="true">
        <h3 className="text-title font-semibold text-ink">删除内容</h3>
        <p className="mt-2 text-body leading-relaxed text-subtle">
          {node.type === 'folder'
            ? `将删除「${node.title || '未命名目录'}」及其全部内容，本地数据会一并移除，且无法恢复。`
            : `将删除「${node.title || '无标题文档'}」，本地数据会一并移除，且无法恢复。`}
        </p>
        <div className="mt-6 flex items-center justify-end gap-2">
          <button type="button" className="nb-btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center justify-center rounded-control bg-danger px-3.5 text-body font-medium text-white transition-opacity hover:opacity-90"
            onClick={onConfirm}
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
