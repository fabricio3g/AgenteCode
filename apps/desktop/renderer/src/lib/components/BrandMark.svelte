<script lang="ts">
  import { cn } from '$lib/utils/cn';

  interface Props {
    size?: 'sm' | 'md' | 'lg' | 'xl';
    class?: string;
  }

  let { size = 'md', class: className = '' }: Props = $props();

  const wordClass = $derived(
    cn(
      'relative z-10 tracking-tighter text-current',
      size === 'sm' && 'text-[15px] font-extrabold',
      size === 'md' && 'text-base font-extrabold',
      size === 'lg' && 'text-4xl font-black tracking-[-0.05em]',
      size === 'xl' && 'text-5xl font-black tracking-[-0.055em] md:text-6xl'
    )
  );
</script>

<span
  class={cn(
    'brand-mark relative inline-flex select-none items-baseline justify-center gap-2 tracking-tight text-foreground',
    className
  )}
  aria-label="Agente"
>
  <span class={`${wordClass} brand-mark__word`}>Agente</span>
</span>
