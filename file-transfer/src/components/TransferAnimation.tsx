interface TransferAnimationProps {
  /** 文件名（可选，展示在动画下方） */
  fileName?: string;
  /** 目标设备名 */
  targetName?: string;
  /** 顶部标签，传 null 时隐藏 */
  badge?: string | null;
  /** 主标题，默认「正在传输至 xxx」 */
  title?: string;
}

/**
 * 局域网直传的简洁动画：文件从左侧电脑飞向右侧手机。
 * 纯 SVG + SMIL 动画，无额外依赖。
 */
export default function TransferAnimation({
  fileName,
  targetName,
  badge = '局域网直传',
  title,
}: TransferAnimationProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-4 sm:py-8">
      {/* 顶部标签 */}
      {badge && (
        <span className="inline-flex items-center rounded-full bg-[#FFF4EC] px-3 py-1 text-sm font-medium text-[#F57224]">
          {badge}
        </span>
      )}

      <svg
        viewBox="0 0 240 120"
        className="w-[260px] h-[130px]"
        role="img"
        aria-label="电脑与手机之间的文件双向传输"
      >
        {/* 左：电脑 */}
        <g
          fill="none"
          stroke="#1D1D1F"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="8" y="30" width="60" height="42" rx="7" fill="#F5F5F7" />
          <path d="M0 80h76" />
          <path d="M34 80v-8" />
        </g>

        {/* 右：手机 */}
        <g
          fill="none"
          stroke="#F57224"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="174" y="24" width="46" height="68" rx="9" fill="#FFF8F2" />
          <path d="M191 82h12" />
        </g>

        {/* 上：向右传输 */}
        <path
          d="M88 50 H156"
          fill="none"
          stroke="#1D1D1F"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="12 9"
        >
          <animate
            attributeName="stroke-dashoffset"
            from="0"
            to="-42"
            dur="1.1s"
            repeatCount="indefinite"
          />
        </path>
        <path
          d="M150 43 l8 7 -8 7"
          fill="none"
          stroke="#1D1D1F"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* 下：向左传输 */}
        <path
          d="M152 70 H84"
          fill="none"
          stroke="#F57224"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray="12 9"
        >
          <animate
            attributeName="stroke-dashoffset"
            from="0"
            to="42"
            dur="1.1s"
            repeatCount="indefinite"
          />
        </path>
        <path
          d="M90 63 l-8 7 8 7"
          fill="none"
          stroke="#F57224"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      <div className="text-center space-y-1">
        <p className="text-sm font-medium text-[#1D1D1F] animate-pulse">
          {title ?? `正在传输至 ${targetName || '目标设备'}`}
        </p>
        {fileName && (
          <p className="text-sm text-[#6E6E73] max-w-[280px] truncate">{fileName}</p>
        )}
      </div>
    </div>
  );
}
