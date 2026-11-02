<svelte:options runes={true} />

<!--
  Minimize / maximize / close, drawn in the page on Windows and Linux.

  macOS keeps its real traffic lights (`titleBarStyle: 'hiddenInset'`): they sit
  outside the web contents, follow the system's own colours and are placed where
  every Mac user's hand already goes. Everywhere else the caption is ours, so it
  follows the theme, dims with the rest of the app under a dialog's backdrop and
  shares the title bar's spacing instead of arriving from the platform.

  The cost of drawing them: no Win11 snap-layout flyout on maximize and no
  system menu on right-click. Aero snap and double-click-to-maximize still work
  — Electron keeps the caption's double-click behaviour on the drag region.
-->

<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';

  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Copy, Minus, Square, X } from 'lucide-svelte';
  import { appWindow } from '$lib/services/window';

  const platform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined;
  const shown = platform !== 'darwin';

  let maximized = $state(false);

  async function sync() {
    maximized = await appWindow.isMaximized().catch(() => false);
  }

  // `resize` covers every way the window changes state — our buttons, a
  // double-click on the bar, a keyboard shortcut, Aero snap to an edge.
  onMount(() => {
    void sync();
    const onResize = () => void sync();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  });
</script>

{#if shown}
<div class="window-controls titlebar-no-drag" role="group" aria-label={$t('titlebar.window')}>
  <UiButton variant="plain" type="button" class="window-control" aria-label={$t('titlebar.minimize')} onclick={() => void appWindow.minimize()}>
    <Minus aria-hidden="true" />
  </UiButton>
  <UiButton variant="plain" type="button" class="window-control" aria-label={maximized ? $t('titlebar.restore') : $t('titlebar.maximize')} onclick={() => void appWindow.toggleMaximize().then(sync)}>
    {#if maximized}<Copy class="is-restore" aria-hidden="true" />{:else}<Square aria-hidden="true" />{/if}
  </UiButton>
  <UiButton variant="plain" type="button" class="window-control is-close" aria-label={$t('titlebar.close')} onclick={() => void appWindow.close()}>
    <X aria-hidden="true" />
  </UiButton>
</div>
{/if}

<style>
  .window-controls {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    margin-inline-start: 0.375rem;
  }

  /* The title bar's button: same square, same radius, same neutral hover. */
  .window-controls :global(.window-control) {
    display: inline-flex;
    inline-size: 1.75rem;
    block-size: 1.625rem;
    align-items: center;
    justify-content: center;
    border-radius: var(--float-row-radius);
    color: var(--muted-foreground);
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }

  /* The same 16px mark as every other lucide icon in the bar (globe,
     downloads, theme), so the caption reads as part of the tool row. */
  .window-controls :global(.window-control svg) {
    inline-size: 1rem;
    block-size: 1rem;
    stroke-width: 1.5;
  }

  /* Two offset squares, mirrored so the back one sits up and to the left. */
  .window-controls :global(.window-control svg.is-restore) {
    transform: scaleX(-1);
  }

  .window-controls :global(.window-control:hover) {
    background: var(--float-row-hover);
    color: var(--foreground);
  }

  /* Close is the one destructive mark in the chrome: a wash of the error
     hue, never the solid red slab the platform paints. */
  .window-controls :global(.window-control.is-close:hover) {
    background: color-mix(in srgb, var(--error) 14%, transparent);
    color: var(--error);
  }

  .window-controls :global(.window-control:focus-visible) {
    outline: 2px solid var(--brand-accent);
    outline-offset: -2px;
  }
</style>
