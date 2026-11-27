import React, { useEffect, useState } from 'react';

const FORMATS = [
  { value: 'txt', label: '纯文本', ext: '.txt', desc: '去掉格式，仅保留文字内容' },
  { value: 'md', label: 'Markdown', ext: '.md', desc: '保留标题、列表、引用等结构' }
];

/** 下载格式选择弹窗 */
export default function DownloadDialog({ open, title, onCancel, onConfirm }) {
  const [format, setFormat] = useState('md');

  useEffect(() => {
    if (!open) return undefined;
    setFormat('md');
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/20 p-6 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="nb-dialog w-full max-w-[400px] p-6" role="dialog" aria-modal="true">
        <h3 className="text-title font-semibold text-ink">下载笔记</h3>
        <p className="mt-2 truncate text-body text-subtle">「{title || '无标题文档'}」</p>

        <div className="mt-4 space-y-2">
          {FORMATS.map((item) => {
            const active = format === item.value;
            return (
              <label
                key={item.value}
                className={
                  'flex cursor-pointer items-center gap-3 rounded-control border px-3 py-2.5 transition-colors ' +
                  (active
                    ? 'border-accent bg-accent-soft'
                    : 'border-hairline hover:bg-ink/[0.04]')
                }
              >
                <input
                  type="radio"
                  name="note-download-format"
                  value={item.value}
                  checked={active}
                  onChange={() => setFormat(item.value)}
                  className="h-4 w-4 shrink-0 accent-accent"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-medium text-ink">
                    {item.label}
                    <span className="ml-1.5 text-caption text-muted">{item.ext}</span>
                  </span>
                  <span className="mt-0.5 block text-caption text-muted">{item.desc}</span>
                </span>
              </label>
            );
          })}
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <button type="button" className="nb-btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="nb-btn-primary"
            onClick={() => onConfirm(format)}
          >
            下载
          </button>
        </div>
      </div>
    </div>
  );
}
