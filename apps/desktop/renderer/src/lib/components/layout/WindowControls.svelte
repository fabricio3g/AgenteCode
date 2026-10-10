<svelte:options runes={true} />

<!--
  Minimize / maximize / close, drawn in the page on Linux.

  Windows keeps the OS buttons (`titleBarOverlay`: snap layouts, system menu)
  and macOS its traffic lights. Linux's overlay did not repaint reliably when
  its colour changed, so the buttons kept the previous theme and stayed bright
  under a dialog's backdrop. In the page they follow the theme and dim with
  everything else.
-->

<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Copy, Minus, Square, X } from 'lucide-svelte';
  import { appWindow } from '$lib/services/window';

  type Overlay = EventTarget & { visible?: boolean };
  const overlay = typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { windowControlsOverlay?: Overlay }).windowControlsOverlay;

  let maximized = $state(false);
  // Only where the OS draws nothing: Linux, and only while no caption overlay
  // is present (a window created before the switch still has one).
  let osDrawsThem = $state(!!overlay?.visible);
  const shown = $derived(window.electronAPI?.platform === 'linux' && !osDrawsThem);

  async function sync() {
    maximized = await appWindow.isMaximized().catch(() => false);
  }

  onMount(() => {
    void sync();
    const onResize = () => void sync();
    const onGeometry = () => (osDrawsThem = !!overlay?.visible);
    window.addEventListener('resize', onResize);
    overlay?.addEventListener('geometrychange', onGeometry);
    return () => {
      window.removeEventListener('resize', onResize);
      overlay?.removeEventListener('geometrychange', onGeometry);
    };
  });
</script>

{#if shown}
<div class="window-controls titlebar-no-drag" role="group" aria-label={$t('titlebar.window')}>
  <UiButton variant="plain" type="button" class={uiClass("window-control", "ui-local-df895937")} aria-label={$t('titlebar.minimize')} onclick={() => void appWindow.minimize()}>
    <Minus aria-hidden="true" />
  </UiButton>
  <UiButton variant="plain" type="button" class={uiClass("window-control", "ui-local-df895937")} aria-label={maximized ? $t('titlebar.restore') : $t('titlebar.maximize')} onclick={() => void appWindow.toggleMaximize().then(sync)}>
    {#if maximized}<Copy class="is-restore" aria-hidden="true" />{:else}<Square class="is-max" aria-hidden="true" />{/if}
  </UiButton>
  <UiButton variant="plain" type="button" class={uiClass("window-control is-close", "ui-local-df895937")} aria-label={$t('titlebar.close')} onclick={() => void appWindow.close()}>
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
  :global(.window-control.ui-local-df895937) {
    display: inline-flex;
    inline-size: 1.75rem;
    block-size: 1.625rem;
    align-items: center;
    justify-content: center;
    border-radius: var(--float-row-radius);
    color: var(--muted-foreground);
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }

  :global(.window-control.ui-local-df895937) :global(svg) {
    inline-size: 0.875rem;
    block-size: 0.875rem;
    stroke-width: 1.75;
  }

  :global(.window-control.ui-local-df895937) :global(svg.is-max) {
    inline-size: 0.75rem;
    block-size: 0.75rem;
  }

  :global(.window-control.ui-local-df895937) :global(svg.is-restore) {
    inline-size: 0.75rem;
    block-size: 0.75rem;
    transform: scaleX(-1);
  }

  :global(.window-control:hover.ui-local-df895937) {
    background: var(--float-row-hover);
    color: var(--foreground);
  }

  :global(.window-control.is-close:hover.ui-local-df895937) {
    background: var(--error);
    color: #fff;
  }

  :global(.window-control:focus-visible.ui-local-df895937) {
    outline: 2px solid var(--brand-accent);
    outline-offset: -2px;
  }
</style>
