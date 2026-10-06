import { type VariantProps, cva } from 'class-variance-authority';

/**
 * The app's one button. A rounded rectangle (`--radius-sm`) with body-size
 * text; the outline variant carries a visible hairline on the card fill.
 * Icon-only buttons use the same radius at a square size. Everything that
 * looks like a button should be this component, not a styled <button>.
 */
export const buttonVariants = cva(
  'ui-button inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[var(--radius-sm)] font-medium text-[length:var(--text-sm)] leading-none outline-none transition-[background-color,border-color,color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-accent)] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-3.5 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'ui-button-solid border border-transparent bg-primary text-primary-fg hover:bg-primary-hover',
        destructive: 'ui-button-solid border border-transparent bg-error text-primary-fg hover:opacity-90',
        outline: 'ui-button-outline border border-[var(--border-hover)] bg-[var(--card)] text-foreground hover:bg-[var(--float-row-hover)]',
        secondary: 'ui-button-secondary border border-transparent bg-[var(--surface-hover)] text-foreground hover:bg-[var(--surface-active)]',
        ghost: 'ui-button-ghost border border-transparent text-foreground hover:bg-[var(--float-row-hover)]',
        link: 'border border-transparent text-foreground underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-8 px-3.5',
        xs: 'h-6 gap-1 px-2 text-[length:var(--text-xs)] [&_svg]:size-3',
        sm: 'h-7 px-3',
        lg: 'h-9 px-4',
        icon: 'size-8',
        'icon-sm': 'size-7',
        'icon-lg': 'size-9'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
);

export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
export type ButtonSize = VariantProps<typeof buttonVariants>['size'];
