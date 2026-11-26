import { useState } from 'react';
import {
  Check,
  Edit3,
  Laptop,
  RefreshCw,
  Send,
  Smartphone,
  Tablet,
  Wifi,
} from 'lucide-react';
import { DeviceType, NetworkPeer } from '../types/transfer';

interface DeviceRadarProps {
  deviceName: string;
  deviceType: DeviceType;
  yourIp: string;
  subnet: string;
  peers: NetworkPeer[];
  connected: boolean;
  scanning: boolean;
  lastScannedAt: number | null;
  selectedTargetId: string | null;
  onSelectTarget: (peer: NetworkPeer | null) => void;
  onTriggerScan: () => void;
  onUpdateDeviceName: (name: string) => void;
}

function DeviceIcon({ type, className = 'w-4 h-4' }: { type: DeviceType; className?: string }) {
  if (type === 'mobile') return <Smartphone className={className} />;
  if (type === 'tablet') return <Tablet className={className} />;
  return <Laptop className={className} />;
}

export function DeviceRadar({
  deviceName,
  deviceType,
  yourIp,
  subnet,
  peers,
  connected,
  scanning,
  lastScannedAt,
  selectedTargetId,
  onSelectTarget,
  onTriggerScan,
  onUpdateDeviceName,
}: DeviceRadarProps) {
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState(deviceName);

  const scanned = lastScannedAt != null;

  const handleSaveName = () => {
    onUpdateDeviceName(draftName);
    setEditingName(false);
  };

  return (
    <aside className="bg-white rounded-md sm:rounded-2xl border border-[#E5E5EA] flex flex-col min-h-[420px]">
      {!scanned ? (
        /* Initial: one big Scan button, centered */
        <div className="flex-1 flex flex-col items-center justify-center gap-2 sm:gap-6 p-4 sm:p-10">
          <div className="w-16 h-16 rounded-md sm:rounded-2xl bg-[#F5F5F7] flex items-center justify-center">
            <Wifi className="w-8 h-8 text-[#1D1D1F]" />
          </div>
          <div className="text-center space-y-1.5">
            <h2 className="text-base font-semibold text-[#1D1D1F]">开始局域网扫描</h2>
            <p className="text-sm text-[#6E6E73] max-w-xs">
              点击下方按钮，发现同一网络内其他打开 AirVault 的设备。
            </p>
          </div>
          <button
            type="button"
            onClick={onTriggerScan}
            disabled={scanning}
            className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium text-white bg-[#1D1D1F] hover:bg-[#000000] active:bg-[#000000] disabled:opacity-60 rounded-xl transition-colors cursor-pointer shadow-sm"
          >
            <RefreshCw className={`w-4 h-4 ${scanning ? 'animate-spin' : ''}`} />
            {scanning ? '扫描中...' : '扫描设备'}
          </button>
        </div>
      ) : (
        /* After scan: self info + peer list */
        <>
          {/* Local Device Identity */}
          <div className="p-3 sm:p-6 border-b border-[#E5E5EA] space-y-2 sm:space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-[#6E6E73]">本机名称</span>
              {editingName ? (
                <div className="flex items-center gap-1.5">
                  <input
                    type="text"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveName();
                      if (e.key === 'Escape') setEditingName(false);
                    }}
                    maxLength={36}
                    autoFocus
                    className="px-2 py-1 text-xs border border-[#1D1D1F] rounded-md bg-white text-[#1D1D1F] focus:outline-none w-36"
                  />
                  <button
                    type="button"
                    onClick={handleSaveName}
                    className="p-1 text-[#1D1D1F] hover:bg-[#1D1D1F]/10 rounded cursor-pointer"
                    aria-label="保存设备名称"
                  >
                    <Check className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setDraftName(deviceName);
                    setEditingName(true);
                  }}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-[#1D1D1F] hover:text-[#1D1D1F] transition-colors cursor-pointer"
                >
                  <DeviceIcon type={deviceType} className="w-3.5 h-3.5 text-[#6E6E73]" />
                  <span className="truncate max-w-[150px]">{deviceName}</span>
                  <Edit3 className="w-3 h-3 text-[#86868B]" />
                </button>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-[#6E6E73]">当前网络 IP</span>
              <span className="font-mono tabular-nums text-[#1D1D1F] font-medium">{yourIp}</span>
            </div>

            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-[#6E6E73]">状态</span>
              <span className="text-[#1D1D1F]">
                {connected ? '在线' : '连接中'}
                {subnet ? ` · ${subnet}` : ''}
              </span>
            </div>
          </div>

          {/* Discovered Peers List */}
          <div className="p-3 sm:p-6 flex-1">
            <div className="flex items-center justify-between mb-2 sm:mb-3">
              <span className="text-xs font-medium text-[#6E6E73]">已发现 ({peers.length})</span>
              <button
                type="button"
                onClick={onTriggerScan}
                disabled={scanning}
                className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[#1D1D1F] bg-[#1D1D1F]/8 hover:bg-[#1D1D1F]/14 disabled:opacity-60 rounded-md transition-colors cursor-pointer"
              >
                <RefreshCw className={`w-3 h-3 ${scanning ? 'animate-spin' : ''}`} />
                {scanning ? '扫描中' : '重新扫描'}
              </button>
            </div>

            {peers.length === 0 ? (
              <div className="py-10 px-4 text-center rounded-xl bg-[#F5F5F7]">
                <Wifi className="w-7 h-7 text-[#86868B] mx-auto mb-3" />
                <p className="text-sm font-medium text-[#1D1D1F]">没有发现设备</p>
                <p className="text-xs text-[#6E6E73] mt-1.5 leading-relaxed">
                  另一台设备（或另一标签页）打开 AirVault，重新扫描即可。
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[#E5E5EA] border border-[#E5E5EA] rounded-xl overflow-hidden">
                {peers.map((peer) => {
                  const isSelected = selectedTargetId === peer.deviceId;
                  return (
                    <button
                      key={peer.deviceId}
                      type="button"
                      onClick={() => onSelectTarget(isSelected ? null : peer)}
                      className={`w-full text-left px-2 sm:px-4 py-2 sm:py-3.5 flex items-center justify-between gap-2 sm:gap-3 transition-colors cursor-pointer ${
                        isSelected ? 'bg-[#1D1D1F]/8' : 'bg-white hover:bg-[#F5F5F7]'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div
                          className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                            isSelected
                              ? 'bg-[#1D1D1F] text-white'
                              : 'bg-[#F5F5F7] text-[#1D1D1F]'
                          }`}
                        >
                          <DeviceIcon type={peer.deviceType} className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-[#1D1D1F] truncate">
                            {peer.deviceName}
                          </p>
                          <p className="text-xs text-[#6E6E73] font-mono tabular-nums truncate">
                            {peer.ip} · {peer.sameIp ? '同 IP' : '同网段'} · {peer.rttMs}ms
                          </p>
                        </div>
                      </div>

                      <span
                        className={`inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap shrink-0 ${
                          isSelected ? 'text-[#1D1D1F]' : 'text-[#6E6E73]'
                        }`}
                      >
                        {isSelected ? (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            已选定
                          </>
                        ) : (
                          <>
                            <Send className="w-3.5 h-3.5" />
                            直传
                          </>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
