import { cva } from 'class-variance-authority';

/** One face for text, multiline and native selection controls. */
// Focus is quiet: a field firms its edge or takes the hover tint, never a
// coloured ring. The caret already says where typing goes.
export const fieldVariants = cva(
  'ui-field w-full min-w-0 rounded-[var(--radius-sm)] text-[length:var(--text-sm)] text-foreground outline-none placeholder:text-muted-foreground transition-[background-color,border-color,box-shadow] duration-[var(--motion-instant)] ease-[var(--motion-ease)] disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'border border-[var(--float-border)] bg-background shadow-[inset_0_1px_2px_rgb(0_0_0_/_0.14)] focus-visible:border-[var(--border-hover)]',
        surface: 'border-0 bg-[var(--card)] hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--surface-hover)]',
        composer: 'ui-field-composer border-0 bg-transparent',
        inline: 'border-0 bg-transparent focus-visible:bg-[var(--surface-hover)]',
      },
      multiline: { true: 'min-h-20 px-2.5 py-2 leading-relaxed', false: 'h-8 px-2.5' },
    },
    compoundVariants: [{ variant: 'composer', multiline: true, class: 'min-h-0 resize-none px-0 py-0' }],
    defaultVariants: { variant: 'default', multiline: false },
  },
);
export type FieldVariant = 'default' | 'surface' | 'inline' | 'composer';
