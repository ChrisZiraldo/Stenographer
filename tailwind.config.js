/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/**/*.{html,js,jsx,ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas:    '#faf8f2',
        surface:   '#ffffff',
        surface2:  '#f7f4ed',
        surface3:  '#ede9df',
        border:    '#ddd9cf',
        ink:       '#1a1814',
        'ink-muted': '#5c5448',
        'ink-faint': '#9c9285',
        'ink-ghost': '#c4bdb5',
        oat:       '#5c6e00',
        'oat-hi':  '#6d8200',
        'oat-soft': '#eef1d6',
        terra:     '#b45837',
        'terra-hi': '#cc6640',
        'terra-soft': '#f5e0d4',
        mark:      '#f5e27e',
        ai:        '#7c5fc2',
        'ai-soft': '#ede8f8',
      },
      fontFamily: {
        sans: ['-apple-system', 'SF Pro Text', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '14px',
        sm: '10px',
        xs: '6px',
      },
    },
  },
  plugins: [],
};
