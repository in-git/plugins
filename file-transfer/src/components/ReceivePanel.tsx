import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileDown,
  FileText,
  Loader2,
  Lock,
  Search,
  Unlock,
} from 'lucide-react';
import { decryptTextPayload } from '../lib/crypto';
import { formatBytes, formatRelativeTime, formatSpeed } from '../lib/format';
import { TransferHistoryItem, TransferSummary } from '../types/transfer';

interface ReceivePanelProps {
  /** 保留 URL / 外部传入的取件码，但仅当 `autoFill` 为 true 时才自动填入（默认关闭） */
  initialCode?: string;
  autoFill?: boolean;
  /** 局域网接收：已就绪的传输对象，直接展示，不显示取件码 */
  directTransfer?: TransferSummary | null;
  /** 接收完成（文件下载完成 / 文本已复制） */
  onReceiveComplete?: () => void;
  /** 下载进度 0-100（由 App 层持有，关闭模态框不重置） */
  downloadProgress?: number;
  /** 下载状态（由 App 层持有） */
  downloading?: boolean;
  downloadedChunks?: number;
  downloadSpeed?: number;
  downloadError?: string;
  /** 开始下载：任务在 App 层执行，模态框关闭不中断 */
  onStartDownload?: (transfer: TransferSummary, passphrase: string) => void;
  onAddHistory: (item: TransferHistoryItem) => void;
}

