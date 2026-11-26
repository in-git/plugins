import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Download, Lock } from 'lucide-react';
import { formatPickupCode } from '../lib/format';
import InfoTip from './InfoTip';

export type QrCodeMode = 'both' | 'phone' | 'code';

interface QrCodeCardProps {
  transferId: string;
  pickupCode: string;
  encrypted: boolean;
  kind: 'file' | 'text';
  title: string;
  onReset: () => void;
  /** 决定展示哪些区域：phone=仅二维码, code=仅取件码, both=两者 */
  displayMode?: QrCodeMode;
}

export function QrCodeCard({
  transferId,
  pickupCode,
  encrypted,
  kind,
  title,
  onReset,
  displayMode = 'both',
}: QrCodeCardProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);

  const shareUrl = `${window.location.origin}/?code=${encodeURIComponent(pickupCode)}`;

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(shareUrl, {
      width: 512,
      margin: 2,
      color: {
        dark: '#1D1D1F',
        light: '#FFFFFF',
      },
      errorCorrectionLevel: 'M',
    })
      .then((url) => {
        if (active) setQrDataUrl(url);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [shareUrl]);

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(pickupCode);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 1800);
    } catch {
      // ignore
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 1800);
    } catch {
      // ignore
    }
  };

  return (
    <div className="bg-white rounded-md sm:rounded-2xl border border-[#E5E5EA] p-3 sm:p-6">
      <div
        className={`items-center gap-2 sm:gap-8 ${
          displayMode === 'both' ? 'grid grid-cols-1 md:grid-cols-2' : 'flex flex-col items-center'
        }`}
      >
        {/* Pickup Code Zone */}
        {displayMode !== 'phone' && (
          <div className="flex flex-col justify-between w-full space-y-3 sm:space-y-5">
            <div>
              <span className="text-sm font-medium text-[#6E6E73]">6 位取件码</span>
              <div className="mt-1 sm:mt-2">
                <div className="font-mono tabular-nums text-[56px] sm:text-[68px] font-semibold tracking-[0.10em] text-[#1D1D1F] text-nowrap leading-none">
                  {formatPickupCode(pickupCode)}
                </div>
              </div>
            </div>

            {/* 桌面：border-t 分栏 — 复制链接 / 直接下载 / 加密提示 */}
            <div className="hidden sm:flex flex-wrap items-center gap-3 pt-4 border-t border-[#E5E5EA]">
              {displayMode === 'code' && (
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-white bg-[#1D1D1F] hover:bg-[#000000] rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedLink ? '链接已复制' : '复制链接'}
                </button>
              )}

              <button
                type="button"
                onClick={handleCopyCode}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-[#1D1D1F] bg-[#F5F5F7] hover:bg-[#E8E8ED] rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copiedCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedCode ? '已复制' : '复制码'}
              </button>

              {kind === 'file' && !encrypted && (
                <a
                  href={`/api/transfers/${encodeURIComponent(transferId)}/download`}
                  download
                  className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-[#1D1D1F] bg-[#F5F5F7] hover:bg-[#E8E8ED] rounded-xl transition-colors whitespace-nowrap shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  直接下载
                </a>
              )}

              {encrypted && (
                <span className="inline-flex items-center gap-1.5 text-xs text-[#6E6E73]">
                  <Lock className="w-3.5 h-3.5 text-[#1D1D1F]" />
                  已加密
                  <InfoTip>接收方需输入相同密码才能解密，请通过其他安全渠道单独告知。</InfoTip>
                </span>
              )}
            </div>
          </div>
        )}

        {/* 移动端：border-t 分栏 — 直接下载 / 加密提示 */}
        {displayMode !== 'phone' && (
          <div className="sm:hidden flex flex-wrap items-center gap-2 pt-3 border-t border-[#E5E5EA]">
            {displayMode === 'code' && (
              <button
                type="button"
                onClick={handleCopyLink}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-[#1D1D1F] hover:bg-[#000000] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedLink ? '已复制' : '复制链接'}
              </button>
            )}
            <button
              type="button"
              onClick={handleCopyCode}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-[#1D1D1F] bg-[#F5F5F7] hover:bg-[#E8E8ED] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copiedCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedCode ? '已复制' : '复制码'}
            </button>
            {kind === 'file' && !encrypted && (
              <a
                href={`/api/transfers/${encodeURIComponent(transferId)}/download`}
                download
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-[#1D1D1F] bg-[#F5F5F7] hover:bg-[#E8E8ED] rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                下载
              </a>
            )}
            {encrypted && (
              <span className="inline-flex items-center gap-1 text-sm text-[#6E6E73]">
                <Lock className="w-3 h-3 text-[#1D1D1F]" />
                已加密
                <InfoTip>接收方需输入相同密码才能解密，请通过其他安全渠道单独告知。</InfoTip>
              </span>
            )}
          </div>
        )}

        {/* QR Code Zone — 仅“上传给手机”模式展示 */}
        {displayMode === 'phone' && (
          <div className="flex flex-col items-center justify-center py-2 sm:py-4">
            <div className="bg-white p-2 rounded-md sm:rounded-2xl border border-[#E5E5EA]">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={`取件码 ${pickupCode} 二维码`}
                  className="w-[186px] h-[186px] block"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-[186px] h-[186px] bg-[#F5F5F7] rounded-md animate-pulse" />
              )}
            </div>
            <p className="text-sm text-[#6E6E73] mt-2 sm:mt-3 text-center">
              手机扫码立即打开取件页
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
