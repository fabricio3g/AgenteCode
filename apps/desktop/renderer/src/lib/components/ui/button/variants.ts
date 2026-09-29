import { type VariantProps, cva } from 'class-variance-authority';

export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full text-[13px] font-medium outline-none transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-fg hover:bg-primary-hover',
        destructive:
          'bg-error text-primary-fg hover:opacity-90 focus-visible:ring-error/20',
        outline:
          'border border-border bg-bg shadow-xs hover:bg-surface-hover hover:text-fg dark:bg-surface/30 dark:hover:bg-surface/50',
        secondary: 'bg-surface-hover text-fg hover:bg-surface-active',
        ghost: 'hover:bg-surface-hover hover:text-fg border-transparent shadow-none',
        link: 'text-fg underline-offset-4 hover:underline border-transparent shadow-none'
      },
      size: {
        default: 'h-8 px-3.5 py-1.5',
        xs: 'h-6 gap-1 px-2 text-xs [&_svg]:size-3',
        sm: 'h-7 gap-1.5 px-2.5 [&_svg]:size-3.5',
        lg: 'h-9 px-5',
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
