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
        panel: 'var(--surface-highlight)',
        'surface-secondary': 'var(--surface-secondary)',
        muted: 'var(--text-muted)',
        'fg-secondary': 'var(--text-secondary)',
        'fg-tertiary': 'var(--text-tertiary)',
        primary: 'var(--primary)',
        'primary-fg': 'var(--primary-fg)',
        accent: 'var(--primary)',
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
        'border-light': 'var(--border-light)',
        'border-strong': 'var(--border-strong)',
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
        soft: '0 2px 8px rgba(0,0,0,0.04)',
        medium: '0 4px 12px rgba(0,0,0,0.05)',
        strong: '0 8px 24px rgba(0,0,0,0.08)'
      },
      borderRadius: {
        DEFAULT: '6px',
        sm: '4px',
        md: '8px',
        lg: '10px',
        xl: '12px'
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
