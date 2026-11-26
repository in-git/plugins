import { useMemo } from 'react';
import { FileUp, FolderOpen, X } from 'lucide-react';
import { formatBytes } from '../lib/format';

interface DropPreviewModalProps {
  files: File[];
  onClose: () => void;
  onConfirm: (files: File[]) => void;
}

/** 拖拽到窗口后弹出的预览：列表 + 总计 + 一次性全部加入队列 */
export default function DropPreviewModal({ files, onClose, onConfirm }: DropPreviewModalProps) {
  const total = useMemo(() => files.reduce((s, f) => s + (f.size || 0), 0), [files]);

  const visible = files.slice(0, 12);
  const hidden = files.length - visible.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-white rounded-md sm:rounded-2xl shadow-2xl border border-[#E5E5EA]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 sm:gap-4 px-3 sm:px-6 py-3 sm:py-4 border-b border-[#E5E5EA] shrink-0">
          <div>
            <h2 className="text-base font-semibold text-[#1D1D1F]">已拖入 {files.length} 个文件</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md sm:rounded-lg text-[#6E6E73] hover:bg-[#F5F5F7] hover:text-[#1D1D1F] transition-colors cursor-pointer"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 sm:px-6 py-3 sm:py-4 space-y-1">
          {visible.map((f, i) => {
            const isFolder = (f as any).relativePath?.includes('/') && !(f as any).relativePath!.endsWith('/' + f.name);
            return (
              <div
                key={i}
                className="w-full text-left px-2 sm:px-3.5 py-2 sm:py-2.5 flex items-center gap-2 sm:gap-3 rounded-xl transition-colors hover:bg-[#F5F5F7]"
              >
                <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-[#F5F5F7] text-[#1D1D1F]">
                  {isFolder ? <FolderOpen className="w-4 h-4" /> : <FileUp className="w-4 h-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-[#1D1D1F] truncate">
                    {(f as any).relativePath || f.name}
                  </p>
                  <p className="text-xs text-[#6E6E73] font-mono tabular-nums">
                    {formatBytes(f.size || 0)}
                  </p>
                </div>
              </div>
            );
          })}
          {hidden > 0 && (
            <p className="text-xs text-[#86868B] text-center pt-2">
              另有 {hidden} 个文件未显示 · 全部都会加入队列
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 sm:gap-4 px-3 sm:px-6 py-3 sm:py-4 border-t border-[#E5E5EA] shrink-0 bg-[#FAFAFB] rounded-b-2xl">
          <p className="text-xs text-[#6E6E73]">
            共 <span className="font-medium text-[#1D1D1F]">{files.length}</span> 个文件 ·{' '}
            <span className="font-mono tabular-nums text-[#1D1D1F]">{formatBytes(total)}</span>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-[#1D1D1F] bg-white border border-[#E5E5EA] hover:bg-[#F5F5F7] rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => { onConfirm(files); onClose(); }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-[#1D1D1F] hover:bg-[#000000] rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <FileUp className="w-3.5 h-3.5" />
              加入队列
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
