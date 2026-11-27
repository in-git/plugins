import React, { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Icon } from './icons.jsx';

/** 把笔记正文渲染成二维码的弹窗 */
export default function QrDialog({ open, title, text, onClose }) {
  const canvasRef = useRef(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    setError(false);
    let cancelled = false;

    QRCode.toCanvas(canvasRef.current, text, {
      width: 280,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#111111', light: '#ffffff' }
    }).catch(() => {
      if (!cancelled) setError(true);
    });

    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelled = true;
      document.removeEventListener('keydown', onKey);
    };
  }, [open, text, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/20 p-6 backdrop-blur-[2px]"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nb-dialog w-full max-w-[360px] p-6" role="dialog" aria-modal="true">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-title font-semibold text-ink">二维码</h3>
          <button type="button" className="nb-icon-btn h-7 w-7" title="关闭" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
        <p className="mt-1 truncate text-meta text-subtle">「{title || '无标题文档'}」</p>

        <div className="mt-4 flex items-center justify-center rounded-[12px] bg-white p-3">
          {error ? (
            <span className="py-16 text-body text-muted">内容超出二维码容量</span>
          ) : (
            <canvas ref={canvasRef} />
          )}
        </div>

        <p className="mt-3 text-center text-meta text-muted">用手机扫描即可读取正文</p>
      </div>
    </div>
  );
}
