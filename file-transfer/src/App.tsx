import { useCallback, useEffect, useState } from 'react';
import AppHeader from './components/AppHeader';
import { IncomingModal } from './components/IncomingModal';
import ToastHost from './components/ToastHost';
import type { MainTab, ModalKind } from './types/app';
import type { TransferHistoryItem, NetworkPeer, TransferSummary } from './types/transfer';
import { useDeviceNetwork } from './hooks/useDeviceNetwork';
import { useProgressiveDownload } from './hooks/useProgressiveDownload';
import { loadPendingDownload } from './lib/downloadStore';
import { showToast } from './lib/toast';
import HomeView from './views/HomeView';

const HISTORY_STORAGE_KEY = 'airvault_transfer_history';

function loadHistory(): TransferHistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export default function App() {
  // 仅 URL 里的 ?code= 才允许自动填入取件码，其它来源只预填/不填
  const initialUrlCode = new URLSearchParams(window.location.search).get('code') || '';
  const [mainTab, setMainTab] = useState<MainTab>('send');
  const [modalState, setModalState] = useState<ModalKind>(null);
  const [receivePrefill, setReceivePrefill] = useState<{ code: string; auto: boolean } | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<NetworkPeer | null>(null);
  const [history, setHistory] = useState<TransferHistoryItem[]>(() => loadHistory());
  /** 局域网接收：直接把已就绪的传输对象交给接收面板，不再展示取件码 */
  const [receiveTransfer, setReceiveTransfer] = useState<TransferSummary | null>(null);
  /** 下载状态由 App 层持有，关闭 / 重建接收模态框不会重置进度 */
  const {
    progress: receiveProgress,
    downloading: receiveDownloading,
    downloadedChunks: receiveDownloadedChunks,
    speedBps: receiveDownloadSpeed,
    error: receiveDownloadError,
    start: startDownload,
    reset: resetDownload,
  } = useProgressiveDownload();

  const {
    deviceId,
    displayCode,
    deviceName,
    deviceType,
    updateDeviceName,
    yourIp,
    subnet,
    peers,
    connected,
    scanning,
    lastScannedAt,
    triggerScan,
    incomingTransfers,
    acceptIncoming,
    closeIncoming,
    notifyDownloaded,
    dismissIncoming,
  } = useDeviceNetwork();

  // Clear selected target if peer disconnects
  useEffect(() => {
    if (selectedTarget && !peers.some((p) => p.deviceId === selectedTarget.deviceId)) {
      setSelectedTarget(null);
    }
  }, [peers, selectedTarget]);

  // 上次未完成的下载任务：恢复接收对象，用户可通过右下角入口继续下载
  useEffect(() => {
    if (initialUrlCode) return; // URL 带取件码时优先走取件流程
    const pending = loadPendingDownload();
    if (pending) setReceiveTransfer(pending.transfer);
  }, []);

  // URL 里的取件码：先校验有效（6 位且服务端存在），有效才弹出取件模态框
  useEffect(() => {
    if (!initialUrlCode) return;
    const clean = initialUrlCode.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6);
    if (clean.length !== 6) {
      showToast('取件码无效', 'error');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/transfers/code/${encodeURIComponent(clean)}`);
        if (cancelled) return;
        if (!res.ok) {
          showToast('取件码无效或已过期', 'error');
          return;
        }
        setReceivePrefill({ code: clean, auto: true });
        setModalState('receive');
      } catch {
        if (!cancelled) showToast('取件码校验失败，请稍后重试', 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialUrlCode]);

  const handleAddHistory = useCallback((item: TransferHistoryItem) => {
    setHistory((prev) => {
      const filtered = prev.filter(
        (existing) => !(existing.id === item.id && existing.direction === item.direction)
      );
      const next = [item, ...filtered].slice(0, 30);
      try { localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const handleClearHistory = useCallback(() => {
    setHistory([]);
    localStorage.removeItem(HISTORY_STORAGE_KEY);
  }, []);

  const openReceive = useCallback(() => {
    setReceiveTransfer(null);
    resetDownload();
    setModalState('receive');
  }, [resetDownload]);
  const openHistory = useCallback(() => setModalState('history'), []);
  // 关闭时清空预填，避免下次打开又自动填入上一条取件码；
  // 局域网接收界面被关闭时告知发送方，但保留接收对象以便右下角按钮重新打开
  const closeModal = useCallback(() => {
    if (modalState === 'receive' && receiveTransfer) closeIncoming(receiveTransfer.id);
    setModalState(null);
    setReceivePrefill(null);
  }, [modalState, receiveTransfer, closeIncoming]);

  // 接收完成（下载完成 / 文本已复制）后关闭弹窗回到主界面。
  // 局域网直连与取件码取件都返回主页。
  const handleReceiveComplete = useCallback(() => {
    setReceiveTransfer(null);
    resetDownload();
    setModalState(null);
  }, [resetDownload]);

  // 局域网接收：回复发送方已接受，并直接展示该传输内容（无取件码）
  const handleAcceptIncoming = useCallback(
    (transfer: TransferSummary) => {
      acceptIncoming(transfer.id);
      setReceivePrefill(null);
      setReceiveTransfer(transfer);
      resetDownload();
      setModalState('receive');
    },
    [acceptIncoming, resetDownload]
  );

  // 接收方点击下载：下载由 App 层执行（关闭模态框后进度与任务都保留），
  // 同时通知发送方「对方已成功接收」。
  const handleStartDownload = useCallback(
    (transfer: TransferSummary, passphrase: string) => {
      // 局域网直连：点击下载即通知发送方；取件码取件在完成时由服务端提示发送方
      if (receiveTransfer !== null) notifyDownloaded(transfer.id);
      void startDownload({
        transfer,
        passphrase,
        // 取件码取件（非局域网直连）完成后使取件码失效并删除文件
        consumeOnComplete: receiveTransfer === null,
        onAddHistory: handleAddHistory,
        onComplete: handleReceiveComplete,
      });
    },
    [notifyDownloaded, startDownload, handleAddHistory, handleReceiveComplete, receiveTransfer]
  );

  // 断点续传：接收方收到「继续上传」信号后，打开接收界面并展示已接收的进度；
  // 若该传输此前已下载完成，则不再弹出取件/接收窗口，保持主界面。
  useEffect(() => {
    const onResumed = (e: Event) => {
      const transfer = (e as CustomEvent<{ transfer?: TransferSummary }>).detail?.transfer;
      if (!transfer) return;
      const alreadyDownloaded = loadHistory().some(
        (item) => item.id === transfer.id && item.direction === 'received'
      );
      if (alreadyDownloaded) return;
      setReceivePrefill(null);
      resetDownload();
      setReceiveTransfer(transfer);
      setModalState('receive');
    };
    window.addEventListener('ft:transfer-resumed', onResumed);
    return () => window.removeEventListener('ft:transfer-resumed', onResumed);
  }, [resetDownload]);

  // 发送方离线：接收方中止本次接收并回到主界面
  useEffect(() => {
    const onSenderOffline = (e: Event) => {
      const transferId = (e as CustomEvent<{ transferId?: string }>).detail?.transferId;
      if (!transferId || receiveTransfer?.id !== transferId) return;
      setReceiveTransfer(null);
      resetDownload();
      setModalState(null);
    };
    window.addEventListener('ft:transfer-sender-offline', onSenderOffline);
    return () => window.removeEventListener('ft:transfer-sender-offline', onSenderOffline);
  }, [receiveTransfer, resetDownload]);

  return (
    <div className="min-h-screen flex flex-col bg-[#F5F5F7] text-[#1D1D1F]">
      <AppHeader mainTab={mainTab} onSwitchTab={setMainTab} onOpenReceive={openReceive} displayCode={displayCode} />

      <HomeView
        mainTab={mainTab}
        modalState={modalState}
        onSwitchTab={setMainTab}
        onOpenModal={setModalState}
        onCloseModal={closeModal}
        deviceId={deviceId}
        displayCode={displayCode}
        deviceName={deviceName}
        deviceType={deviceType}
        updateDeviceName={updateDeviceName}
        selectedTarget={selectedTarget}
        onClearTarget={() => setSelectedTarget(null)}
        onSelectTarget={setSelectedTarget}
        receiveCode={receivePrefill?.code ?? ''}
        receiveAutoFill={receivePrefill?.auto ?? false}
        receiveTransfer={receiveTransfer}
        onReceiveComplete={handleReceiveComplete}
        receiveProgress={receiveProgress}
        receiveDownloading={receiveDownloading}
        receiveDownloadedChunks={receiveDownloadedChunks}
        receiveDownloadSpeed={receiveDownloadSpeed}
        receiveDownloadError={receiveDownloadError}
        onStartDownload={handleStartDownload}
        yourIp={yourIp}
        subnet={subnet}
        peers={peers}
        connected={connected}
        scanning={scanning}
        lastScannedAt={lastScannedAt}
        triggerScan={() => void triggerScan()}
        history={history}
        onAddHistory={handleAddHistory}
        onClearHistory={handleClearHistory}
      />

      <IncomingModal
        notices={incomingTransfers}
        hidden={modalState !== null}
        onAccept={handleAcceptIncoming}
        onDismiss={dismissIncoming}
      />

      <ToastHost />
    </div>
  );
}
