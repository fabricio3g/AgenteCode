<svelte:options runes={true} />

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';
  import BrandMark from '$lib/components/BrandMark.svelte';

  const space = $derived(appStore.activeSpace);
  const isWork = $derived(space === 'work');
</script>

<div class="hero-empty relative flex h-full flex-col items-center justify-center overflow-hidden px-6 text-center">
  <!-- Compact, saturated glow with heavy blur + film grain -->
  <div class="hero-bg" aria-hidden="true">
    <div class="hero-blob"></div>
    <div class="hero-blob hero-blob-soft"></div>
    <div class="hero-grain"></div>
    <div class="hero-vignette"></div>
  </div>

  <div class="relative z-[1] flex flex-col items-center">
    <BrandMark size="xl" />
    <p class="hero-copy mt-6 max-w-sm text-sm text-muted-foreground">
      {#if isWork}
        Attach a folder when ready, then ask the agent to explore or produce work products from your files.
      {:else if appStore.composerModeControl === 'tabs'}
        Ask anything. Use <span class="font-medium text-foreground">Agent</span> for tools, or
        <span class="font-medium text-foreground">Search</span>,
        <span class="font-medium text-foreground">Deep</span>, or
        <span class="font-medium text-foreground">Max</span> for web research.
      {:else}
        Ask anything. Tools and live data (weather, currency, search) are used automatically when needed.
        Use <span class="font-medium text-foreground">Search</span>,
        <span class="font-medium text-foreground">Deep</span>, or
        <span class="font-medium text-foreground">Max</span> for web research.
      {/if}
    </p>
  </div>
</div>

<style>
  .hero-empty {
    min-height: 100%;
  }

  .hero-bg {
    pointer-events: none;
    position: absolute;
    inset: 0;
    z-index: 0;
    overflow: hidden;
  }

  /* Light mode: cool steel core + soft periwinkle wash (complements #fdfdfd chrome) */
  .hero-blob {
    position: absolute;
    left: 50%;
    top: 38%;
    width: min(24rem, 62vw);
    height: min(15rem, 38vw);
    transform: translate(-50%, -50%);
    border-radius: 50%;
    background: radial-gradient(
      circle at 50% 45%,
      rgba(122, 152, 208, 0.9) 0%,
      rgba(148, 172, 218, 0.62) 30%,
      rgba(178, 192, 228, 0.28) 56%,
      transparent 74%
    );
    filter: blur(52px);
    opacity: 0.95;
  }

  .hero-blob-soft {
    width: min(30rem, 72vw);
    height: min(19rem, 44vw);
    top: 42%;
    background: radial-gradient(
      circle at 48% 52%,
      rgba(108, 138, 198, 0.42) 0%,
      rgba(150, 165, 215, 0.24) 38%,
      rgba(188, 198, 228, 0.12) 58%,
      transparent 72%
    );
    filter: blur(76px);
    opacity: 0.82;
  }

  :global(.dark) .hero-blob {
    background: radial-gradient(
      circle at 50% 45%,
      rgba(56, 140, 210, 0.85) 0%,
      rgba(40, 100, 170, 0.55) 32%,
      rgba(30, 70, 120, 0.22) 58%,
      transparent 72%
    );
    filter: blur(52px);
    opacity: 0.8;
  }

  :global(.dark) .hero-blob-soft {
    background: radial-gradient(
      circle at 50% 50%,
      rgba(45, 120, 190, 0.45) 0%,
      rgba(30, 70, 120, 0.2) 45%,
      transparent 68%
    );
    filter: blur(80px);
    opacity: 0.65;
  }

  /* Film grain — softer multiply in light so blue wash stays clean on white */
  .hero-grain {
    position: absolute;
    inset: -5%;
    opacity: 0.55;
    mix-blend-mode: multiply;
    background-image:
      url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.15' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E"),
      url("data:image/svg+xml,%3Csvg viewBox='0 0 128 128' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n2'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n2)'/%3E%3C/svg%3E");
    background-size: 140px 140px, 90px 90px;
    background-position: 0 0, 40px 20px;
  }

  :global(.dark) .hero-grain {
    opacity: 0.4;
    mix-blend-mode: soft-light;
  }

  .hero-grain::after {
    content: '';
    position: absolute;
    inset: 0;
    opacity: 0.38;
    mix-blend-mode: soft-light;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.35' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23g)'/%3E%3C/svg%3E");
    background-size: 110px 110px;
  }

  .hero-vignette {
    position: absolute;
    inset: 0;
    background: radial-gradient(ellipse 58% 50% at 50% 40%, transparent 12%, var(--background) 74%);
    opacity: 0.82;
  }

  .hero-copy {
    text-shadow: 0 1px 0 color-mix(in srgb, var(--background) 40%, transparent);
  }
</style>
