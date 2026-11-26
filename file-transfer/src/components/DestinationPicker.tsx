import { NetworkPeer } from '../types/transfer';
import { formatRelativeTime } from '../lib/format';
import { ChevronRight, Monitor, QrCode, Smartphone, Tablet, Wifi, X } from 'lucide-react';

export type DestinationMode = 'lan' | 'phone' | 'code';

interface DestinationPickerProps {
  mode: DestinationMode;
  onChange: (mode: DestinationMode) => void;
  selectedPeer: NetworkPeer | null;
  onClearPeer: () => void;
  onPickLanPeer: () => void;
}

const ORANGE = '#F57224';

function DeviceTypeIcon({ type }: { type: NetworkPeer['deviceType'] }) {
  if (type === 'mobile') return <Smartphone className="w-3.5 h-3.5" />;
  if (type === 'tablet') return <Tablet className="w-3.5 h-3.5" />;
  return <Monitor className="w-3.5 h-3.5" />;
}

function deviceTypeLabel(type: NetworkPeer['deviceType']): string {
  if (type === 'mobile') return '手机';
  if (type === 'tablet') return '平板';
  return '电脑';
}

export default function DestinationPicker({
  mode,
  onChange,
  selectedPeer,
  onClearPeer,
  onPickLanPeer,
}: DestinationPickerProps) {
  const lanActive = mode === 'lan';
  const phoneActive = mode === 'phone';
  const codeActive = mode === 'code';

  return (
    <div className="bg-white">
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-[#1D1D1F] tracking-wide mb-3 sm:mb-4">目的地</span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-3">
        {/* 1. LAN — ORANGE accent, mobile 独占整行 */}
        <button
          type="button"
          onClick={() => {
            onChange('lan');
            onPickLanPeer();
          }}
          className={`col-span-2 sm:col-span-1 relative text-left rounded-md sm:rounded-xl border border-[#E5E5EA] p-2 sm:p-4 transition-all cursor-pointer ${
            lanActive ? '' : 'hover:bg-[#FAFAFB]'
          }`}
          style={{
            borderColor: lanActive ? ORANGE : undefined,
            boxShadow: lanActive ? `0 0 0 2px ${ORANGE}22` : undefined,
            backgroundColor: lanActive ? '#FFF8F2' : undefined,
          }}
        >
          <div className="flex items-start gap-2 sm:gap-3">
            <div
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-md sm:rounded-xl flex items-center justify-center shrink-0"
              style={{ backgroundColor: lanActive ? ORANGE : '#FFF4EC' }}
            >
              <Wifi className="w-5 h-5" style={{ color: lanActive ? '#fff' : ORANGE }} />
            </div>
            <div className="min-w-0 flex-1">
              {selectedPeer ? (
                /* 已选定设备：名称为主 + 多维度识别信息 */
                <div className="flex items-start gap-1">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-[#1D1D1F] truncate">
                      {selectedPeer.deviceName}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[#6E6E73]">
                      <span className="inline-flex items-center gap-1" style={{ color: ORANGE }}>
                        <DeviceTypeIcon type={selectedPeer.deviceType} />
                        {deviceTypeLabel(selectedPeer.deviceType)}
                      </span>
                      <span className="font-mono tabular-nums">{selectedPeer.ip}</span>
                      {selectedPeer.sameIp && (
                        <span className="px-1.5 py-0.5 rounded bg-[#F57224]/10 font-medium" style={{ color: ORANGE }}>
                          本机
                        </span>
                      )}
                      <span className="font-mono tabular-nums">
                        延迟 {selectedPeer.rttMs} ms
                      </span>
                      <span>连接于 {formatRelativeTime(selectedPeer.connectedAt)}</span>
                    </div>
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => { e.stopPropagation(); onClearPeer(); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onClearPeer(); } }}
                      className="absolute top-2 right-2 sm:top-3 sm:right-3 p-1 text-[#86868B] hover:text-[#1D1D1F] hover:bg-[#F5F5F7] rounded-md cursor-pointer"
                      aria-label="取消选定"
                    >
                      <X className="w-3.5 h-3.5" />
                    </span>
                  </div>
                </div>
              ) : (
                <>
                  <span className="text-sm font-semibold text-[#1D1D1F]">局域网</span>
                  {lanActive && (
                    <p className="mt-2 text-sm leading-relaxed flex items-center gap-1" style={{ color: ORANGE }}>
                      点击选择设备
                      <ChevronRight className="w-3 h-3" />
                    </p>
                  )}
                </>
              )}
            </div>
            {!selectedPeer && <ChevronRight className="w-4 h-4 text-[#86868B] shrink-0 mt-1" />}
          </div>
        </button>

        {/* 2. 移动端=扫码二维码, 桌面=我的手机 */}
        <button
          type="button"
          onClick={() => onChange('phone')}
          className={`text-left rounded-md sm:rounded-xl border p-2 sm:p-4 transition-all cursor-pointer ${
            phoneActive ? '' : 'border-[#E5E5EA] bg-white hover:bg-[#FAFAFB]'
          }`}
          style={{
            borderColor: phoneActive ? '#1D1D1F' : undefined,
            boxShadow: phoneActive ? '0 0 0 2px rgba(29,29,31,.18)' : undefined,
            backgroundColor: phoneActive ? '#F5F5F7' : undefined,
          }}
        >
          {/* 移动端：二维码图标 + 扫码 */}
          <div className="sm:hidden flex items-start gap-2">
            <div
              className="w-9 h-9 rounded-md flex items-center justify-center shrink-0"
              style={{ backgroundColor: phoneActive ? '#1D1D1F' : '#F5F5F7' }}
            >
              <QrCode className="w-5 h-5" style={{ color: phoneActive ? '#fff' : '#1D1D1F' }} />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <span className="text-sm font-semibold text-[#1D1D1F]">扫码</span>
            </div>
          </div>
          {/* 桌面：手机图标 + 我的手机 */}
          <div className="hidden sm:flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ backgroundColor: phoneActive ? '#1D1D1F' : '#F5F5F7' }}
            >
              <Smartphone className="w-5 h-5" style={{ color: phoneActive ? '#fff' : '#1D1D1F' }} />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <span className="text-sm font-semibold text-[#1D1D1F]">我的手机</span>
            </div>
          </div>
        </button>

        {/* 3. 取件码 — blue, code only */}
        <button
          type="button"
          onClick={() => onChange('code')}
          className={`text-left rounded-md sm:rounded-xl border p-2 sm:p-4 transition-all cursor-pointer ${
            codeActive ? '' : 'border-[#E5E5EA] bg-white hover:bg-[#FAFAFB]'
          }`}
          style={{
            borderColor: codeActive ? '#1D1D1F' : undefined,
            boxShadow: codeActive ? '0 0 0 2px rgba(29,29,31,.18)' : undefined,
            backgroundColor: codeActive ? '#F5F5F7' : undefined,
          }}
        >
          <div className="flex items-start gap-2 sm:gap-3">
            <div
              className="w-9 h-9 sm:w-10 sm:h-10 rounded-md sm:rounded-xl flex items-center justify-center shrink-0"
              style={{ backgroundColor: codeActive ? '#1D1D1F' : '#F5F5F7' }}
            >
              <QrCode className="w-5 h-5" style={{ color: codeActive ? '#fff' : '#1D1D1F' }} />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <span className="text-sm font-semibold text-[#1D1D1F]">取件码</span>
           
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}
