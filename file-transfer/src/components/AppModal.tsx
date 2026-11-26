import { useEffect } from 'react';
import { X } from 'lucide-react';

export interface AppModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  widthClassName?: string;
}

/** 通用弹窗：遮罩 + 标题栏 + 滚动容器，Esc 关闭 */
export default function AppModal({ open, title, onClose, children, widthClassName = 'max-w-2xl' }: AppModalProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className={`w-full ${widthClassName} max-h-[88vh] flex flex-col bg-white rounded-md sm:rounded-2xl shadow-2xl border border-[#E5E5EA]`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 sm:gap-4 px-3 sm:px-6 py-3 sm:py-4 border-b border-[#E5E5EA] shrink-0">
          <h2 className="text-base font-semibold text-[#1D1D1F]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[#6E6E73] hover:bg-[#F5F5F7] hover:text-[#1D1D1F] transition-colors cursor-pointer"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 sm:px-6 py-3 sm:py-5">
          {children}
        </div>
      </div>
    </div>
  );
}
