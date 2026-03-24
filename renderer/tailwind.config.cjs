module.exports = {
  content: ['./index.html', './src/**/*.{svelte,js,ts}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-sans)'],
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
        soft: '0 2px 10px rgba(0,0,0,0.06)',
        medium: '0 4px 20px rgba(0,0,0,0.08)',
        strong: '0 8px 30px rgba(0,0,0,0.12)'
      },
      borderRadius: {
        xl: '16px',
        '2xl': '20px',
        '3xl': '24px'
      }
    }
  },
  plugins: []
};
