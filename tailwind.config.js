/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        base:           '#F4F6FB',
        surface:        '#FFFFFF',
        card:           '#FFFFFF',
        hover:          '#F1F5FF',
        border:         '#E2E8F0',
        'border-focus': '#A5B4FC',
        primary:        '#5E54E8',
        'primary-dim':  '#EEF0FF',
        'primary-glow': 'rgba(94,84,232,0.07)',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      animation: {
        'blink':           'blink 1s step-end infinite',
        'slide-in':        'slideIn 0.2s ease-out',
        'fade-in':         'fadeIn 0.18s ease-out',
        'slide-in-right':  'slideInRight 0.28s cubic-bezier(0.16,1,0.3,1)',
      },
      keyframes: {
        blink:         { '0%,100%': { opacity: '1' }, '50%': { opacity: '0' } },
        slideIn:       { from: { opacity: '0', transform: 'translateY(12px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        fadeIn:        { from: { opacity: '0', transform: 'translateY(6px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        slideInRight:  { from: { transform: 'translateX(100%)' }, to: { transform: 'translateX(0)' } },
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        'card-hover': '0 4px 16px rgba(0,0,0,0.08), 0 2px 4px rgba(0,0,0,0.05)',
      },
    },
  },
  plugins: [],
}
