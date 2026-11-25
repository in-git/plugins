/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./popup.html', './popup.js', './content.js'],
  theme: {
    extend: {
      colors: {
        canvas: '#f6f6f7',
        ink: '#1d1d1f',
        subtle: '#86868b',
        accent: '#007aff'
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"PingFang SC"',
          '"Microsoft YaHei UI"',
          'sans-serif'
        ]
      },
      borderRadius: {
        modal: '22px',
        card: '14px',
        control: '10px'
      }
    }
  },
  plugins: []
};
