import { useCallback, useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { NetworkPeer, TransferHistoryItem, TransferSummary } from '../types/transfer';
import type { MainTab, ModalKind } from '../types/app';
import { DeviceRadar } from '../components/DeviceRadar';
import DropPreviewModal from '../components/DropPreviewModal';
import { HistoryPanel } from '../components/HistoryPanel';
import LanPeerPickerModal from '../components/LanPeerPickerModal';
import type { DestinationMode } from '../components/DestinationPicker';
import { QrCodeCard, QrCodeMode } from '../components/QrCodeCard';
import TransferAnimation from '../components/TransferAnimation';
import { ReceivePanel } from '../components/ReceivePanel';
import { SendPanel } from '../components/SendPanel';
import AppModal from '../components/AppModal';
import { collectFromDataTransfer } from '../lib/drop';

export interface HomeViewProps {
  mainTab: MainTab;
  modalState: ModalKind;
  onSwitchTab: (tab: MainTab) => void;
  onOpenModal: (kind: ModalKind) => void;
  onCloseModal: () => void;
  // Device identity
  deviceId: string;
  displayCode: string;
  deviceName: string;
  deviceType: 'desktop' | 'mobile' | 'tablet';
  updateDeviceName: (name: string) => void;
  // Send state
  selectedTarget: NetworkPeer | null;
  onClearTarget: () => void;
  onSelectTarget: (peer: NetworkPeer) => void;
  // Receive state
  receiveCode: string;
  /** 是否自动填入取件码（仅 URL 携带 code 时为 true） */
  receiveAutoFill: boolean;
  /** 局域网接收：直接展示的传输对象（不显示取件码） */
  receiveTransfer: TransferSummary | null;
  /** 接收完成（下载完成 / 文本已复制） */
  onReceiveComplete: () => void;
  /** 下载进度 0-100（由 App 层持有，关闭模态框不重置） */
  receiveProgress: number;
  /** 下载状态（由 App 层持有） */
  receiveDownloading: boolean;
  receiveDownloadedChunks: number;
  receiveDownloadSpeed: number;
  receiveDownloadError: string;
  /** 开始下载：下载任务在 App 层执行，模态框关闭也不中断 */
  onStartDownload: (transfer: TransferSummary, passphrase: string) => void;
  // Radar
  yourIp: string;
  subnet: string;
  peers: NetworkPeer[];
  connected: boolean;
  scanning: boolean;
  lastScannedAt: number;
  triggerScan: () => void;
  // History
  history: TransferHistoryItem[];
  onAddHistory: (item: TransferHistoryItem) => void;
  onClearHistory: () => void;
}

interface ResultModal {
  transfer: TransferSummary;
  title: string;
  kind: 'file' | 'text';
  destinationMode: DestinationMode;
}

function destinationToDisplayMode(mode: DestinationMode): QrCodeMode {
  // LAN peer-to-peer doesn't need pickup UI, but we still show both (user may want fallback)
  if (mode === 'phone') return 'phone';
  if (mode === 'code') return 'code';
  return 'both';
}

/** Main area: send/LAN tabs on main content, receive/history as modals + window drop overlay */
export default function HomeView({
  mainTab,
  modalState,
  onSwitchTab,
  onOpenModal,
  onCloseModal,
  deviceId,
  displayCode,
  deviceName,
  deviceType,
  updateDeviceName,
  selectedTarget,
  onClearTarget,
  onSelectTarget,
  receiveCode,
  receiveAutoFill,
  receiveTransfer,
  onReceiveComplete,
  receiveProgress,
  receiveDownloading,
  receiveDownloadedChunks,
  receiveDownloadSpeed,
  receiveDownloadError,
  onStartDownload,
  yourIp,
  subnet,
  peers,
  connected,
  scanning,
  lastScannedAt,
  triggerScan,
  history,
  onAddHistory,
  onClearHistory
}: HomeViewProps) {
  const [resultModal, setResultModal] = useState<ResultModal | null>(null);
  const [lanPickerOpen, setLanPickerOpen] = useState(false);

  // 对方接受 / 拒绝 / 关闭接收界面时，关闭发送方的「已发送」模态框
  useEffect(() => {
    const onPeerReply = (e: Event) => {
      const transferId = (e as CustomEvent<{ transferId?: string }>).detail?.transferId;
      setResultModal((prev) => (prev && prev.transfer.id === transferId ? null : prev));
    };
    const events = [
      'ft:transfer-accepted',
      'ft:transfer-declined',
      'ft:transfer-closed',
      'ft:transfer-downloaded',
    ];
    events.forEach((ev) => window.addEventListener(ev, onPeerReply));
    return () => events.forEach((ev) => window.removeEventListener(ev, onPeerReply));
  }, []);

  // ------- Window-level drag-and-drop -------
  const [windowDragOver, setWindowDragOver] = useState(false);
  const [droppedFiles, setDroppedFiles] = useState<File[] | null>(null);
  const [sendPrefill, setSendPrefill] = useState<{ id: string; files: File[] } | null>(null);
  const dragDepthRef = useRef(0);
  const prefillSeqRef = useRef(0);

  useEffect(() => {
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      if (!windowDragOver) setWindowDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setWindowDragOver(false);
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
    };
    const onDrop = async (e: DragEvent) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setWindowDragOver(false);
      const files = await collectFromDataTransfer(e.dataTransfer);
      if (files.length > 0) setDroppedFiles(files);
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [windowDragOver]);

  const handleDropConfirm = useCallback((files: File[]) => {
    if (files.length === 0) return;
    prefillSeqRef.current += 1;
    setSendPrefill({ id: String(prefillSeqRef.current), files });
    setDroppedFiles(null);
    onSwitchTab('send');
  }, [onSwitchTab]);

  const handleDropCancel = useCallback(() => setDroppedFiles(null), []);

  const toggleModal = (kind: Exclude<ModalKind, null>) => {
    onOpenModal(modalState === kind ? null : kind);
  };

  return (
    <>
      <main className="flex-1 max-w-6xl w-full mx-auto px-3 sm:px-6 py-3 sm:py-10 space-y-4 sm:space-y-8">
        {/* Intro + Pill Buttons */}
        <section className="max-w-2xl space-y-3 sm:space-y-5">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-[#1D1D1F] [text-wrap:balance]">
            文件快传
          </h1>
          <div className="flex items-center gap-2 flex-wrap">
            <PillButton current={mainTab} value="send" label="发送" onClick={onSwitchTab} />
            <PillModalButton
              open={modalState === 'receive'}
              label="取件"
              onClick={() => toggleModal('receive')}
            />
            <PillModalButton
              open={modalState === 'history'}
              label="记录"
              onClick={() => toggleModal('history')}
            />
          </div>
        </section>

        {/* Main content — single full-width panel */}
        <section>
          {mainTab === 'send' && (
            <SendPanel
              key={sendPrefill?.id}
              deviceId={deviceId}
              deviceName={deviceName}
              selectedTarget={selectedTarget}
              onClearTarget={onClearTarget}
              onAddHistory={onAddHistory}
              initialFiles={sendPrefill?.files ?? null}
              onPickLanPeer={() => setLanPickerOpen(true)}
              onShowResult={(transfer, title, kind, destMode) =>
                setResultModal({ transfer, title, kind, destinationMode: destMode })
              }
            />
          )}
        </section>
      </main>

      {/* Window drag overlay */}
      {windowDragOver && (
        <div className="fixed inset-0 z-40 pointer-events-none bg-[#1D1D1F]/8 backdrop-blur-sm border-[6px] border-dashed border-[#1D1D1F] rounded-none flex items-center justify-center">
      
        </div>
      )}

      {/* Receive Modal */}
      <AppModal
        open={modalState === 'receive'}
        title={receiveTransfer ? '接收' : '取件'}
        onClose={onCloseModal}
      >
        <ReceivePanel
          initialCode={receiveCode}
          autoFill={receiveAutoFill}
          directTransfer={receiveTransfer}
          onReceiveComplete={onReceiveComplete}
          downloadProgress={receiveProgress}
          downloading={receiveDownloading}
          downloadedChunks={receiveDownloadedChunks}
          downloadSpeed={receiveDownloadSpeed}
          downloadError={receiveDownloadError}
          onStartDownload={onStartDownload}
          onAddHistory={onAddHistory}
        />
      </AppModal>

      {/* History Modal */}
      <AppModal
        open={modalState === 'history'}
        title="记录"
        onClose={onCloseModal}
        widthClassName="max-w-xl"
      >
        <HistoryPanel
          items={history}
          onClearHistory={onClearHistory}
        />
      </AppModal>

      {/* Result Modal — QR code + pickup code after send */}
      <AppModal
        open={resultModal != null}
        title="已发送"
        onClose={() => setResultModal(null)}
        widthClassName="max-w-2xl"
      >
        {resultModal && (
          resultModal.destinationMode === 'lan' ? (
            <TransferAnimation
              fileName={resultModal.title}
              targetName={selectedTarget?.deviceName}
            />
          ) : (
            <QrCodeCard
              transferId={resultModal.transfer.id}
              pickupCode={resultModal.transfer.pickupCode}
              encrypted={resultModal.transfer.encryption.enabled}
              kind={resultModal.kind}
              title={resultModal.title}
              displayMode={destinationToDisplayMode(resultModal.destinationMode)}
              onReset={() => setResultModal(null)}
            />
          )
        )}
      </AppModal>

      {/* LAN peer picker — opened from SendPanel DestinationPicker */}
      <LanPeerPickerModal
        open={lanPickerOpen}
        peers={peers}
        scanning={scanning}
        connected={connected}
        subnet={subnet}
        selectedPeerId={selectedTarget?.deviceId || null}
        onClose={() => setLanPickerOpen(false)}
        onSelect={(peer) => {
          onSelectTarget(peer);
          setLanPickerOpen(false);
        }}
        onRescan={triggerScan}
      />

      {/* Drop preview modal */}
      {droppedFiles && (
        <DropPreviewModal
          files={droppedFiles}
          onConfirm={handleDropConfirm}
          onClose={handleDropCancel}
        />
      )}

      {/* 接收窗口被关闭但仍有待接收内容时，右下角提供重开入口 */}
      {receiveTransfer && modalState !== 'receive' && (
        <button
          type="button"
          onClick={() => onOpenModal('receive')}
          className="fixed bottom-5 right-5 sm:bottom-8 sm:right-8 z-40 w-14 h-14 sm:w-16 sm:h-16 rounded-full bg-white border border-[#E5E5EA] shadow-xl overflow-hidden flex items-center justify-center cursor-pointer"
          aria-label="打开接收窗口"
          title="打开接收窗口"
        >
          <svg
            className="absolute inset-0 w-full h-full"
            viewBox="0 0 64 64"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <g transform={`translate(0 ${64 - (64 * receiveProgress) / 100})`}>
              <rect x="0" y="0" width="64" height="64" fill="#1D1D1F" />
              <g>
                <path
                  d="M0 0 q8 -5 16 0 t16 0 t16 0 t16 0 t16 0 t16 0 t16 0 t16 0 V64 H0 Z"
                  fill="#1D1D1F"
                />
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  from="0 0"
                  to="-32 0"
                  dur="1.8s"
                  repeatCount="indefinite"
                />
              </g>
            </g>
          </svg>
          {receiveProgress > 0 ? (
            <span
              className="relative z-10 text-sm font-semibold tabular-nums"
              style={{ color: receiveProgress >= 50 ? '#FFFFFF' : '#1D1D1F' }}
            >
              {Math.round(receiveProgress)}%
            </span>
          ) : (
            <Download className="relative z-10 w-6 h-6 sm:w-7 sm:h-7 text-[#1D1D1F]" />
          )}
        </button>
      )}
    </>
  );
}

function PillButton({
  current,
  value,
  label,
  onClick
}: {
  current: MainTab;
  value: MainTab;
  label: string;
  onClick: (tab: MainTab) => void;
}) {
  const active = current === value;
  return <Pill active={active} label={label} onClick={() => onClick(value)} />;
}

function PillModalButton({
  open,
  label,
  onClick
}: {
  open: boolean;
  label: string;
  onClick: () => void;
}) {
  return <Pill active={open} label={label} onClick={onClick} />;
}

function Pill({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  const classes = active
    ? 'px-3.5 py-1.5 text-sm font-medium rounded-full transition-colors cursor-pointer bg-[#1D1D1F] text-white'
    : 'px-3.5 py-1.5 text-sm font-medium rounded-full transition-colors cursor-pointer bg-[#E5E5EA] text-[#1D1D1F] hover:bg-[#D1D1D6]';
  return (
    <button type="button" onClick={onClick} className={classes}>
      {label}
    </button>
  );
}
