/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{html,js,jsx}'],
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
      }
    }
  },
  plugins: []
};
