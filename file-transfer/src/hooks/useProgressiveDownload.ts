import { useCallback, useRef, useState } from 'react';
import { decryptChunkBuffer, deriveAesKey } from '../lib/crypto';
import {
  clearDownloadChunks,
  clearPendingDownload,
  loadDownloadChunks,
  loadPendingDownload,
  saveDownloadChunk,
  savePendingDownload,
} from '../lib/downloadStore';
import type { TransferHistoryItem, TransferSummary } from '../types/transfer';

interface ProgressiveDownloadState {
  downloading: boolean;
  progress: number;
  downloadedChunks: number;
  speedBps: number;
  error: string;
}

const IDLE: ProgressiveDownloadState = {
  downloading: false,
  progress: 0,
  downloadedChunks: 0,
  speedBps: 0,
  error: '',
};

interface StartOptions {
  transfer: TransferSummary;
  passphrase: string;
  /** 取件码取件流程：下载完成后让服务端使取件码失效并删除文件 */
  consumeOnComplete?: boolean;
  onAddHistory: (item: TransferHistoryItem) => void;
  onComplete?: () => void;
}

/**
 * 接收端文件下载由 App 层持有：模态框关闭 / 重建都不会重置进度。
 * 已下载分片落盘到 IndexedDB，任务信息落盘到 localStorage，
 * 刷新页面后可继续下载未完成的分片。
 */
export function useProgressiveDownload() {
  const [state, setState] = useState<ProgressiveDownloadState>(() => {
    const pending = loadPendingDownload();
    if (!pending) return IDLE;
    const total = pending.transfer.totalChunks || 1;
    return {
      downloading: false,
      progress: Math.round((pending.downloadedChunks / total) * 100),
      downloadedChunks: pending.downloadedChunks,
      speedBps: 0,
      error: '',
    };
  });
  const runningRef = useRef<string | null>(null);

  const reset = useCallback(() => {
    // 只清空展示状态；持久化的断点任务与 runningRef 由下载循环自行管理
    setState(IDLE);
  }, []);

  const start = useCallback(
    async ({ transfer, passphrase, consumeOnComplete, onAddHistory, onComplete }: StartOptions) => {
      if (transfer.kind !== 'file') return;
      if (runningRef.current) return; // 已有下载在进行
      runningRef.current = transfer.id;

      const total = transfer.totalChunks || 1;
      const pending = loadPendingDownload();
      const isResume = pending?.transfer.id === transfer.id;

      // 开始一个不同的新任务时，清理上一个未完成任务的缓存
      if (pending && !isResume) {
        await clearDownloadChunks(pending.transfer.id);
        clearPendingDownload();
      }

      setState((s) => ({
        downloading: true,
        progress: isResume ? s.progress : 0,
        downloadedChunks: isResume ? s.downloadedChunks : 0,
        speedBps: 0,
        error: '',
      }));

      try {
        let aesKey: CryptoKey | null = null;
        if (transfer.encryption.enabled) {
          if (!transfer.encryption.salt) throw new Error('缺少加密盐值元数据');
          aesKey = await deriveAesKey(passphrase, transfer.encryption.salt);
        }

        if (!isResume) {
          await clearDownloadChunks(transfer.id);
        }
        const parts = isResume ? await loadDownloadChunks(transfer.id) : new Map<number, ArrayBuffer>();

        const startedAt = performance.now();
        let receivedBytes = 0;
        let progressed = parts.size;

        for (let i = 0; i < total; i++) {
          if (parts.has(i)) continue;
          const res = await fetch(`/api/transfers/${encodeURIComponent(transfer.id)}/chunk/${i}`);
          if (!res.ok) {
            throw new Error(`下载分片 ${i + 1} 失败`);
          }
          let buf = await res.arrayBuffer();
          if (aesKey) {
            try {
              buf = await decryptChunkBuffer(aesKey, buf);
            } catch {
              throw new Error('解密密码错误，请核对后重试');
            }
          }
          parts.set(i, buf);
          progressed += 1;
          receivedBytes += buf.byteLength;

          await saveDownloadChunk(transfer.id, i, buf);
          savePendingDownload({ transfer, downloadedChunks: progressed });

          const elapsed = Math.max(0.1, (performance.now() - startedAt) / 1000);
          setState({
            downloading: true,
            progress: Math.round((progressed / total) * 100),
            downloadedChunks: progressed,
            speedBps: receivedBytes / elapsed,
            error: '',
          });
        }

        const ordered: ArrayBuffer[] = [];
        for (let i = 0; i < total; i++) {
          const buf = parts.get(i);
          if (buf) ordered.push(buf);
        }

        const blob = new Blob(ordered, { type: transfer.mimeType || 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = transfer.fileName || 'download';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);

        onAddHistory({
          id: transfer.id,
          pickupCode: transfer.pickupCode,
          kind: 'file',
          direction: 'received',
          title: transfer.fileName || '文件',
          sizeBytes: transfer.fileSize || receivedBytes,
          encrypted: transfer.encryption.enabled,
          targetDeviceName: transfer.senderDeviceName,
          createdAt: Date.now(),
        });

        await clearDownloadChunks(transfer.id);
        clearPendingDownload();

        if (consumeOnComplete) {
          // 取件完成：服务端使取件码失效并删除文件
          await fetch(`/api/transfers/${encodeURIComponent(transfer.id)}/ack?consume=1`, {
            method: 'POST',
          }).catch(() => {});
        }

        onComplete?.();
      } catch (err) {
        setState((s) => ({
          ...s,
          downloading: false,
          error: err instanceof Error ? err.message : '下载失败',
        }));
        return;
      } finally {
        runningRef.current = null;
      }

      setState((s) => ({ ...s, downloading: false }));
    },
    []
  );

  return { ...state, start, reset };
}
