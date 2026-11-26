export interface AppHeaderProps {
  mainTab: 'send' | 'lan';
  onSwitchTab: (tab: 'send' | 'lan') => void;
  onOpenReceive: () => void;
  displayCode: string;
}

/** 顶部粘性导航栏：硬件编码 + 右侧"取件码取件"主按钮 */
export default function AppHeader({ onOpenReceive, displayCode }: AppHeaderProps) {
  return (
    <header className="sticky top-0 z-30 bg-[#F5F5F7]/85 backdrop-blur-xl border-b border-[#E5E5EA]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-8">
        <div className="text-lg font-bold tracking-tight text-[#F57224] whitespace-nowrap shrink-0 font-mono tabular-nums">
          我的硬件编码：{displayCode}
        </div>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={onOpenReceive}
            className="px-4 py-2 text-xs font-medium text-white bg-[#1D1D1F] hover:bg-[#333336] rounded-full transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            取件码取件
          </button>
        </div>
      </div>
    </header>
  );
}
