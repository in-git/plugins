import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
  FileUp,
  KeyRound,
  Loader2,
  Lock,
  Pause,
  Play,
  RotateCcw,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import DestinationPicker, { DestinationMode } from './DestinationPicker';
import InfoTip from './InfoTip';
import TransferAnimation from './TransferAnimation';
import {
  computeFileFingerprint,
  deriveAesKey,
  encryptChunkBuffer,
  encryptTextPayload,
  generateBaseIvBase64,
  generateSaltBase64,
  generateStrongPassphrase,
} from '../lib/crypto';
import { formatBytes, formatEta, formatSpeed } from '../lib/format';
import {
  NetworkPeer,
  ResumableUploadRecord,
  TransferHistoryItem,
  TransferSummary,
} from '../types/transfer';

const RESUMABLE_STORAGE_KEY = 'airvault_resumable_uploads';
const CHUNK_SIZE = 1024 * 1024; // 1 MB

function loadResumableMap(): Record<string, ResumableUploadRecord> {
  try {
    const raw = localStorage.getItem(RESUMABLE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveResumableRecord(rec: ResumableUploadRecord) {
  try {
    const map = loadResumableMap();
    map[rec.fingerprint] = rec;
    localStorage.setItem(RESUMABLE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage quota errors
  }
}

function removeResumableRecord(fingerprint: string) {
  try {
    const map = loadResumableMap();
    delete map[fingerprint];
    localStorage.setItem(RESUMABLE_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

/** 优先使用内存中的断点；内存态丢失时回退到本地持久化的断点记录 */
function resolveResumeRecord(
  inMemory: ResumableUploadRecord | null,
  fingerprint: string
): ResumableUploadRecord | null {
  if (inMemory) return inMemory;
  if (!fingerprint) return null;
  return loadResumableMap()[fingerprint] ?? null;
}

interface SendPanelProps {
  deviceId: string;
  deviceName: string;
  selectedTarget: NetworkPeer | null;
  onClearTarget: () => void;
  onAddHistory: (item: TransferHistoryItem) => void;
  /** 传输完成后由父级展示结果弹窗，自身保持可继续发送状态 */
  onShowResult?: (
    transfer: TransferSummary,
    title: string,
    kind: 'file' | 'text',
    destinationMode: DestinationMode
  ) => void;
  /** 外部（拖拽窗口）预填充的文件列表，变化时全部加入队列 */
  initialFiles?: File[] | null;
  /** 用户点击了「选择局域网设备」按钮 */
  onPickLanPeer?: () => void;
}

type UploadPhase =
  | 'idle'
  | 'waiting'
  | 'preparing'
  | 'uploading'
  | 'paused'
  | 'completing'
  | 'completed'
  | 'error';

export function SendPanel({
  deviceId,
  deviceName,
  selectedTarget,
  onClearTarget,
  onAddHistory,
  onShowResult,
  initialFiles,
  onPickLanPeer,
}: SendPanelProps) {
  const [destinationMode, setDestinationMode] = useState<DestinationMode>('lan');
  const [mode, setMode] = useState<'file' | 'text'>('file');

  // Encryption state
  const [encryptEnabled, setEncryptEnabled] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);

  // File state — multi-file queue
  const [dragActive, setDragActive] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const pendingFilesRef = useRef<File[]>([]);
  useEffect(() => { pendingFilesRef.current = pendingFiles; }, [pendingFiles]);
  const activeFile = pendingFiles[0] ?? null;
  const activeFileRef = useRef<File | null>(null);
  useEffect(() => { activeFileRef.current = activeFile; }, [activeFile]);
  const [fileFingerprint, setFileFingerprint] = useState<string>('');
  const fileFingerprintRef = useRef<string>('');
  useEffect(() => { fileFingerprintRef.current = fileFingerprint; }, [fileFingerprint]);
  const [detectedResume, setDetectedResume] = useState<ResumableUploadRecord | null>(null);
  const detectedResumeRef = useRef<ResumableUploadRecord | null>(null);
  useEffect(() => { detectedResumeRef.current = detectedResume; }, [detectedResume]);
  const [phase, setPhase] = useState<UploadPhase>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');

  // Live upload telemetry
  const [uploadedChunksCount, setUploadedChunksCount] = useState(0);
  const [totalChunks, setTotalChunks] = useState(0);
  const [speedBps, setSpeedBps] = useState(0);
  const [etaSeconds, setEtaSeconds] = useState(0);

  // Text state
  const [textInput, setTextInput] = useState('');
  const [sendingText, setSendingText] = useState(false);

  // Completed transfer result
  const [completedTransfer, setCompletedTransfer] = useState<TransferSummary | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pausedRef = useRef(false);
  /** 接收方取消接收标记 —— 区别于用户主动暂停 */
  const declinedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeUploadMetaRef = useRef<{
    transferId: string;
    ownerToken: string;
    fingerprint: string;
  } | null>(null);
  /** 等待接收方同意上传的挂起请求 */
  const pendingAcceptRef = useRef<{
    transferId: string;
    resolve: (verdict: 'accepted' | 'declined' | 'offline' | 'cancelled') => void;
  } | null>(null);

  const resetFileState = useCallback(() => {
    pausedRef.current = false;
    abortControllerRef.current?.abort();
    setFileFingerprint('');
    setDetectedResume(null);
    setPhase('idle');
    setErrorMsg('');
    setUploadedChunksCount(0);
    setTotalChunks(0);
    setSpeedBps(0);
    setEtaSeconds(0);
    setCompletedTransfer(null);
    activeUploadMetaRef.current = null;
  }, []);

  // Remove a file from queue (by index). If it's the active one, also clear its state.
  const removeFileAt = useCallback((idx: number) => {
    if (idx < 0 || idx >= pendingFilesRef.current.length) return;
    const wasActive = idx === 0;
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx));
    if (wasActive) {
      resetFileState();
      clearFileInput();
    }
  }, [resetFileState]);

  // After upload completes, pop the first queued file and let user upload the next one.
  const popActiveFile = useCallback(() => {
    setPendingFiles((prev) => prev.slice(1));
    resetFileState();
  }, [resetFileState]);

  // Clear hidden <input type=file> value so same file can be picked again.
  const clearFileInput = () => {
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const inspectFileForResume = useCallback(async (file: File) => {
    setErrorMsg('');
    setCompletedTransfer(null);
    setPhase('idle');
    setDetectedResume(null);

    const fp = await computeFileFingerprint(file);
    setFileFingerprint(fp);
    const total = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    setTotalChunks(total);
    setUploadedChunksCount(0);

    const map = loadResumableMap();
    const saved = map[fp];
    if (saved && saved.fileSize === file.size) {
      try {
        const res = await fetch(`/api/transfers/${encodeURIComponent(saved.transferId)}/status`);
        if (res.ok) {
          const data = await res.json();
          const serverChunks: number[] = Array.isArray(data.uploadedChunks) ? data.uploadedChunks : [];
          // 未就绪且已有分片即可续传；即使分片已全部上传（只是未合并）也应续传后收尾，
          // 否则会把已上传的分片丢掉、从头重传。
          if (data.transfer?.status !== 'ready' && serverChunks.length > 0 && serverChunks.length <= total) {
            const updated: ResumableUploadRecord = {
              ...saved,
              uploadedChunks: serverChunks,
            };
            saveResumableRecord(updated);
            setDetectedResume(updated);
            setUploadedChunksCount(serverChunks.length);
            if (saved.encryption?.enabled) {
              setEncryptEnabled(true);
            }
            return;
          }
        }
        // 仅在记录确实不可用（已就绪 / 无分片 / 已不存在）时清理断点
        removeResumableRecord(fp);
      } catch {
        // 网络异常时保留断点记录，避免把有效断点误删导致下次重传
      }
    }
  }, []);

  // When active file changes (new pick / remove / pop), inspect it for resume state.
  useEffect(() => {
    if (!activeFile) {
      resetFileState();
      return;
    }
    void inspectFileForResume(activeFile);
  }, [activeFile, inspectFileForResume, resetFileState]);

  const handleFilePick = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const incoming = Array.from(files);
    // Dedup by name+size to avoid accidental repeats.
    setPendingFiles((prev) => {
      const existingKey = new Set(prev.map((f) => `${f.name}::${f.size}`));
      const fresh = incoming.filter((f) => !existingKey.has(`${f.name}::${f.size}`));
      return [...prev, ...fresh];
    });
    clearFileInput();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    if (destinationMode === 'lan' && !selectedTarget) return;
    if (phase === 'uploading' || phase === 'completing') return;
    handleFilePick(e.dataTransfer.files);
  };

  /**
   * 上传单个文件。文件 / 断点记录 / 指纹都由调用方显式传入，
   * 避免批量循环中读到过期的 state。
   */
  const uploadSingleFile = async (
    file: File,
    resumeInput: ResumableUploadRecord | null,
    fpInput: string
  ): Promise<'done' | 'paused' | 'error' | 'empty'> => {
    if (destinationMode === 'lan' && !selectedTarget) {
      setErrorMsg('');
      onPickLanPeer?.();
      return 'error';
    }

    const resumeRecord = resumeInput;
    const willEncrypt = resumeRecord ? Boolean(resumeRecord.encryption?.enabled) : encryptEnabled;

    if (willEncrypt && !passphrase.trim()) {
      setErrorMsg('已启用 AES-256 加密，请先输入加密密码');
      return 'error';
    }

    pausedRef.current = false;
    declinedRef.current = false;
    setErrorMsg('');
    setPhase('preparing');

    try {
      const fp = fpInput || (await computeFileFingerprint(file));
      let salt = resumeRecord?.encryption?.salt;
      let baseIv = resumeRecord?.encryption?.baseIv;

      if (willEncrypt && (!salt || !baseIv)) {
        salt = generateSaltBase64();
        baseIv = generateBaseIvBase64();
      }

      const initRes = await fetch('/api/transfers/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          fileSize: file.size,
          chunkSize: CHUNK_SIZE,
          fingerprint: fp,
          resumeTransferId: resumeRecord?.transferId,
          ownerToken: resumeRecord?.ownerToken,
          senderDeviceId: deviceId,
          senderDeviceName: deviceName,
          targetDeviceId: selectedTarget?.deviceId,
          encryption: willEncrypt
            ? {
                enabled: true,
                algorithm: 'AES-256-GCM',
                salt,
                baseIv,
              }
            : { enabled: false },
        }),
      });

      const initData = await initRes.json();
      if (!initRes.ok) {
        throw new Error(initData.error || '初始化传输任务失败');
      }

      const transferId: string = initData.transferId;
      const ownerToken: string = initData.ownerToken;
      const pickupCode: string = initData.pickupCode;
      const chunkSize: number = initData.chunkSize || CHUNK_SIZE;
      const serverTotalChunks: number = initData.totalChunks;
      const uploadedSet = new Set<number>(initData.uploadedChunks || []);

      activeUploadMetaRef.current = { transferId, ownerToken, fingerprint: fp };

      const resumableState: ResumableUploadRecord = {
        transferId,
        ownerToken,
        pickupCode,
        fingerprint: fp,
        fileName: file.name,
        fileSize: file.size,
        chunkSize,
        totalChunks: serverTotalChunks,
        uploadedChunks: Array.from(uploadedSet),
        encryption: initData.encryption,
        updatedAt: Date.now(),
      };
      saveResumableRecord(resumableState);
      setDetectedResume(resumableState);
      setTotalChunks(serverTotalChunks);
      setUploadedChunksCount(uploadedSet.size);

      // 局域网直传：接收方同意后才开始上传分片
      if (destinationMode === 'lan' && selectedTarget && initData.status === 'pending') {
        setPhase('waiting');
        const verdict = await new Promise<'accepted' | 'declined' | 'offline' | 'cancelled'>(
          (resolve) => {
            pendingAcceptRef.current = { transferId, resolve };
          }
        );
        pendingAcceptRef.current = null;
        if (verdict === 'cancelled') return 'error';
        if (verdict === 'declined') {
          setPhase('error');
          setSpeedBps(0);
          setEtaSeconds(0);
          setErrorMsg('对方已取消接收，传输已终止');
          return 'error';
        }
        if (verdict === 'offline') {
          setPhase('paused');
          setSpeedBps(0);
          setEtaSeconds(0);
          return 'paused';
        }
      }

      let aesKey: CryptoKey | null = null;
      if (willEncrypt && salt && baseIv) {
        aesKey = await deriveAesKey(passphrase, salt);
      }

      setPhase('uploading');
      const uploadStartedAt = performance.now();
      let bytesTransferredThisRun = 0;

      for (let i = 0; i < serverTotalChunks; i++) {
        if (declinedRef.current) return 'error';
        if (pausedRef.current) {
          setPhase('paused');
          return 'paused';
        }
        if (uploadedSet.has(i)) {
          continue;
        }

        const start = i * chunkSize;
        const end = Math.min(file.size, start + chunkSize);
        let chunkBuffer = await file.slice(start, end).arrayBuffer();

        if (aesKey && baseIv) {
          chunkBuffer = await encryptChunkBuffer(aesKey, baseIv, i, chunkBuffer);
        }

        const controller = new AbortController();
        abortControllerRef.current = controller;

        let putRes: Response;
        try {
          putRes = await fetch(`/api/transfers/${encodeURIComponent(transferId)}/chunk/${i}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Owner-Token': ownerToken,
            },
            body: chunkBuffer,
            signal: controller.signal,
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') {
            if (declinedRef.current) return 'error';
            if (pausedRef.current) {
              setPhase('paused');
              return 'paused';
            }
          }
          throw err;
        }

        if (!putRes.ok) {
          const errJson = await putRes.json().catch(() => ({}));
          throw new Error(errJson.error || `分片 ${i + 1} 上传失败`);
        }

        uploadedSet.add(i);
        resumableState.uploadedChunks = Array.from(uploadedSet);
        resumableState.updatedAt = Date.now();
        saveResumableRecord(resumableState);
        setDetectedResume({ ...resumableState });
        setUploadedChunksCount(uploadedSet.size);

        bytesTransferredThisRun += end - start;
        const elapsedSec = Math.max(0.1, (performance.now() - uploadStartedAt) / 1000);
        const currentSpeed = bytesTransferredThisRun / elapsedSec;
        const remainingBytes = Math.max(0, file.size - uploadedSet.size * chunkSize);
        setSpeedBps(currentSpeed);
        setEtaSeconds(currentSpeed > 0 ? remainingBytes / currentSpeed : 0);
      }

      if (declinedRef.current) return 'error';
      if (pausedRef.current) {
        setPhase('paused');
        return 'paused';
      }

      setPhase('completing');
      const completeRes = await fetch(`/api/transfers/${encodeURIComponent(transferId)}/complete`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Owner-Token': ownerToken,
        },
      });
      const completeData = await completeRes.json();
      if (!completeRes.ok) {
        throw new Error(completeData.error || '校验合并文件失败');
      }

      removeResumableRecord(fp);
      setDetectedResume(null);
      const summary: TransferSummary = completeData.transfer;
      setCompletedTransfer(null);
      onShowResult?.(summary, file.name, 'file', destinationMode);

      onAddHistory({
        id: completeData.transfer.id,
        pickupCode: completeData.transfer.pickupCode,
        kind: 'file',
        direction: 'sent',
        title: file.name,
        sizeBytes: file.size,
        encrypted: willEncrypt,
        targetDeviceName: selectedTarget?.deviceName,
        createdAt: Date.now(),
      });

      return 'done';
    } catch (err) {
      // 接收方已取消：保留“对方已取消接收”的提示，不被覆盖
      if (declinedRef.current) return 'error';
      if (pausedRef.current) {
        setPhase('paused');
        return 'paused';
      }
      setPhase('error');
      setErrorMsg(err instanceof Error ? err.message : '上传过程中发生错误');
      return 'error';
    }
  };

  /** 上传队首文件（单文件按钮用），完成后移出队列 */
  const startOrResumeUpload = async (forceFresh = false) => {
    const file = activeFileRef.current;
    if (!file) return 'empty';
    if (forceFresh && fileFingerprint) {
      removeResumableRecord(fileFingerprint);
      setDetectedResume(null);
    }
    const result = await uploadSingleFile(
      file,
      forceFresh ? null : resolveResumeRecord(detectedResume, fileFingerprint),
      forceFresh ? '' : fileFingerprint
    );
    if (result === 'done') popActiveFile();
    return result;
  };

  // Sequentially upload every file in the queue. Stops on pause/cancel/error.
  const stopBatchRef = useRef(false);
  const handleUploadAll = useCallback(async () => {
    if (pendingFilesRef.current.length === 0) return;
    if (destinationMode === 'lan' && !selectedTarget) {
      setErrorMsg('');
      onPickLanPeer?.();
      return;
    }
    stopBatchRef.current = false;
    pausedRef.current = false;
    let isFirst = true;

    while (!stopBatchRef.current) {
      const file = pendingFilesRef.current[0];
      if (!file) break;

      // 队首文件沿用已检测的断点信息；后续文件重新计算指纹、无断点。
      const resume = isFirst
        ? resolveResumeRecord(detectedResumeRef.current, fileFingerprintRef.current)
        : null;
      const fp = isFirst ? fileFingerprintRef.current : '';

      const result = await uploadSingleFile(file, resume, fp);
      if (result !== 'done') break;

      isFirst = false;

      // 同步移出已完成的文件，保证下一轮读到新的队首。
      pendingFilesRef.current = pendingFilesRef.current.slice(1);
      setPendingFiles((prev) => prev.slice(1));
      resetFileState();
    }

    if (!stopBatchRef.current && pendingFilesRef.current.length === 0) {
      // All queued files uploaded successfully.
      setErrorMsg('');
    }
  }, [selectedTarget, destinationMode, onPickLanPeer, resetFileState]);

  const handlePause = () => {
    stopBatchRef.current = true;
    pausedRef.current = true;
    abortControllerRef.current?.abort();
    setPhase('paused');
    setSpeedBps(0);
  };

  const dismissResume = () => {
    if (fileFingerprintRef.current) removeResumableRecord(fileFingerprintRef.current);
    setDetectedResume(null);
  };

  // 接收方回应：同意 → 继续上传；拒绝 → 终止；离线 → 暂停
  useEffect(() => {
    const getTransferId = (e: Event) =>
      (e as CustomEvent<{ transferId?: string }>).detail?.transferId;
    const matchesActive = (transferId?: string) => {
      const meta = activeUploadMetaRef.current;
      return Boolean(transferId && meta && meta.transferId === transferId);
    };
    const resolvePending = (
      transferId: string,
      verdict: 'accepted' | 'declined' | 'offline'
    ) => {
      const pending = pendingAcceptRef.current;
      if (!pending || pending.transferId !== transferId) return false;
      pending.resolve(verdict);
      pendingAcceptRef.current = null;
      return true;
    };

    const onAccepted = (e: Event) => {
      const transferId = getTransferId(e);
      if (transferId) resolvePending(transferId, 'accepted');
    };
    const onDeclined = (e: Event) => {
      const transferId = getTransferId(e);
      if (!transferId || !matchesActive(transferId)) return;
      if (resolvePending(transferId, 'declined')) return;

      stopBatchRef.current = true;
      pausedRef.current = true;
      abortControllerRef.current?.abort();
      setPhase('error');
      setSpeedBps(0);
      setEtaSeconds(0);
      setErrorMsg('对方已取消接收，传输已终止');
    };
    const onTargetOffline = (e: Event) => {
      const transferId = getTransferId(e);
      if (!transferId || !matchesActive(transferId)) return;
      if (resolvePending(transferId, 'offline')) return;

      stopBatchRef.current = true;
      pausedRef.current = true;
      abortControllerRef.current?.abort();
      setPhase('paused');
      setSpeedBps(0);
      setEtaSeconds(0);
    };

    window.addEventListener('ft:transfer-accepted', onAccepted);
    window.addEventListener('ft:transfer-declined', onDeclined);
    window.addEventListener('ft:transfer-target-offline', onTargetOffline);
    return () => {
      window.removeEventListener('ft:transfer-accepted', onAccepted);
      window.removeEventListener('ft:transfer-declined', onDeclined);
      window.removeEventListener('ft:transfer-target-offline', onTargetOffline);
    };
  }, []);

  const handleCancelUpload = async () => {
    stopBatchRef.current = true;
    pausedRef.current = true;
    pendingAcceptRef.current?.resolve('cancelled');
    pendingAcceptRef.current = null;
    abortControllerRef.current?.abort();
    // Drop remaining queued files — they won't be sent.
    setPendingFiles([]);
    const meta = activeUploadMetaRef.current || (detectedResume ? {
      transferId: detectedResume.transferId,
      ownerToken: detectedResume.ownerToken,
      fingerprint: detectedResume.fingerprint,
    } : null);

    if (meta) {
      removeResumableRecord(meta.fingerprint);
      await fetch(`/api/transfers/${encodeURIComponent(meta.transferId)}`, {
        method: 'DELETE',
        headers: { 'X-Owner-Token': meta.ownerToken },
      }).catch(() => {});
    }
    resetFileState();
    clearFileInput();
  };

  const handleSendText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) {
      setErrorMsg('请输入要传输的文本内容');
      return;
    }
    if (destinationMode === 'lan' && !selectedTarget) {
      setErrorMsg('');
      onPickLanPeer?.();
      return;
    }
    if (encryptEnabled && !passphrase.trim()) {
      setErrorMsg('已启用 AES-256 加密，请先输入加密密码');
      return;
    }

    const textInputBefore = textInput;
    setErrorMsg('');
    setSendingText(true);
    try {
      let payloadText = textInput;
      let encryptionPayload: Record<string, unknown> = { enabled: false };

      if (encryptEnabled) {
        const encrypted = await encryptTextPayload(textInput, passphrase);
        payloadText = encrypted.ciphertext;
        encryptionPayload = {
          enabled: true,
          algorithm: 'AES-256-GCM',
          salt: encrypted.salt,
          iv: encrypted.iv,
        };
      }

      const res = await fetch('/api/transfers/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          textContent: payloadText,
          encryption: encryptionPayload,
          senderDeviceId: deviceId,
          senderDeviceName: deviceName,
          targetDeviceId: selectedTarget?.deviceId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || '发送文本失败');
      }

      const summary: TransferSummary = data.transfer;
      setCompletedTransfer(null);
      setTextInput('');
      onShowResult?.(
        summary,
        encryptEnabled ? '加密文本消息' : textInputBefore.slice(0, 40).replace(/\s+/g, ' '),
        'text',
        destinationMode
      );
      onAddHistory({
        id: data.transfer.id,
        pickupCode: data.transfer.pickupCode,
        kind: 'text',
        direction: 'sent',
        title: encryptEnabled ? '加密文本消息' : textInput.slice(0, 40).replace(/\s+/g, ' '),
        sizeBytes: new Blob([textInput]).size,
        encrypted: encryptEnabled,
        targetDeviceName: selectedTarget?.deviceName,
        createdAt: Date.now(),
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '发送文本失败');
    } finally {
      setSendingText(false);
    }
  };

  useEffect(() => {
    if (!initialFiles || initialFiles.length === 0) return;
    setMode('file');
    // Append the prefilled files into the queue (dedup by name+size).
    // The activeFile effect below auto-inspects the first one for resume state.
    setPendingFiles((prev) => {
      const existingKey = new Set(prev.map((f) => `${f.name}::${f.size}`));
      const fresh = initialFiles.filter((f) => !existingKey.has(`${f.name}::${f.size}`));
      return [...prev, ...fresh];
    });
  }, [initialFiles]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  if (completedTransfer) {
    // Result modal handled by parent now. Guard kept only to avoid flashing
    // in any residual path — SendPanel self-resets on completion.
    return null;
  }

  const percent =
    totalChunks > 0 ? Math.min(100, (uploadedChunksCount / totalChunks) * 100) : 0;

  // 局域网模式必须先选中设备；二维码/取件码模式本身即是目标
  const targetReady = destinationMode !== 'lan' || selectedTarget != null;
  // 未选择目标时只展示待机动画；已排队文件或已输入文本时保留控件，避免传输中目标丢失就看不到进度
  const showTransferControls =
    targetReady || pendingFiles.length > 0 || textInput.trim().length > 0;

  return (
    <div className="space-y-3 sm:space-y-5">
      {/* Card 1 — 选择目的地 */}
      <section className="bg-white rounded-md sm:rounded-2xl border border-[#E5E5EA] p-3 sm:p-6">
        <DestinationPicker
          mode={destinationMode}
          onChange={(m) => {
            setDestinationMode(m);
            setErrorMsg('');
          }}
          selectedPeer={selectedTarget}
          onClearPeer={onClearTarget}
          onPickLanPeer={() => {
            setDestinationMode('lan');
            setErrorMsg('');
            onPickLanPeer?.();
          }}
        />
      </section>

      {/* Card 2 — 传输内容 */}
      <section className="bg-white rounded-md sm:rounded-2xl border border-[#E5E5EA] p-3 sm:p-8 space-y-4 sm:space-y-6">
        {showTransferControls ? (
          <>
        {/* Top Mode Segmented Switch */}
      <div
        className="inline-flex p-1 bg-[#F5F5F7] rounded-xl self-start"
        role="tablist"
        aria-label="传输类型"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'file'}
          disabled={!targetReady}
          onClick={() => {
            setMode('file');
            setErrorMsg('');
          }}
          className={`px-4 py-2 text-xs font-medium rounded-md sm:rounded-lg transition-all whitespace-nowrap shrink-0 disabled:cursor-not-allowed ${
            mode === 'file'
              ? 'bg-white text-[#1D1D1F] shadow-sm'
              : 'text-[#6E6E73] hover:text-[#1D1D1F]'
          }`}
        >
          文件
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'text'}
          disabled={!targetReady}
          onClick={() => {
            setMode('text');
            setErrorMsg('');
          }}
          className={`px-4 py-2 text-xs font-medium rounded-md sm:rounded-lg transition-all whitespace-nowrap shrink-0 disabled:cursor-not-allowed ${
            mode === 'text'
              ? 'bg-white text-[#1D1D1F] shadow-sm'
              : 'text-[#6E6E73] hover:text-[#1D1D1F]'
          }`}
        >
          文本
        </button>
      </div>

      {/* File Mode */}
      {mode === 'file' && (
        <div className="space-y-2 sm:space-y-5">
          {pendingFiles.length === 0 ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (!targetReady) return;
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={handleDrop}
              onClick={() => {
                if (!targetReady) return;
                fileInputRef.current?.click();
              }}
              className={`border border-dashed rounded-md sm:rounded-2xl px-2 sm:px-6 py-6 sm:py-14 text-center transition-colors ${
                !targetReady
                  ? 'border-[#E5E5EA] bg-[#F5F5F7]/30 cursor-not-allowed'
                  : dragActive
                    ? 'border-[#1D1D1F] bg-[#1D1D1F]/4 cursor-pointer'
                    : 'border-[#D2D2D7] bg-[#F5F5F7]/60 hover:bg-[#F5F5F7] cursor-pointer'
              }`}
            >
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                disabled={!targetReady}
                onChange={(e) => handleFilePick(e.target.files)}
              />
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-md sm:rounded-2xl bg-white border border-[#E5E5EA] flex items-center justify-center mx-auto mb-2 sm:mb-4">
                <UploadCloud className="w-6 h-6 text-[#1D1D1F]" />
              </div>
              <p className="text-base font-semibold text-[#1D1D1F]">
                点我上传
              </p>
              <p className="text-xs text-[#6E6E73] mt-1.5">
                最大 10 GB
              </p>
            </div>
          ) : (
            <div className="border border-[#E5E5EA] rounded-md sm:rounded-2xl p-2 sm:p-5 space-y-2 sm:space-y-4">
              {/* File Queue List — 全部行统一，无 active 高亮 */}
              <div className="space-y-1.5">
                {pendingFiles.map((file, idx) => {
                  const isActive = idx === 0;
                  return (
                    <div
                      key={`${file.name}-${file.size}-${idx}`}
                      className="flex items-center justify-between gap-2 px-2 sm:px-3 py-2 rounded-md transition-colors bg-[#F5F5F7]"
                    >
                      <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
                        <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-md bg-[#1D1D1F] flex items-center justify-center shrink-0">
                          <FileUp className="w-4 h-4 text-white" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-[#1D1D1F] truncate">
                            {file.name}
                          </p>
                          <p className="text-sm text-[#6E6E73] tabular-nums">
                            {formatBytes(file.size)}
                            {isActive ? (
                              <>
                                {' · '}{totalChunks} 分片
                                {encryptEnabled ? ' · 加密' : ''}
                              </>
                            ) : (
                              <> · 等待中</>
                            )}
                          </p>
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={
                          isActive &&
                          (phase === 'waiting' || phase === 'uploading' || phase === 'completing')
                        }
                        onClick={() => removeFileAt(idx)}
                        className="p-1.5 text-[#86868B] hover:text-[#DC2626] hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors cursor-pointer shrink-0"
                        aria-label={`移除 ${file.name}`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Resumable Checkpoint Notice */}
              {detectedResume && phase === 'idle' && (
                <div className="p-2 sm:p-3.5 rounded-xl bg-[#1D1D1F]/6 border border-[#1D1D1F]/20 flex items-center justify-between gap-2 sm:gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <CheckCircle2 className="w-4 h-4 text-[#1D1D1F] shrink-0" />
                    <div className="text-sm text-[#1D1D1F] tabular-nums truncate">
                      <span className="font-semibold">上次传输</span>
                      {' · '}
                      {detectedResume.uploadedChunks.length}/{detectedResume.totalChunks} 分片（
                      {Math.round((detectedResume.uploadedChunks.length / detectedResume.totalChunks) * 100)}
                      %）
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => void startOrResumeUpload(true)}
                      className="inline-flex items-center gap-1 px-2 py-1 text-sm font-medium text-[#6E6E73] hover:text-[#1D1D1F] whitespace-nowrap cursor-pointer"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      重新上传
                    </button>
                    <button
                      type="button"
                      onClick={dismissResume}
                      aria-label="关闭"
                      className="p-1 text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-white rounded-md transition-colors cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}

              {/* Live Progress Bar */}
              {(phase === 'waiting' ||
                phase === 'uploading' ||
                phase === 'paused' ||
                phase === 'completing' ||
                phase === 'preparing' ||
                (phase === 'error' && uploadedChunksCount > 0)) && (
                <div className="pt-1 sm:pt-2 space-y-1.5 sm:space-y-2.5">
                  <div className="flex items-center justify-between text-xs tabular-nums">
                    <span className="font-medium text-[#1D1D1F]">
                      {phase === 'waiting' && '等待对方接受...'}
                      {phase === 'preparing' && '正在校验断点与密钥...'}
                      {phase === 'uploading' &&
                        `正在传输 · ${formatSpeed(speedBps)} · ${formatEta(etaSeconds)}`}
                      {phase === 'paused' && '已暂停 · 进度已安全保存'}
                      {phase === 'completing' && '正在验证分片完整性...'}
                      {phase === 'error' && '传输中断 · 可点击继续从断点恢复'}
                    </span>
                    <span className="font-mono font-semibold text-[#1D1D1F]">
                      {percent.toFixed(1)}%
                    </span>
                  </div>

                  <div className="h-2 w-full bg-[#F5F5F7] rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-200 apple-ease ${
                        phase === 'paused' || phase === 'error'
                          ? 'bg-[#86868B]'
                          : 'bg-[#1D1D1F]'
                      }`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-xs text-[#6E6E73] font-mono tabular-nums">
                    <span>
                      {formatBytes(Math.min(activeFile.size, uploadedChunksCount * CHUNK_SIZE))} /{' '}
                      {formatBytes(activeFile.size)}
                    </span>
                    <span>
                      {uploadedChunksCount} / {totalChunks} 分片
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Text Mode */}
      {mode === 'text' && (
        <form onSubmit={handleSendText} className="space-y-2 sm:space-y-4">
          <div>
          
            <textarea
              id="text-transfer-input"
              rows={7}
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              disabled={!targetReady}
              placeholder="在此粘贴或输入传输的文本..."
              className="w-full rounded-md sm:rounded-2xl border border-[#E5E5EA] bg-[#F5F5F7]/50 focus:bg-white focus:border-[#1D1D1F] focus:outline-none p-4 text-sm text-[#1D1D1F] leading-relaxed resize-y transition-colors disabled:cursor-not-allowed"
            />
          </div>
        </form>
      )}

      {/* End-to-End Encryption Settings */}
      <div className="pt-3 sm:pt-5 border-t border-[#E5E5EA] space-y-3 sm:space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-[#F5F5F7] flex items-center justify-center shrink-0">
              <ShieldCheck
                className={`w-4.5 h-4.5 ${encryptEnabled ? 'text-[#1D1D1F]' : 'text-[#6E6E73]'}`}
              />
            </div>
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-medium text-[#1D1D1F]">端到端加密</p>
              <InfoTip>
                采用 AES-256-GCM 算法，文件分片与文本在浏览器本地加密后上传，服务器不保存密码。接收方需输入相同密码才能解密，请通过其他安全渠道单独告知。
              </InfoTip>
            </div>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={encryptEnabled}
            disabled={
              !targetReady ||
              phase === 'uploading' ||
              phase === 'completing' ||
              Boolean(detectedResume)
            }
            onClick={() => setEncryptEnabled((prev) => !prev)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 disabled:opacity-50 ${
              encryptEnabled ? 'bg-[#1D1D1F]' : 'bg-[#D2D2D7]'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition duration-200 ${
                encryptEnabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {encryptEnabled && (
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-2.5">
            <div className="relative flex-1">
              <Lock className="w-4 h-4 text-[#86868B] absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type={showPassphrase ? 'text' : 'password'}
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                disabled={!targetReady || phase === 'uploading' || phase === 'completing'}
                placeholder="输入加密密码"
                className="w-full pl-10 pr-10 py-2.5 text-sm rounded-xl border border-[#E5E5EA] bg-[#F5F5F7]/50 focus:bg-white focus:border-[#1D1D1F] focus:outline-none text-[#1D1D1F]"
              />
              <button
                type="button"
                onClick={() => setShowPassphrase((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-[#86868B] hover:text-[#1D1D1F] cursor-pointer"
                aria-label={showPassphrase ? '隐藏密码' : '显示密码'}
              >
                {showPassphrase ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            {!detectedResume && (
              <button
                type="button"
                disabled={!targetReady || phase === 'uploading' || phase === 'completing'}
                onClick={() => {
                  setPassphrase(generateStrongPassphrase());
                  setShowPassphrase(true);
                }}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-medium text-[#1D1D1F] bg-[#F5F5F7] hover:bg-[#E8E8ED] rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <KeyRound className="w-3.5 h-3.5" />
                生成强密码
              </button>
            )}
          </div>
        )}
      </div>

      {/* Error Message */}
      {errorMsg && (
        <div className="flex items-center gap-2 text-xs text-[#DC2626] bg-[#DC2626]/6 px-2 sm:px-4 py-2 sm:py-3 rounded-xl">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Action Buttons */}
      <div className="pt-2 sm:pt-2 flex flex-wrap items-center justify-between gap-2 sm:gap-3">
     

        {mode === 'file' ? (
          <div className="flex items-center gap-2.5 ml-auto">
            {(phase === 'waiting' ||
              ((phase === 'uploading' || phase === 'paused' || phase === 'error') &&
                uploadedChunksCount > 0)) && (
                <button
                  type="button"
                  onClick={() => void handleCancelUpload()}
                  className="px-4 py-2.5 text-xs font-medium text-[#DC2626] bg-[#DC2626]/8 hover:bg-[#DC2626]/14 rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  取消传输
                </button>
              )}

            {phase === 'waiting' ? (
              <button
                type="button"
                disabled
                className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-medium text-white bg-[#1D1D1F] disabled:opacity-45 rounded-xl transition-colors whitespace-nowrap shrink-0"
              >
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                等待对方接受
              </button>
            ) : phase === 'uploading' ? (
              <button
                type="button"
                onClick={handlePause}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-medium text-[#1D1D1F] bg-[#F5F5F7] hover:bg-[#E8E8ED] rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Pause className="w-3.5 h-3.5" />
                暂停上传
              </button>
            ) : phase === 'paused' || phase === 'error' ? (
              <button
                type="button"
                disabled={!targetReady || pendingFiles.length === 0}
                onClick={() => void handleUploadAll()}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-medium text-white bg-[#1D1D1F] hover:bg-[#000000] disabled:opacity-45 rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" />
                {pendingFiles.length > 1 ? `继续传输 (${pendingFiles.length})` : '继续断点续传'}
              </button>
            ) : (
              <button
                type="button"
                disabled={
                  !targetReady ||
                  pendingFiles.length === 0 ||
                  phase === 'preparing' ||
                  phase === 'completing'
                }
                onClick={() => void handleUploadAll()}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-medium text-white bg-[#1D1D1F] hover:bg-[#000000] disabled:opacity-45 rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Send className="w-3.5 h-3.5" />
                {detectedResume ? '继续' : '上传'}
              </button>
            )}
          </div>
        ) : (
          <button
            type="button"
            disabled={!targetReady || sendingText || !textInput.trim()}
            onClick={(e) => void handleSendText(e)}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-medium text-white bg-[#1D1D1F] hover:bg-[#000000] disabled:opacity-45 rounded-xl transition-colors whitespace-nowrap shrink-0 ml-auto cursor-pointer"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {sendingText ? '正在发送...' : '发送'}
          </button>
        )}
      </div>
          </>
        ) : (
          <TransferAnimation badge={null} title="选择设备或传输方式" />
        )}
      </section>
    </div>
  );
}
