import { NetworkPeer } from '../types/transfer';
import { CheckCircle2, Monitor, RefreshCw, Router, Smartphone, Tablet, X } from 'lucide-react';

interface LanPeerPickerModalProps {
  open: boolean;
  peers: NetworkPeer[];
  scanning: boolean;
  connected: boolean;
  subnet: string;
  selectedPeerId: string | null;
  onClose: () => void;
  onSelect: (peer: NetworkPeer) => void;
  onRescan: () => void;
}

function PeerIcon({ type }: { type: NetworkPeer['deviceType'] }) {
  const common = 'w-5 h-5';
  if (type === 'mobile') return <Smartphone className={common} />;
  if (type === 'tablet') return <Tablet className={common} />;
  return <Monitor className={common} />;
}

/**
 * 局域网设备选择模态框。
 * 列出同网段已发现的设备，允许触发重新扫描，选定后关闭。
 */
export default function LanPeerPickerModal({
  open,
  peers,
  scanning,
  connected,
  subnet,
  selectedPeerId,
  onClose,
  onSelect,
  onRescan,
}: LanPeerPickerModalProps) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[80vh] flex flex-col bg-white rounded-md sm:rounded-2xl shadow-2xl border border-[#E5E5EA]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 sm:gap-4 px-3 sm:px-5 py-3 sm:py-4 border-b border-[#E5E5EA] shrink-0">
          <div>
            <h3 className="text-base font-semibold text-[#1D1D1F]">选择设备</h3>
            <p className="text-sm text-[#6E6E73] mt-0.5 flex items-center gap-1">
              <Router className="w-3 h-3" />
              {connected ? '在线' : '连接中'}
              {subnet ? ` · ${subnet}` : ''}
            </p>
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

        {/* List */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 sm:px-5 py-3 sm:py-3 space-y-1">
          {peers.length === 0 && !scanning && (
            <div className="py-12 text-center text-xs text-[#6E6E73]">
              <div className="inline-flex items-center justify-center w-10 h-10 rounded-xl bg-[#F5F5F7] mb-3 text-[#86868B]">
                <Router className="w-5 h-5" />
              </div>
              <p className="font-medium text-[#1D1D1F]">没有发现设备</p>
              <p className="mt-1.5 text-sm">点重新扫描，或确认目标设备已打开 AirVault</p>
            </div>
          )}

          {scanning && peers.length === 0 && (
            <div className="py-12 text-center text-xs text-[#6E6E73]">
              <RefreshCw className="w-6 h-6 mx-auto animate-spin text-[#1D1D1F]" />
              <p className="mt-3">正在扫描...</p>
            </div>
          )}

          {peers.map((peer) => {
            const selected = peer.deviceId === selectedPeerId;
            return (
              <button
                key={peer.deviceId}
                type="button"
                onClick={() => onSelect(peer)}
                className={`w-full text-left flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2 sm:py-3 rounded-xl transition-colors cursor-pointer ${
                  selected ? 'bg-[#1D1D1F]/8 ring-1 ring-[#1D1D1F]/30' : 'hover:bg-[#F5F5F7]'
                }`}
              >
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                    selected ? 'bg-[#1D1D1F] text-white' : 'bg-[#F5F5F7] text-[#1D1D1F]'
                  }`}
                >
                  <PeerIcon type={peer.deviceType} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-[#1D1D1F] truncate">
                    {peer.deviceName}
                  </p>
                  <p className="text-sm text-[#6E6E73] font-mono tabular-nums mt-0.5">
                    {peer.ip}
                  </p>
                  {peer.displayCode && (
                    <p className="text-sm font-semibold text-[#F57224] font-mono tabular-nums mt-0.5">
                      设备码 {peer.displayCode}
                    </p>
                  )}
                </div>
                {selected && <CheckCircle2 className="w-4 h-4 text-[#1D1D1F] shrink-0" />}
              </button>
            );
          })}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 sm:gap-3 px-3 sm:px-5 py-3 sm:py-3 border-t border-[#E5E5EA] shrink-0 bg-[#FAFAFB] rounded-b-2xl">
          <span className="text-sm text-[#6E6E73]">
            发现 <span className="font-medium text-[#1D1D1F]">{peers.length}</span> 台设备
          </span>
          <button
            type="button"
            onClick={onRescan}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#1D1D1F] bg-[#1D1D1F]/8 hover:bg-[#1D1D1F]/14 disabled:opacity-60 rounded-md sm:rounded-lg transition-colors cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
            {scanning ? '扫描中' : '重新扫描'}
          </button>
        </div>
      </div>
    </div>
  );
}
