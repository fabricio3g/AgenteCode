module.exports = {
  content: ['./index.html', './src/**/*.{svelte,js,ts}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
        serif: ['var(--font-serif)'],
        mono: ['var(--font-mono)']
      },
      colors: {
        bg: 'var(--background)',
        fg: 'var(--text)',
        card: 'var(--surface)',
        surface: 'var(--surface)',
        'surface-hover': 'var(--surface-hover)',
        'surface-active': 'var(--surface-active)',
        'surface-overlay': 'var(--surface-overlay)',
        muted: 'var(--text-muted)',
        'fg-secondary': 'var(--text-secondary)',
        'fg-tertiary': 'var(--text-tertiary)',
        'fg-muted': 'var(--text-muted)',
        primary: 'var(--primary)',
        'primary-hover': 'var(--primary-hover)',
        'primary-fg': 'var(--primary-fg)',
        accent: 'var(--accent)',
        'accent-hover': 'var(--accent-hover)',
        'accent-fg': 'var(--accent-fg)',
        'accent-soft': 'var(--accent-soft)',
        success: 'var(--success)',
        'success-bg': 'var(--success-bg)',
        'success-border': 'var(--success-border)',
        warning: 'var(--warning)',
        'warning-bg': 'var(--warning-bg)',
        'warning-border': 'var(--warning-border)',
        error: 'var(--error)',
        'error-bg': 'var(--error-bg)',
        'error-border': 'var(--error-border)',
        info: 'var(--info)',
        'info-bg': 'var(--info-bg)',
        'info-border': 'var(--info-border)',
        border: 'var(--border)',
        'border-hover': 'var(--border-hover)',
        'border-active': 'var(--border-active)',
        overlay: 'var(--overlay)',
        'code-terminal-bg': 'var(--code-terminal-bg)',
        'code-terminal-text': 'var(--code-terminal-text)',
        'code-terminal-prompt': 'var(--code-terminal-prompt)',
        'code-terminal-dim': 'var(--code-terminal-dim)',
        'code-terminal-error': 'var(--code-terminal-error)',
        'code-terminal-warn': 'var(--code-terminal-warn)',
        'accent-red': {
          bg: 'var(--accent-red-bg)',
          text: 'var(--accent-red-text)'
        },
        'accent-blue': {
          bg: 'var(--accent-blue-bg)',
          text: 'var(--accent-blue-text)'
        },
        'accent-green': {
          bg: 'var(--accent-green-bg)',
          text: 'var(--accent-green-text)'
        },
        'accent-yellow': {
          bg: 'var(--accent-yellow-bg)',
          text: 'var(--accent-yellow-text)'
        },
        hornero: {
          50: '#fdf6f0',
          100: '#fae8d8',
          200: '#f2d0b3',
          300: '#e8b88c',
          400: '#d4a574',
          500: '#c4956a',
          600: '#b5845a',
          700: '#8b6a4e',
          800: '#5c4033',
          900: '#3d2b1f'
        }
      },
      borderColor: {
        DEFAULT: 'var(--border)'
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)'
      },
      borderRadius: {
        DEFAULT: 'var(--radius-sm)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)'
      },
      letterSpacing: {
        tighter: '-0.02em',
        tight: '-0.01em'
      },
      lineHeight: {
        tight: '1.2',
        snug: '1.4',
        relaxed: '1.6'
      }
    }
  },
  plugins: []
};
