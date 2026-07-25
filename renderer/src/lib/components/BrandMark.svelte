<script lang="ts">
  import { cn } from '$lib/utils/cn';

  interface Props {
    size?: 'sm' | 'md' | 'lg' | 'xl';
    class?: string;
  }

  let { size = 'md', class: className = '' }: Props = $props();

  const flaxeoClass = $derived(
    cn(
      'relative z-10 font-black tracking-tighter text-current',
      size === 'sm' && 'text-sm',
      size === 'md' && 'text-base',
      size === 'lg' && 'text-4xl tracking-[-0.05em]',
      size === 'xl' && 'text-5xl tracking-[-0.055em] md:text-6xl'
    )
  );

  const chatClass = $derived(
    cn(
      'relative z-10 font-extralight tracking-wide text-current/85',
      size === 'sm' && 'text-sm tracking-wider',
      size === 'md' && 'text-base tracking-wider',
      size === 'lg' && 'text-4xl tracking-[0.06em]',
      size === 'xl' && 'text-5xl tracking-[0.08em] md:text-6xl'
    )
  );
</script>

<span
  class={cn(
    'brand-mark relative inline-flex select-none items-baseline justify-center gap-2 tracking-tight text-foreground',
    className
  )}
  aria-label="Flaxeo Chat"
>
  <!-- Flaxeo: hard / heavy -->
  <span class={`${flaxeoClass} brand-mark__flaxeo`}>Flaxeo</span>
  <!-- Chat: slim / light -->
  <span class={`${chatClass} brand-mark__chat`}>Chat</span>
</span>
