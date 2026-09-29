<svelte:options runes={true} />

<!--
  A bot's face: its initials on its tint, with a quiet ring while it works.
-->

<script lang="ts">
  import type { Bot } from './bots-ipc';

  let { bot, size = 'md' }: { bot: Pick<Bot, 'title' | 'avatar' | 'working'>; size?: 'sm' | 'md' | 'lg' } = $props();

  const TINTS = ['green', 'blue', 'yellow', 'red'];
  const tint = $derived(TINTS.includes(bot.avatar?.tint) ? bot.avatar.tint : 'blue');
  const initials = $derived(
    bot.avatar?.initials ||
      bot.title
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((word) => word[0]?.toUpperCase() ?? '')
        .join('')
  );
</script>

<span
  class="avatar {size}"
  class:working={bot.working}
  style:background={`var(--accent-${tint}-bg)`}
  style:color={`var(--accent-${tint}-text)`}
  aria-hidden="true"
>
  {initials}
</span>

<style>
  .avatar {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    font-weight: 600;
    letter-spacing: 0.01em;
    box-shadow: inset 0 0 0 1px var(--border-subtle);
  }
  .sm { width: 1.5rem; height: 1.5rem; font-size: 10px; }
  .md { width: 2rem; height: 2rem; font-size: 11.5px; }
  .lg { width: 2.5rem; height: 2.5rem; font-size: 13px; }
  .working {
    box-shadow: 0 0 0 2px var(--background), 0 0 0 3.5px var(--warning, #d4a017);
    animation: ring 1.6s ease-in-out infinite;
  }
  @keyframes ring { 50% { box-shadow: 0 0 0 2px var(--background), 0 0 0 3.5px transparent; } }
  @media (prefers-reduced-motion: reduce) {
    .working { animation: none; }
  }
</style>
