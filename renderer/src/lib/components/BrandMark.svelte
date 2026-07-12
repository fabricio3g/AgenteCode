<script lang="ts">
  import { cn } from '$lib/utils/cn';

  interface Props {
    size?: 'sm' | 'md' | 'lg' | 'xl';
    /** Soft floating squares behind the mark (lg/xl empty states) */
    ambient?: boolean;
    class?: string;
  }

  let { size = 'md', ambient, class: className = '' }: Props = $props();

  const showAmbient = $derived(ambient ?? (size === 'lg' || size === 'xl'));

  /** Square field around the wordmark — positions % of ambient stage. */
  const squares = [
    { s: '0.55rem', x: '8%', y: '18%', d: '0s' },
    { s: '0.9rem', x: '88%', y: '12%', d: '0.5s' },
    { s: '0.45rem', x: '4%', y: '62%', d: '1.1s' },
    { s: '1.15rem', x: '92%', y: '58%', d: '0.25s' },
    { s: '0.7rem', x: '18%', y: '88%', d: '1.4s' },
    { s: '0.85rem', x: '78%', y: '86%', d: '0.85s' },
    { s: '0.4rem', x: '96%', y: '38%', d: '1.7s' },
    { s: '1rem', x: '2%', y: '38%', d: '0.35s' },
    { s: '0.5rem', x: '42%', y: '6%', d: '1s' },
    { s: '0.65rem', x: '58%', y: '94%', d: '1.55s' }
  ] as const;

  const flaxeoClass = $derived(
    cn(
      'brand-mark__word relative z-10 font-black tracking-tighter text-foreground',
      size === 'sm' && 'text-sm',
      size === 'md' && 'text-base',
      size === 'lg' && 'text-4xl tracking-[-0.05em]',
      size === 'xl' && 'text-5xl tracking-[-0.055em] md:text-6xl'
    )
  );

  const chatClass = $derived(
    cn(
      'brand-mark__word relative z-10 font-extralight tracking-wide text-foreground/85',
      size === 'sm' && 'text-sm tracking-wider',
      size === 'md' && 'text-base tracking-wider',
      size === 'lg' && 'text-4xl tracking-[0.06em]',
      size === 'xl' && 'text-5xl tracking-[0.08em] md:text-6xl'
    )
  );
</script>

<span
  class={cn(
    'brand-mark relative inline-flex select-none items-baseline justify-center gap-2 tracking-tight',
    showAmbient && 'brand-mark--ambient',
    className
  )}
  aria-label="Flaxeo Chat"
>
  {#if showAmbient}
    <span class="brand-mark__field pointer-events-none absolute inset-0 z-0 overflow-visible" aria-hidden="true">
      {#each squares as sq, i (i)}
        <span
          class="brand-mark__square absolute rounded-[3px] border-2 border-foreground/35 bg-foreground/10 dark:border-white/40 dark:bg-white/10"
          style="width: {sq.s}; height: {sq.s}; left: {sq.x}; top: {sq.y}; animation-delay: {sq.d};"
        ></span>
      {/each}
    </span>
  {/if}

  <!-- Flaxeo: hard / heavy -->
  <span class={flaxeoClass}>Flaxeo</span>
  <!-- Chat: slim / light (matches Flaxeo Image pairing) -->
  <span class={chatClass}>Chat</span>
</span>

<style>
  .brand-mark--ambient {
    padding: 2.75rem 3.5rem;
    isolation: isolate;
    min-width: 12rem;
  }

  .brand-mark__square {
    transform: translate(-50%, -50%);
    animation: brand-square-drift 4.8s ease-in-out infinite;
    will-change: transform, opacity;
    box-shadow: 0 0 0 1px rgb(0 0 0 / 0.04);
  }

  @keyframes brand-square-drift {
    0%,
    100% {
      transform: translate(-50%, -50%) scale(1) rotate(0deg);
      opacity: 0.75;
    }
    35% {
      transform: translate(-50%, calc(-50% - 10px)) scale(1.12) rotate(6deg);
      opacity: 1;
    }
    70% {
      transform: translate(calc(-50% + 6px), calc(-50% + 6px)) scale(0.92) rotate(-5deg);
      opacity: 0.65;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .brand-mark__square {
      animation: none;
      opacity: 0.85;
    }
  }
</style>
