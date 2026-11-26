import { Download, FileText, Lock, X } from 'lucide-react';
import { IncomingTransferNotice } from '../hooks/useDeviceNetwork';
import type { TransferSummary } from '../types/transfer';
import { formatBytes } from '../lib/format';
import { useEffect, useRef } from 'react';

interface IncomingModalProps {
  /** 待接收队列 — 批量发送时同一设备会有多条，逐条展示 */
  notices: IncomingTransferNotice[];
  /** 有其他模态框打开时隐藏，避免遮挡 */
  hidden?: boolean;
  onAccept: (transfer: TransferSummary) => void;
  onDismiss: (transferId?: string) => void;
}

export function IncomingModal({ notices, hidden = false, onAccept, onDismiss }: IncomingModalProps) {
  const firstId = notices[0]?.transfer.id;
  const vibratedFor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!firstId || vibratedFor.current === firstId) return;
    vibratedFor.current = firstId;
    if (typeof navigator.vibrate === 'function') {
      try { navigator.vibrate([60, 40, 60]); } catch { /* ignore */ }
    }
  }, [firstId]);

  if (notices.length === 0 || hidden) return null;

  const senderName = notices[0].transfer.senderDeviceName || '附近设备';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 backdrop-blur-sm p-4"
      onClick={() => onDismiss()}
    >
      <div
        className="w-full max-w-sm bg-white rounded-md sm:rounded-2xl border border-[#E5E5EA] shadow-2xl flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-3 sm:px-5 py-3 sm:py-4 border-b border-[#E5E5EA] shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-[#1D1D1F] truncate">
              来自：{senderName}
            </h3>
          </div>
          <button
            type="button"
            onClick={() => onDismiss()}
            className="p-1.5 text-[#86868B] hover:text-[#1D1D1F] hover:bg-[#F5F5F7] rounded-md transition-colors cursor-pointer shrink-0"
            aria-label="关闭通知"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body — 每条一个文件 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 sm:px-5 py-3 sm:py-4 space-y-2">
          {notices.length > 1 && (
            <p className="text-sm text-[#6E6E73]">共 {notices.length} 个文件待接收</p>
          )}

          {notices.map((notice) => {
            const { transfer, progress, uploadedChunksCount, totalChunks } = notice;
            const isReady = transfer.status === 'ready' || progress >= 100;
            const isPending = transfer.status === 'pending';
            return (
              <div
                key={transfer.id}
                className="flex items-center gap-2.5 px-2 sm:px-3 py-2 rounded-md bg-[#F5F5F7]"
              >
                <div className="w-9 h-9 rounded-md bg-white flex items-center justify-center shrink-0">
                  {transfer.kind === 'file' ? (
                    <Download className="w-4 h-4 text-[#1D1D1F]" />
                  ) : (
                    <FileText className="w-4 h-4 text-[#1D1D1F]" />
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-[#1D1D1F] truncate">
                    {transfer.kind === 'file' ? transfer.fileName : '文本消息'}
                  </p>
                  <p className="text-sm text-[#6E6E73] tabular-nums">
                    {transfer.kind === 'file'
                      ? formatBytes(transfer.fileSize || 0)
                      : formatBytes(transfer.textByteLength || 0)}
                    {transfer.encryption.enabled && (
                      <span className="ml-1.5 inline-flex items-center gap-0.5 text-[#1D1D1F]">
                        · <Lock className="w-3 h-3" /> 加密
                      </span>
                    )}
                    {isPending && <span className="ml-1.5">· 待接收</span>}
                    {!isPending && !isReady && <span className="ml-1.5">· {progress}%</span>}
                  </p>
                  {!isPending && !isReady && (
                    <div className="h-1 w-full bg-[#E5E5EA] rounded-full overflow-hidden mt-1">
                      <div
                        className="h-full bg-[#1D1D1F] transition-all duration-200"
                        style={{ width: `${Math.min(100, progress)}%` }}
                      />
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => onAccept(transfer)}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-[#1D1D1F] hover:bg-[#000000] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  接收
                </button>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-3 sm:px-5 py-3 sm:py-4 border-t border-[#E5E5EA] shrink-0">
          <button
            type="button"
            onClick={() => onDismiss()}
            className="px-3.5 py-2 text-xs font-medium text-[#6E6E73] hover:text-[#1D1D1F] bg-[#F5F5F7] hover:bg-[#E8E8ED] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            忽略全部
          </button>
        </div>
      </div>
    </div>
  );
}
