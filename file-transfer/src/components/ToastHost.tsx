import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Info } from 'lucide-react';
import type { ToastKind, ToastPayload } from '../lib/toast';

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

const TOAST_DURATION_MS = 3200;

export default function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    let seq = 0;
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<ToastPayload>).detail;
      if (!detail?.message) return;
      const id = (seq += 1);
      setItems((prev) => [...prev, { id, message: detail.message, kind: detail.kind ?? 'info' }]);
      window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== id));
      }, TOAST_DURATION_MS);
    };

    window.addEventListener('ft:toast', onToast);
    return () => window.removeEventListener('ft:toast', onToast);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="fixed inset-x-0 top-4 z-[60] flex flex-col items-center gap-2 px-4 pointer-events-none">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-2 max-w-sm w-full sm:w-auto px-4 py-2.5 rounded-xl bg-white border border-[#E5E5EA] shadow-lg"
        >
          {item.kind === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 text-[#1D1D1F]" />
          ) : item.kind === 'error' ? (
            <AlertCircle className="w-4 h-4 shrink-0 text-[#DC2626]" />
          ) : (
            <Info className="w-4 h-4 shrink-0 text-[#6E6E73]" />
          )}
          <span className="text-sm text-[#1D1D1F]">{item.message}</span>
        </div>
      ))}
    </div>
  );
}