export function ReceivePanel({
  initialCode = '',
  autoFill = false,
  directTransfer = null,
  onReceiveComplete,
  downloadProgress = 0,
  downloading = false,
  downloadedChunks = 0,
  downloadSpeed = 0,
  downloadError = '',
  onStartDownload,
  onAddHistory,
}: ReceivePanelProps) {
  const [digits, setDigits] = useState<string[]>(() =>
    Array.from({ length: 6 }, () => '')
  );
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [transfer, setTransfer] = useState<TransferSummary | null>(directTransfer);

  // Decryption & Download states
  const [passphrase, setPassphrase] = useState('');
  const [decryptedText, setDecryptedText] = useState<string | null>(() =>
    directTransfer && directTransfer.kind === 'text' && !directTransfer.encryption.enabled
      ? directTransfer.textContent || ''
      : null
  );
  const [copiedText, setCopiedText] = useState(false);
  // 取件码已带出（URL/预填）或已查到记录后，取件码只读，避免改动后与已加载的传输不一致
  const codeLocked = autoFill || transfer !== null;
  // 下载进度 / 进行中 / 分片数 / 速率统一由 App 层持有，组件销毁重建不会丢失

  // 局域网接收：由外部直接给定传输对象，跳过 IP 取件码查询
  useEffect(() => {
    if (!directTransfer) return;
    setTransfer(directTransfer);
    setErrorMsg('');
    setPassphrase('');
    setDecryptedText(
      directTransfer.kind === 'text' && !directTransfer.encryption.enabled
        ? directTransfer.textContent || ''
        : null
    );
  }, [directTransfer]);

  // 局域网接收：对方同意后发送方才开始上传，就绪前轮询状态
  const directTransferId = directTransfer?.id;
  const transferStatus = transfer?.status;
  useEffect(() => {
    if (!directTransferId || transferStatus === 'ready') return;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/transfers/${encodeURIComponent(directTransferId)}/status`);
        if (!res.ok) return;
        const data = await res.json();
        if (data?.transfer) {
          setTransfer((prev) => (prev ? { ...prev, ...data.transfer } : prev));
        }
      } catch {
        // ignore polling errors
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [directTransferId, transferStatus]);

  // Auto-focus first PIN input when modal mounts.
  useEffect(() => {
    if (directTransfer) return;
    // Defer to ensure refs are wired (Tailwind conditional classes can delay mount).
    const t = setTimeout(() => inputRefs.current[0]?.focus(), 50);
    return () => clearTimeout(t);
  }, [directTransfer]);

  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const fetchByCode = useCallback(async (rawCode: string) => {
    const code = rawCode.trim();
    if (code.length !== 6) {
      setErrorMsg('请输入完整的 6 位取件码');
      return;
    }

    setLoading(true);
    setErrorMsg('');
    setTransfer(null);
    setDecryptedText(null);
    setPassphrase('');

    try {
      const res = await fetch(`/api/transfers/code/${encodeURIComponent(code)}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '未找到对应传输记录');
      }

      const found: TransferSummary = data.transfer;
      setTransfer(found);
      if (found.kind === 'text' && !found.encryption.enabled) {
        setDecryptedText(found.textContent || '');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '取件查询失败');
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-lookup when initialCode changes — opt-in only (autoFill = true)
  useEffect(() => {
    if (!autoFill || !initialCode) return;
    const clean = initialCode.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6);
    if (clean.length === 6) {
      setDigits(Array.from({ length: 6 }, (_, i) => clean[i] || ''));
      void fetchByCode(clean);
    }
  }, [autoFill, initialCode, fetchByCode]);

  // Global paste handler — any Ctrl+V in this panel reads clipboard,
  // extracts the first 6 alphanumeric chars, fills all boxes + queries.
  useEffect(() => {
    const onPaste = async (e: ClipboardEvent) => {
      if (codeLocked) return;
      const raw =
        e.clipboardData?.getData('text/plain') ||
        (navigator.clipboard?.readText ? await navigator.clipboard.readText().catch(() => '') : '');
      if (!raw) return;
      const clean = raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
      if (clean.length === 6) {
        e.preventDefault();
        const next = Array.from({ length: 6 }, (_, i) => clean[i] || '');
        setDigits(next);
        inputRefs.current[5]?.focus();
        void fetchByCode(clean);
      }
    };
    document.addEventListener('paste', onPaste as EventListener, true);
    return () => {
      document.removeEventListener('paste', onPaste as EventListener, true);
    };
  }, [fetchByCode, codeLocked]);

  const handleDigitChange = (index: number, value: string) => {
    if (codeLocked) return;
    const clean = value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (!clean) {
      const next = [...digits];
      next[index] = '';
      setDigits(next);
      return;
    }

    if (clean.length > 1) {
      // Handle paste of multiple characters
      const next = [...digits];
      for (let i = 0; i < 6 && i < clean.length; i++) {
        next[i] = clean[i];
      }
      setDigits(next);
      const focusIdx = Math.min(5, clean.length);
      inputRefs.current[focusIdx]?.focus();
      if (next.every((d) => d !== '')) {
        void fetchByCode(next.join(''));
      }
      return;
    }

    const next = [...digits];
    next[index] = clean[0];
    setDigits(next);
    if (index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
    if (next.every((d) => d !== '')) {
      void fetchByCode(next.join(''));
    }
  };

  const handleDigitKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < 5) {
      inputRefs.current[index + 1]?.focus();
    } else if (e.key === 'Enter') {
      void fetchByCode(digits.join(''));
    }
  };

  const handleDecryptText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!transfer || transfer.kind !== 'text') return;
    if (!passphrase.trim()) {
      setErrorMsg('请输入解密密码');
      return;
    }

    setErrorMsg('');
    try {
      const plain = await decryptTextPayload(
        transfer.textContent || '',
        transfer.encryption.salt || '',
        transfer.encryption.iv || '',
        passphrase
      );
      setDecryptedText(plain);
      // 取件码取件：解密成功后让取件码失效并删除文件
      await fetch(
        `/api/transfers/${encodeURIComponent(transfer.id)}/ack${directTransfer ? '' : '?consume=1'}`,
        { method: 'POST' }
      ).catch(() => { });
      onAddHistory({
        id: transfer.id,
        pickupCode: transfer.pickupCode,
        kind: 'text',
        direction: 'received',
        title: plain.slice(0, 40).replace(/\s+/g, ' '),
        sizeBytes: new Blob([plain]).size,
        encrypted: true,
        targetDeviceName: transfer.senderDeviceName,
        createdAt: Date.now(),
      });
    } catch {
      setErrorMsg('解密密码错误或文本数据已损坏');
    }
  };

  const handleCopyText = async () => {
    if (decryptedText === null) return;
    try {
      await navigator.clipboard.writeText(decryptedText);
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 1800);
      onReceiveComplete?.();
      if (transfer && !transfer.encryption.enabled) {
        // 取件码取件：取走文本后让取件码失效并删除记录
        await fetch(
          `/api/transfers/${encodeURIComponent(transfer.id)}/ack${directTransfer ? '' : '?consume=1'}`,
          { method: 'POST' }
        ).catch(() => { });
        onAddHistory({
          id: transfer.id,
          pickupCode: transfer.pickupCode,
          kind: 'text',
          direction: 'received',
          title: decryptedText.slice(0, 40).replace(/\s+/g, ' '),
          sizeBytes: new Blob([decryptedText]).size,
          encrypted: false,
          targetDeviceName: transfer.senderDeviceName,
          createdAt: Date.now(),
        });
      }
    } catch {
      // ignore
    }
  };

  const handleProgressiveFileDownload = () => {
    if (!transfer || transfer.kind !== 'file') return;
    if (transfer.encryption.enabled && !passphrase.trim()) {
      setErrorMsg('此文件已加密，请输入解密密码');
      return;
    }
    setErrorMsg('');
    // 交给 App 层执行，模态框关闭也不会中断 / 重置进度
    onStartDownload?.(transfer, passphrase);
  };

  const incomingPercent = transfer
    ? Math.min(
        100,
        Math.round(((transfer.uploadedChunksCount || 0) / (transfer.totalChunks || 1)) * 100)
      )
    : 0;

  return (
    <div className="bg-white rounded-md sm:rounded-2xl border border-[#E5E5EA] p-3 sm:p-8 space-y-4 sm:space-y-6">
      {/* 6-Digit PIN Input — 局域网直接接收时不显示取件码 */}
      {!directTransfer && (
      <div>
        <div className="flex items-center flex-nowrap gap-1 sm:gap-2 min-w-0 overflow-x-auto">
          {digits.map((digit, idx) => (
            <input
              key={idx}
              ref={(el) => {
                inputRefs.current[idx] = el;
              }}
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={digit}
              onChange={(e) => handleDigitChange(idx, e.target.value)}
              onKeyDown={(e) => handleDigitKeyDown(idx, e)}
              readOnly={codeLocked}
              tabIndex={codeLocked ? -1 : 0}
              aria-label={`取件码第 ${idx + 1} 位`}
              className={`flex-1 min-w-0 h-10 sm:h-14 text-center font-mono text-base sm:text-2xl font-semibold rounded-md sm:rounded-xl border border-[#E5E5EA] focus:outline-none text-[#1D1D1F] transition-colors ${
                codeLocked
                  ? 'bg-[#F5F5F7] text-[#6E6E73] cursor-default'
                  : 'bg-[#F5F5F7]/60 focus:bg-white focus:border-[#1D1D1F]'
              }`}
            />
          ))}
        </div>
        <p className="mt-2 text-center text-sm text-[#6E6E73]">
          {codeLocked ? '' : '请输入 6 位取件码 · 可直接粘贴'}
        </p>
      </div>
      )}

      {(errorMsg || downloadError) && (
        <div className="flex items-center gap-2 text-xs text-[#DC2626] bg-[#DC2626]/6 px-2 sm:px-4 py-2 sm:py-3 rounded-xl">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{errorMsg || downloadError}</span>
        </div>
      )}

      {/* Found Transfer Result */}
      {transfer && (
        <div
          className={`space-y-3 sm:space-y-5 ${
            directTransfer ? '' : 'pt-3 sm:pt-6 border-t border-[#E5E5EA]'
          }`}
        >
          <div className="flex items-start justify-between gap-2 sm:gap-4">
            <div className="flex items-center gap-2 sm:gap-3.5 min-w-0">
              <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-[#F5F5F7] flex items-center justify-center shrink-0">
                {transfer.kind === 'file' ? (
                  <FileDown className="w-5 h-5 text-[#1D1D1F]" />
                ) : (
                  <FileText className="w-5 h-5 text-[#1D1D1F]" />
                )}
              </div>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-[#1D1D1F] truncate">
                  {transfer.kind === 'file' ? transfer.fileName : '文本传输内容'}
                </h3>
                <p className="text-xs text-[#6E6E73] mt-0.5 tabular-nums">
                  {transfer.kind === 'file'
                    ? `${formatBytes(transfer.fileSize || 0)} · ${transfer.totalChunks || 1} 分片`
                    : `${formatBytes(transfer.textByteLength || 0)}`}
                  <span className="mx-1.5">·</span>
                  来自 {transfer.senderDeviceName || '发送设备'}
                  <span className="mx-1.5">·</span>
                  {formatRelativeTime(transfer.createdAt)}
                  {transfer.encryption.enabled ? ' · 加密' : ''}
                </p>
              </div>
            </div>

            {/* 行尾下载图标 — 文件就绪时可点击直接下载 */}
            {transfer.kind === 'file' && transfer.status === 'ready' && (
              <button
                type="button"
                disabled={downloading}
                onClick={() => void handleProgressiveFileDownload()}
                className="flex h-9 w-9 items-center justify-center rounded-md sm:rounded-lg bg-[#1D1D1F] text-white hover:bg-[#000000] disabled:opacity-45 transition-colors shrink-0 cursor-pointer"
                aria-label="下载文件"
                title="下载文件"
              >
                {downloading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : transfer.encryption.enabled ? (
                  <Unlock className="w-4 h-4" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
              </button>
            )}
          </div>

          {transfer.status !== 'ready' ? (
            <div className="p-2 sm:p-4 rounded-xl bg-[#F5F5F7] space-y-2">
              <div className="flex items-center justify-between text-sm tabular-nums">
                <span className="font-medium text-[#1D1D1F]">发送方正在上传</span>
                <span className="font-mono font-semibold text-[#1D1D1F]">
                  {incomingPercent}%
                </span>
              </div>
              <div className="h-2 w-full bg-[#E5E5EA] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#1D1D1F] transition-all duration-200 apple-ease"
                  style={{ width: `${incomingPercent}%` }}
                />
              </div>
              <p className="text-sm text-[#6E6E73] font-mono tabular-nums">
                {transfer.uploadedChunksCount || 0} / {transfer.totalChunks || 1} 分片
              </p>
            </div>
          ) : transfer.kind === 'file' ? (
            <div className="space-y-2 sm:space-y-4">
              {transfer.encryption.enabled && (
                <div className="relative max-w-md">
                  <Lock className="w-4 h-4 text-[#86868B] absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    disabled={downloading}
                    placeholder="输入发送方设置的解密密码"
                    className="w-full pl-10 pr-4 py-2.5 text-sm rounded-xl border border-[#E5E5EA] bg-[#F5F5F7]/50 focus:bg-white focus:border-[#1D1D1F] focus:outline-none text-[#1D1D1F]"
                  />
                </div>
              )}

              {(downloading || downloadProgress > 0) && (
                <div className="space-y-1.5 sm:space-y-2 pt-1">
                  <div className="flex items-center justify-between text-xs tabular-nums">
                    <span className="font-medium text-[#1D1D1F]">
                      {transfer.encryption.enabled ? '正在下载并本地解密...' : '正在下载文件...'} ·{' '}
                      {formatSpeed(downloadSpeed)}
                    </span>
                    <span className="font-mono font-semibold text-[#1D1D1F]">
                      {downloadProgress}%
                    </span>
                  </div>
                  <div className="h-2 w-full bg-[#F5F5F7] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#1D1D1F] transition-all duration-200 apple-ease"
                      style={{ width: `${downloadProgress}%` }}
                    />
                  </div>
                  <p className="text-xs text-[#6E6E73] font-mono tabular-nums">
                    分片 {downloadedChunks} / {transfer.totalChunks || 1}
                  </p>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                <button
                  type="button"
                  disabled={downloading}
                  onClick={() => void handleProgressiveFileDownload()}
                  className="inline-flex items-center gap-2 px-3 sm:px-5 py-2.5 text-xs font-medium text-white bg-[#1D1D1F] hover:bg-[#000000] disabled:opacity-50 rounded-md sm:rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {transfer.encryption.enabled ? (
                    <Unlock className="w-3.5 h-3.5" />
                  ) : (
                    <Download className="w-3.5 h-3.5" />
                  )}
                  {downloading
                    ? '下载中'
                    : downloadProgress > 0
                      ? '继续下载'
                      : '下载文件'}
                </button>

                {!transfer.encryption.enabled && (
                  <a
                    href={`/api/transfers/${encodeURIComponent(transfer.id)}/download`}
                    download
                    className="inline-flex items-center gap-1.5 px-3 sm:px-4 py-2.5 text-xs font-medium text-[#1D1D1F] bg-[#F5F5F7] hover:bg-[#E8E8ED] rounded-md sm:rounded-xl transition-colors whitespace-nowrap shrink-0"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    直链
                  </a>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-2 sm:space-y-4">
              {decryptedText === null ? (
                <form onSubmit={handleDecryptText} className="flex flex-col sm:flex-row gap-2 sm:gap-2.5">
                  <div className="relative flex-1 max-w-md">
                    <Lock className="w-4 h-4 text-[#86868B] absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="输入密码解锁加密文本"
                      className="w-full pl-10 pr-4 py-2.5 text-sm rounded-xl border border-[#E5E5EA] bg-[#F5F5F7]/50 focus:bg-white focus:border-[#1D1D1F] focus:outline-none text-[#1D1D1F]"
                    />
                  </div>
                  <button
                    type="submit"
                    className="inline-flex items-center justify-center gap-1.5 px-4 sm:px-5 py-2.5 text-xs font-medium text-white bg-[#1D1D1F] hover:bg-[#000000] rounded-md sm:rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Unlock className="w-3.5 h-3.5" />
                    解密
                  </button>
                </form>
              ) : (
                <div className="space-y-2 sm:space-y-3">
                  <textarea
                    readOnly
                    value={decryptedText}
                    rows={14}
                    className="w-full min-h-[320px] max-h-[60vh] rounded-md sm:rounded-2xl border border-[#E5E5EA] bg-[#F5F5F7]/60 p-4 text-sm text-[#1D1D1F] leading-relaxed resize-y focus:outline-none focus:border-[#1D1D1F] focus:bg-white font-sans"
                  />
                  <button
                    type="button"
                    onClick={() => void handleCopyText()}
                    className="inline-flex items-center gap-2 px-3 sm:px-4 py-2.5 text-xs font-medium text-white bg-[#1D1D1F] hover:bg-[#000000] rounded-md sm:rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    {copiedText ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    {copiedText ? '已复制' : '复制'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
