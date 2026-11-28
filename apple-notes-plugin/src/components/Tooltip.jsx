import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

// 通用 tooltip：悬停 / 键盘聚焦时在目标上方浮出气泡，带延迟与淡入位移动画
export default function Tooltip({ content, side = 'top', delay = 120, children }) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const timer = useRef(null);
  const bubbleRef = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), delay);
  };

  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };

  // 气泡出现后量一次位置：贴到视口左右边缘时整体往回平移，保证不出屏
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const el = bubbleRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let delta = 0;
    if (rect.left < margin) delta = margin - rect.left;
    else if (rect.right > window.innerWidth - margin) delta = window.innerWidth - margin - rect.right;
    if (delta) setShift((s) => s + delta);
  }, [open]);

  const anchor = side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5';
  const translateY = open ? '0px' : '2px';

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {children}
      <span
        ref={bubbleRef}
        role="tooltip"
        aria-hidden={!open}
        className={`pointer-events-none absolute left-1/2 z-50 whitespace-nowrap rounded-[6px] px-2 py-1 text-[12px] leading-4 text-white shadow-[0_4px_14px_rgba(0,0,0,0.18)] transition-all duration-150 ease-out ${anchor}`}
        style={{
          background: 'rgba(32,32,34,0.94)',
          transform: `translateX(calc(-50% + ${shift}px)) translateY(${translateY})`,
          opacity: open ? 1 : 0
        }}
      >
        {content}
        {side === 'top' ? (
          <span
            className="absolute top-full h-1.5 w-1.5 -translate-y-[3px] rotate-45 rounded-[1px]"
            style={{
              background: 'rgba(32,32,34,0.94)',
              left: `calc(50% - ${shift}px)`,
              marginLeft: '-3px'
            }}
          />
        ) : null}
      </span>
    </span>
  );
}
