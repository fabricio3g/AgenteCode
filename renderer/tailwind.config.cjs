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
        // Canonical Flaxeo names
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)'
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)'
        },
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
          hover: 'var(--primary-hover)',
          fg: 'var(--primary-fg)'
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)'
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)'
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
          hover: 'var(--accent-hover)',
          fg: 'var(--accent-fg)',
          soft: 'var(--accent-soft)'
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)'
        },
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        sidebar: {
          DEFAULT: 'var(--sidebar)',
          foreground: 'var(--sidebar-foreground)',
          primary: 'var(--sidebar-primary)',
          'primary-foreground': 'var(--sidebar-primary-foreground)',
          accent: 'var(--sidebar-accent)',
          'accent-foreground': 'var(--sidebar-accent-foreground)',
          border: 'var(--sidebar-border)',
          ring: 'var(--sidebar-ring)'
        },

        // Legacy Chatea aliases
        bg: 'var(--background)',
        fg: 'var(--text)',
        surface: 'var(--surface)',
        'surface-hover': 'var(--surface-hover)',
        'surface-active': 'var(--surface-active)',
        'surface-overlay': 'var(--surface-overlay)',
        'fg-secondary': 'var(--text-secondary)',
        'fg-tertiary': 'var(--text-tertiary)',
        'fg-muted': 'var(--text-muted)',
        'border-hover': 'var(--border-hover)',
        'border-active': 'var(--border-active)',
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
        xl: 'var(--shadow-xl)',
        surface: 'var(--surface-shadow)',
        'surface-focus': 'var(--surface-shadow-focus)'
      },
      borderRadius: {
        DEFAULT: 'var(--radius-sm)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)'
      },
      transitionTimingFunction: {
        motion: 'var(--motion-ease)'
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
