<svelte:options runes={true} />

<script lang="ts">
  import { cn } from '$lib/utils/cn';
  import { driverLogo, driverMark, resolveDriverIcon } from './driver-icon';

  let {
    instanceId = null,
    driverKind = null,
    name = null,
    size = 15,
    class: className = ''
  }: {
    instanceId?: string | null;
    driverKind?: string | null;
    /** The engine's display name: an unknown CLI's mark takes its initial. */
    name?: string | null;
    size?: number;
    class?: string;
  } = $props();

  const kind = $derived(resolveDriverIcon(instanceId, driverKind));
  const logo = $derived(driverLogo(kind));
  const mark = $derived(driverMark(kind, name ?? instanceId));
</script>

<span
  class={cn('driver-brand-icon', className)}
  style:width={`${size}px`}
  style:height={`${size}px`}
  data-driver-icon={kind}
  aria-hidden="true"
>
  {#if kind === 'agente'}
    <svg viewBox="0 0 24 24" fill="none">
      <g transform="rotate(-28 12 12)">
        <ellipse cx="12" cy="12" rx="8.8" ry="4.4" stroke="currentColor" stroke-width="2" />
      </g>
      <circle cx="12" cy="12" r="2.2" fill="currentColor" />
      <rect x="4" y="4" width="2" height="2" rx="0.5" fill="currentColor" opacity="0.7" />
      <rect x="18" y="4" width="2" height="2" rx="0.5" fill="currentColor" opacity="0.7" />
      <rect x="4" y="18" width="2" height="2" rx="0.5" fill="currentColor" opacity="0.7" />
      <rect x="18" y="18" width="2" height="2" rx="0.5" fill="currentColor" opacity="0.7" />
    </svg>
  {:else if logo}
    <span class="driver-logo" style:mask-image={`url('${logo}')`}></span>
  {:else}
    <span class="driver-mark" style:--mark-hue={mark.hue} style:font-size={`${Math.max(7, Math.round(size * 0.6))}px`}>{mark.letter}</span>
  {/if}
</span>

<style>
  .driver-brand-icon {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
  }
  .driver-brand-icon :global(svg) {
    display: block;
    width: 100%;
    height: 100%;
  }
  /* A CLI's own mark, monochrome in the text colour around it. */
  .driver-logo {
    width: 100%;
    height: 100%;
    background: currentColor;
    mask-size: contain;
    mask-repeat: no-repeat;
    mask-position: center;
  }
  /* An external CLI with no shipped logo: its initial on a soft tile in its own hue, not a copy of
     its product's logo. Readable on both themes. */
  .driver-mark {
    display: inline-flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    border-radius: 28%;
    background: oklch(0.65 0.12 var(--mark-hue) / 0.2);
    color: oklch(0.45 0.13 var(--mark-hue));
    font-weight: 700;
    line-height: 1;
  }
  :global(.dark) .driver-mark {
    background: oklch(0.65 0.12 var(--mark-hue) / 0.24);
    color: oklch(0.82 0.11 var(--mark-hue));
  }
</style>
