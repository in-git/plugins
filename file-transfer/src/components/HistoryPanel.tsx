import { FileText, FileUp, Lock, Trash2 } from 'lucide-react';
import { formatBytes, formatRelativeTime } from '../lib/format';
import { TransferHistoryItem } from '../types/transfer';

interface HistoryPanelProps {
  items: TransferHistoryItem[];
  onClearHistory: () => void;
}

export function HistoryPanel({ items, onClearHistory }: HistoryPanelProps) {
  return (
    <div className="bg-white rounded-md sm:rounded-2xl border border-[#E5E5EA] p-3 sm:p-8 space-y-4 sm:space-y-5">
      <div className="flex items-center justify-between gap-2 sm:gap-4">
        <div>
          <h2 className="text-lg font-semibold text-[#1D1D1F]">最近记录</h2>
        </div>

        {items.length > 0 && (
          <button
            type="button"
            onClick={onClearHistory}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#6E6E73] hover:text-[#DC2626] bg-[#F5F5F7] hover:bg-[#DC2626]/8 rounded-md sm:rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
            清空记录
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="py-14 text-center rounded-md sm:rounded-2xl bg-[#F5F5F7]">
          <p className="text-sm font-medium text-[#1D1D1F]">暂无记录</p>
          <p className="text-xs text-[#6E6E73] mt-1.5">发送或接收后会显示在这里</p>
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto divide-y divide-[#E5E5EA] border border-[#E5E5EA] rounded-md sm:rounded-2xl">
          {items.map((item) => (
            <div
              key={`${item.id}-${item.createdAt}`}
              className="px-2 sm:px-4 py-2 sm:py-3.5 flex items-center justify-between gap-2 sm:gap-4 hover:bg-[#F5F5F7]/60 transition-colors"
            >
              <div className="flex items-center gap-2 sm:gap-3.5 min-w-0">
                <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-[#F5F5F7] flex items-center justify-center shrink-0">
                  {item.kind === 'file' ? (
                    <FileUp className="w-4 h-4 text-[#1D1D1F]" />
                  ) : (
                    <FileText className="w-4 h-4 text-[#1D1D1F]" />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-[#1D1D1F] truncate">{item.title}</p>
                    {item.encrypted && <Lock className="w-3.5 h-3.5 text-[#6E6E73] shrink-0" />}
                  </div>
                  <p className="text-xs text-[#6E6E73] mt-0.5 flex items-center gap-1.5 tabular-nums">
                    <span>{formatBytes(item.sizeBytes)}</span>
                    <span>·</span>
                    <span>{formatRelativeTime(item.createdAt)}</span>
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
