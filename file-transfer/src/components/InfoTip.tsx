import { Info } from 'lucide-react';

interface InfoTipProps {
  /** Tooltip body shown on hover / focus */
  children: React.ReactNode;
  /** Position relative to the icon */
  side?: 'top' | 'bottom';
  className?: string;
}

/**
 * Small info icon that reveals a tooltip on hover (desktop) or tap (mobile, via focus).
 * Pure CSS — no JS state, no extra deps.
 */
export default function InfoTip({ children, side = 'top', className = '' }: InfoTipProps) {
  const vertical = side === 'top' ? 'bottom-full mb-2' : 'top-full mt-2';
  return (
    <span className={`relative inline-flex group align-middle ${className}`}>
      <Info
        className="w-4 h-4 text-[#86868B] hover:text-[#1D1D1F] cursor-help transition-colors outline-none"
        tabIndex={0}
        role="button"
        aria-label="查看说明"
      />
      <span
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 -translate-x-1/2 ${vertical} w-60 sm:w-64 p-2.5 rounded-xl bg-[#1D1D1F] text-white text-xs leading-relaxed opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 transition-all duration-150 z-50 shadow-xl whitespace-normal`}
      >
        {children}
      </span>
    </span>
  );
}
