/** 笔记 · 黑白主题视觉令牌（Apple 规范，浅色 / 深色共用一套语义色） */
module.exports = {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        panel: 'rgb(var(--panel) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        subtle: 'rgb(var(--subtle) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          press: 'rgb(var(--accent-press) / <alpha-value>)'
        },
        accentink: 'rgb(var(--accent-ink) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        hairline: 'rgb(var(--line) / 0.08)'
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"Helvetica Neue"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'sans-serif'
        ],
        mono: ['"SF Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace']
      },
      borderRadius: {
        control: '10px',
        card: '18px',
        modal: '20px'
      },
      boxShadow: {
        soft: '0 1px 2px rgba(0, 0, 0, 0.04)',
        float: '0 12px 32px -16px rgba(0, 0, 0, 0.16), 0 1px 2px rgba(0, 0, 0, 0.04)',
        modal: '0 24px 80px -20px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.06)'
      },
      fontSize: {
        caption: ['11px', { lineHeight: '16px' }],
        meta: ['12px', { lineHeight: '18px' }],
        body: ['13px', { lineHeight: '20px' }],
        lead: ['15px', { lineHeight: '24px' }],
        title: ['17px', { lineHeight: '24px', letterSpacing: '-0.01em' }],
        display: ['26px', { lineHeight: '32px', letterSpacing: '-0.02em' }]
      },
      backdropBlur: {
        frost: '20px'
      }
    }
  },
  plugins: []
};
