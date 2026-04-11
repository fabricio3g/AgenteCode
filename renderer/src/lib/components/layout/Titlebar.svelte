<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { appWindow } from '$lib/services/window';

  let isMaximized = $state(false);
  const platform = typeof window !== 'undefined' ? (window.electronAPI?.platform ?? 'linux') : 'linux';
  const isMac = platform === 'darwin';

  async function checkMaximized() {
    isMaximized = await appWindow.isMaximized();
  }

  onMount(() => {
    void checkMaximized();
  });
</script>

<div
  class="titlebar flex h-9 shrink-0 select-none items-center justify-between border-b border-[var(--border-light)]"
  style="-webkit-app-region: drag; background: var(--background);"
  ondblclick={() => { void appWindow.toggleMaximize().then(checkMaximized); }}
  role="banner"
>
  <!-- Centered logo — absolutely positioned so it doesn't disturb the flex layout -->
  <div class="pointer-events-none absolute inset-0 flex items-center justify-start gap-1.5" style="padding-left: {isMac ? '80px' : '12px'};" aria-hidden="true">
    <svg viewBox="0 0 24 24" width="17" height="17" xmlns="http://www.w3.org/2000/svg" style="color: var(--text-muted);">
      <g>
        <polygon fill="color-mix(in srgb, currentColor 6%, transparent)" stroke="none"
          points="12,5 19,8.5 19,15.5 12,19 5,15.5 5,8.5">
          <animate attributeName="points" dur="2.4s" repeatCount="indefinite"
            values="12,5 19,8.5 19,15.5 12,19 5,15.5 5,8.5;
                    12,6.5 18,10 16,16.5 8,17.5 4,12 7.5,7;
                    12,7 17,11.5 17,17.5 12,19.5 7,17.5 7,11.5;
                    12,5 19,8.5 19,15.5 12,19 5,15.5 5,8.5"/>
        </polygon>
        <polygon fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"
          stroke-dasharray="8 3" stroke-dashoffset="0"
          points="12,2 22,7 22,17 12,22 2,17 2,7">
          <animate attributeName="points" dur="2.4s" repeatCount="indefinite"
            values="12,2 22,7 22,17 12,22 2,17 2,7;
                    12,3 21,8.5 18,18 6,20.5 1,12 7,4;
                    12,4 20,10 20,19 12,22 4,19 4,10;
                    12,2 22,7 22,17 12,22 2,17 2,7"/>
          <animate attributeName="stroke-dashoffset" dur="1.2s" repeatCount="indefinite" from="0" to="22"/>
        </polygon>
        <circle cx="12" cy="12" r="1.2" fill="currentColor" opacity="0.7">
          <animate attributeName="r" dur="1.8s" repeatCount="indefinite" values="1.2;1.8;1.2"/>
          <animate attributeName="opacity" dur="1.8s" repeatCount="indefinite" values="0.7;1;0.7"/>
        </circle>
      </g>
    </svg>
    <span style="font-size: 12px; font-weight: 600; color: var(--text-muted); letter-spacing: -0.01em;">ContextLM</span>
  </div>

  {#if isMac}
    <div class="traffic-lights flex items-center gap-2 pl-3" style="-webkit-app-region: no-drag">
      <button class="dot dot-close" onclick={() => appWindow.close()} aria-label="Close" title="Close"></button>
      <button class="dot dot-minimize" onclick={() => appWindow.minimize()} aria-label="Minimize" title="Minimize"></button>
      <button class="dot dot-maximize" onclick={() => { void appWindow.toggleMaximize().then(checkMaximized); }} aria-label={isMaximized ? 'Restore' : 'Maximize'} title={isMaximized ? 'Restore' : 'Maximize'}></button>
    </div>
    <div class="flex-1"></div>
  {:else}
    <div class="flex-1"></div>
    <div class="flex items-center gap-1 pr-2" style="-webkit-app-region: no-drag">
      <button class="win-btn" onclick={() => appWindow.minimize()} aria-label="Minimize" title="Minimize">
        <span class="win-icon">&#x2013;</span>
      </button>
      <button class="win-btn" onclick={() => { void appWindow.toggleMaximize().then(checkMaximized); }} aria-label={isMaximized ? 'Restore' : 'Maximize'} title={isMaximized ? 'Restore' : 'Zoom'}>
        {#if isMaximized}
          <span class="win-icon win-icon-restore">&#x2752;</span>
        {:else}
          <span class="win-icon">&#x25A1;</span>
        {/if}
      </button>
      <button class="win-btn win-btn-close" onclick={() => appWindow.close()} aria-label="Close" title="Close">
        <span class="win-icon">&#x2715;</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .titlebar { position: relative; }

  .dot {
    width: 12px; height: 12px;
    border-radius: 50%;
    border: none;
    cursor: default;
    transition: filter 0.1s;
    flex-shrink: 0;
    position: relative;
  }
  .dot::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    opacity: 0;
    transition: opacity 0.1s;
    background-size: 8px 8px;
    background-repeat: no-repeat;
    background-position: center;
  }
  .traffic-lights:hover .dot::after { opacity: 1; }

  .dot-close   { background: #ff5f57; box-shadow: 0 0 0 0.5px rgba(0,0,0,.12); }
  .dot-minimize { background: #ffbd2e; box-shadow: 0 0 0 0.5px rgba(0,0,0,.12); }
  .dot-maximize { background: #28c840; box-shadow: 0 0 0 0.5px rgba(0,0,0,.12); }

  :global(.dark) .dot-close   { background: #ff5f57; box-shadow: 0 0 0 0.5px rgba(255,255,255,.15); }
  :global(.dark) .dot-minimize { background: #ffbd2e; box-shadow: 0 0 0 0.5px rgba(255,255,255,.15); }
  :global(.dark) .dot-maximize { background: #28c840; box-shadow: 0 0 0 0.5px rgba(255,255,255,.15); }

  .dot-close::after    { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 1.5l5 5M6.5 1.5l-5 5' stroke='%234d0000' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E"); }
  .dot-minimize::after { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 4h5' stroke='%23593000' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E"); }
  .dot-maximize::after { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 4.5l2.5-3 2.5 3M1.5 3.5l2.5 3 2.5-3' stroke='%230d3d00' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }

  :global(.dark) .dot-close::after    { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 1.5l5 5M6.5 1.5l-5 5' stroke='%23ffcccc' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E"); }
  :global(.dark) .dot-minimize::after { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 4h5' stroke='%23ffdd99' stroke-width='1.2' stroke-linecap='round'/%3E%3C/svg%3E"); }
  :global(.dark) .dot-maximize::after { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Cpath d='M1.5 4.5l2.5-3 2.5 3M1.5 3.5l2.5 3 2.5-3' stroke='%2399ff99' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"); }

  .win-btn {
    display: flex; align-items: center; justify-content: center;
    width: 30px; height: 24px;
    border: none; background: transparent; cursor: default;
    border-radius: 8px;
    transition: background 0.12s, color 0.12s;
    color: var(--text-muted);
  }
  .win-icon {
    font-size: 10px; line-height: 1;
    font-family: 'Segoe UI', system-ui, sans-serif;
    letter-spacing: 0;
  }
  .win-icon-restore { font-size: 9px; }

  .win-btn:hover { background: rgba(128,128,128,0.15); color: var(--text); }
  .win-btn-close:hover { background: var(--error) !important; color: white !important; }

  :global(.dark) .win-btn:hover { background: rgba(255,255,255,0.1); }
  :global(.dark) .win-btn-close:hover { background: var(--error) !important; }
</style>
