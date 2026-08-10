<script lang="ts">
  import { cn } from '$lib/utils/cn';

  interface Props {
    size?: 'sm' | 'md' | 'lg' | 'xl';
    class?: string;
  }

  let { size = 'md', class: className = '' }: Props = $props();

  /*
   * Weight is size-dependent on purpose.
   *
   * The thick/thin contrast that makes the wordmark work at display sizes falls
   * apart small: a 200-weight "Chat" at 14px, over a textured background, has
   * strokes thinner than a hairline and stops being readable. Small sizes keep
   * the contrast but compress it into weights that survive — 800 against 400
   * rather than 900 against 200.
   */
  const flaxeoClass = $derived(
    cn(
      'relative z-10 tracking-tighter text-current',
      size === 'sm' && 'text-[15px] font-extrabold',
      size === 'md' && 'text-base font-extrabold',
      size === 'lg' && 'text-4xl font-black tracking-[-0.05em]',
      size === 'xl' && 'text-5xl font-black tracking-[-0.055em] md:text-6xl'
    )
  );

  const chatClass = $derived(
    cn(
      'relative z-10 tracking-wide',
      size === 'sm' && 'text-[15px] font-normal tracking-wide text-current/75',
      size === 'md' && 'text-base font-light tracking-wider text-current/80',
      size === 'lg' && 'text-4xl font-extralight tracking-[0.06em] text-current/85',
      size === 'xl' && 'text-5xl font-extralight tracking-[0.08em] text-current/85 md:text-6xl'
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
