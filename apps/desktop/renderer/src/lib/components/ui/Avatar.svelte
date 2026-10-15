<svelte:options runes={true} />

<!--
  A person's or bot's face: their picture, or initials from their name.
  `size="fill"` takes the size and shape of the element around it (roleplay
  chips and cards style their own frame); the fixed sizes are round. A tint
  paints the initials with one of the theme's accent pairs, and `working`
  adds a quiet pulsing ring.
-->

<script lang="ts">
  import { cn } from '$lib/utils/cn';

  export type AvatarTint = 'green' | 'blue' | 'yellow' | 'red';

  let {
    name,
    image,
    initials,
    tint,
    size = 'md',
    working = false,
    decorative = true,
    class: className = ''
  }: {
    name: string;
    image?: string | null;
    /** Overrides the letters taken from the name. */
    initials?: string;
    tint?: AvatarTint | string;
    size?: 'fill' | 'sm' | 'md' | 'lg';
    working?: boolean;
    /** Hidden from screen readers when the name is shown next to it. */
    decorative?: boolean;
    class?: string;
  } = $props();

  const TINTS = ['green', 'blue', 'yellow', 'red'];
  const accent = $derived(tint && TINTS.includes(tint) ? tint : null);
  const letters = $derived(
    initials ||
      name
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, size === 'fill' ? 1 : 2)
        .map((word) => word[0]?.toUpperCase() ?? '')
        .join('') ||
      '?'
  );
</script>

<span
  class={cn('avatar', size, working && 'working', className)}
  style:background={accent ? `var(--accent-${accent}-bg)` : undefined}
  style:color={accent ? `var(--accent-${accent}-text)` : undefined}
  aria-hidden={decorative ? 'true' : undefined}
  role={decorative ? undefined : 'img'}
  aria-label={decorative ? undefined : name}
>
  {#if image}
    <img src={image} alt="" />
  {:else}
    {letters}
  {/if}
</span>

<style>
  .avatar {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: var(--radius-full);
    font-weight: 600;
    letter-spacing: 0.01em;
    line-height: 1;
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .fill {
    width: 100%;
    height: 100%;
    border-radius: inherit;
    font-size: inherit;
    font-weight: inherit;
  }
  .sm { width: 1.5rem; height: 1.5rem; font-size: 10px; }
  .md { width: 2rem; height: 2rem; font-size: 11.5px; }
  .lg { width: 2.5rem; height: 2.5rem; font-size: 13px; }
  .sm, .md, .lg { box-shadow: inset 0 0 0 1px var(--border-subtle); }
  .working {
    overflow: visible;
    box-shadow: 0 0 0 2px var(--background), 0 0 0 3.5px var(--warning, #d4a017);
    animation: ring 1.6s ease-in-out infinite;
  }
  @keyframes ring { 50% { box-shadow: 0 0 0 2px var(--background), 0 0 0 3.5px transparent; } }
  @media (prefers-reduced-motion: reduce) {
    .working { animation: none; }
  }
</style>
