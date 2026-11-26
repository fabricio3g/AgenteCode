<svelte:options runes={true} />

<script lang="ts">
  import { SquareTerminal } from '$lib/icons';
  import { cn } from '$lib/utils/cn';
  import { resolveDriverIcon } from './driver-icon';

  let {
    instanceId = null,
    driverKind = null,
    size = 15,
    class: className = ''
  }: {
    instanceId?: string | null;
    driverKind?: string | null;
    size?: number;
    class?: string;
  } = $props();

  const kind = $derived(resolveDriverIcon(instanceId, driverKind));
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
  {:else if kind === 'claude'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round">
      <line x1="12" y1="3" x2="12" y2="21" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" />
      <line x1="18.4" y1="5.6" x2="5.6" y2="18.4" />
    </svg>
  {:else if kind === 'codex'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="7.2" r="3.6" />
      <circle cx="16.15" cy="9.6" r="3.6" />
      <circle cx="16.15" cy="14.4" r="3.6" />
      <circle cx="12" cy="16.8" r="3.6" />
      <circle cx="7.85" cy="14.4" r="3.6" />
      <circle cx="7.85" cy="9.6" r="3.6" />
    </svg>
  {:else if kind === 'copilot'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M5 10.5C5 6.9 8.1 4.5 12 4.5s7 2.4 7 6v1.5" />
      <rect x="3" y="11" width="7.2" height="6" rx="2.6" />
      <rect x="13.8" y="11" width="7.2" height="6" rx="2.6" />
      <path d="M10.2 13.5h3.6" />
      <circle cx="6.6" cy="14" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="17.4" cy="14" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  {:else if kind === 'opencode'}
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path fill-rule="evenodd" d="M4 3h16v18H4V3Zm4 4v10h8V7H8Zm2 5h4v3h-4v-3Z" />
    </svg>
  {:else if kind === 'droid'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3v3" />
      <circle cx="12" cy="2.6" r="1" fill="currentColor" stroke="none" />
      <rect x="4" y="6.5" width="16" height="12.5" rx="4.2" />
      <rect x="7" y="10" width="10" height="5.5" rx="2.4" />
      <circle cx="9.6" cy="12.75" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.4" cy="12.75" r="1" fill="currentColor" stroke="none" />
    </svg>
  {:else if kind === 'pi'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4.5 7.5h15" />
      <path d="M9 7.5v10.5" />
      <path d="M15 7.5v8.2c0 1.4.8 2.3 2 2.3" />
    </svg>
  {:else if kind === 'qwen'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="12,3.2 19.6,7.6 19.6,16.4 12,20.8 4.4,16.4 4.4,7.6" />
      <circle cx="12" cy="12" r="3.4" />
      <path d="M14.5 14.5L18.5 18.5" />
    </svg>
  {:else if kind === 'gemini'}
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2C12.8 7.6 16.4 11.2 22 12C16.4 12.8 12.8 16.4 12 22C11.2 16.4 7.6 12.8 2 12C7.6 11.2 11.2 7.6 12 2Z" />
    </svg>
  {:else if kind === 'cursor'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
      <polygon points="12,3 20,7.5 20,16.5 12,21 4,16.5 4,7.5" />
      <polyline points="4.3,7.7 12,12 19.7,7.7" />
      <line x1="12" y1="12" x2="12" y2="21" />
    </svg>
  {:else if kind === 'goose'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8.5 19.5V11a4.5 4.5 0 0 1 9 0v1.2l3 .8-3 1.2v5.3" />
      <circle cx="14.5" cy="9.5" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  {:else if kind === 'cline'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
      <path d="M16.5 6.5a7 7 0 1 0 0 11" />
      <polyline points="12.5,9.5 15,12 12.5,14.5" />
    </svg>
  {:else if kind === 'kilo'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
      <line x1="6.5" y1="4.5" x2="6.5" y2="19.5" />
      <polyline points="17.5,4.5 9.5,12 17.5,19.5" />
    </svg>
  {:else if kind === 'kimi'}
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M13.5 3.5a8.5 8.5 0 1 0 6.8 13.6 6.8 6.8 0 0 1-6.8-13.6Z" />
      <circle cx="17.2" cy="7.2" r="1.7" />
    </svg>
  {:else if kind === 'auggie'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="12,3.5 19.5,19.5 4.5,19.5" />
      <line x1="8" y1="14.5" x2="16" y2="14.5" />
    </svg>
  {:else if kind === 'kiro'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 19V11a6 6 0 0 1 12 0v8l-3-2-3 2-3-2-3 2Z" />
      <circle cx="10" cy="11" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="14" cy="11" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  {:else if kind === 'vibe'}
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M4 6h3v3h3v3h4V9h3V6h3v12h-3.2v-5.2h-2.6V16h-4.4v-3.2H7.2V18H4V6Z" />
    </svg>
  {:else if kind === 'amp'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polygon points="13,2.5 5.5,13.5 12,13.5 11,21.5 18.5,10.5 12,10.5" />
    </svg>
  {:else if kind === 'grok'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
      <circle cx="12" cy="12" r="7.5" />
      <line x1="6.5" y1="17.5" x2="17.5" y2="6.5" />
    </svg>
  {:else if kind === 'junie'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round">
      <polygon points="12,3 17,12 12,21 7,12" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  {:else if kind === 'devin'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
      <circle cx="7" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="7.5" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="16.5" r="2.2" fill="currentColor" stroke="none" />
      <path d="M8.8 11l4.8-2.6M8.8 13l4.8 2.6" stroke-linecap="round" />
    </svg>
  {:else if kind === 'qoder'}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11.5" cy="11.5" r="7" />
      <line x1="16.5" y1="16.5" x2="20" y2="20" />
      <polyline points="9.5,9.5 8,11.5 9.5,13.5" />
      <polyline points="13.5,9.5 15,11.5 13.5,13.5" />
    </svg>
  {:else}
    <SquareTerminal {size} />
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
</style>
