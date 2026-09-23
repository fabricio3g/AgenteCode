<svelte:options runes={true} />

<!--
  "The model is writing" indicator.

  A feather traces a line of ink instead of three pulsing dots — it reads as
  writing rather than waiting, and it keeps the pending state quiet while the
  first tokens are on the way. Purely decorative: the live region label
  carries the meaning.
-->

<script lang="ts">
  import { Feather } from 'lucide-svelte';
</script>

<span class="writing-indicator" role="status" aria-label="Writing">
  <span class="ink" aria-hidden="true"></span>
  <span class="feather" aria-hidden="true"><Feather class="size-full" /></span>
</span>

<style>
  .writing-indicator {
    position: relative;
    display: inline-flex;
    align-items: center;
    width: 2.25rem;
    height: 1.125rem;
    color: var(--text-muted);
  }

  .ink {
    position: absolute;
    left: 0;
    bottom: 0.125rem;
    width: 100%;
    height: 1.5px;
    border-radius: var(--radius-full);
    background: currentColor;
    opacity: 0.35;
    transform-origin: left center;
    animation: ink-draw 1.4s var(--motion-ease) infinite;
  }

  .feather {
    position: absolute;
    top: 0;
    left: 0;
    display: inline-flex;
    width: 0.875rem;
    height: 0.875rem;
    animation: feather-write 1.4s var(--motion-ease) infinite;
  }

  @keyframes feather-write {
    0% { transform: translateX(0) rotate(-4deg); }
    45% { transform: translateX(1.375rem) rotate(7deg); }
    55% { transform: translateX(1.375rem) rotate(7deg); }
    100% { transform: translateX(0) rotate(-4deg); }
  }

  @keyframes ink-draw {
    0% { transform: scaleX(0); opacity: 0.15; }
    45% { transform: scaleX(1); opacity: 0.4; }
    55% { transform: scaleX(1); opacity: 0.4; }
    100% { transform: scaleX(0); opacity: 0.15; }
  }

  @media (prefers-reduced-motion: reduce) {
    .feather {
      animation: none;
    }

    .ink {
      animation: none;
      transform: scaleX(1);
    }
  }
</style>
