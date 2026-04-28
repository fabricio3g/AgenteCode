<svelte:options runes={true} />

<script lang="ts">
  import { RefreshCw, TriangleAlert } from 'lucide-svelte';
  import WorkspaceModeSwitch from '$lib/components/layout/WorkspaceModeSwitch.svelte';
  import { themeStore } from '$lib/stores/theme.svelte';

  let iframe: HTMLIFrameElement | undefined;
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  const legacyUrl = '/legacy/index.html';

  function bridgeTauri(targetWindow: Window | null | undefined) {
    if (!targetWindow) return;

    try {
      const parentWindow = window as Window & {
        electronAPI?: unknown;
      };
      const childWindow = targetWindow as Window & {
        electronAPI?: unknown;
      };

      // Propagate Electron API to child iframe
      if (!childWindow.electronAPI && parentWindow.electronAPI) {
        childWindow.electronAPI = parentWindow.electronAPI;
      }

      const root = childWindow.document?.documentElement;
      if (root) {
        root.classList.toggle('dark', themeStore.current === 'dark');
      }
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Unable to initialize the legacy workspace';
    }
  }

  function handleLoad() {
    loading = false;
    loadError = null;
    bridgeTauri(iframe?.contentWindow);
  }

  function reload() {
    loading = true;
    loadError = null;
    if (iframe?.contentWindow) {
      iframe.contentWindow.location.reload();
      return;
    }
    if (iframe) {
      iframe.src = legacyUrl;
    }
  }

  $effect(() => {
    themeStore.current;
    bridgeTauri(iframe?.contentWindow);
  });
</script>

<div class="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--background)]">
 <div class="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
 <div class="min-w-0">
 <div class="text-sm font-semibold text-[var(--text)]">Full feature workspace</div>
 <div class="text-xs text-[var(--text-tertiary)]">
 Legacy UI runs inside the Svelte shell so every old tool stays available while the native port continues.
 </div>
 </div>

 <div class="flex items-center gap-2">
 <WorkspaceModeSwitch compact={true} />
 <button
 class="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text)]"
 onclick={reload}
 >
 <RefreshCw class="h-3.5 w-3.5" />
 Reload
 </button>
 </div>
 </div>

 {#if loadError}
  <div class="mx-4 mt-4 flex items-start gap-3 rounded-2xl border border-warning-border bg-warning-bg px-4 py-3 text-sm text-warning">
 <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0" />
 <div>{loadError}</div>
 </div>
 {/if}

 <div class="relative min-h-0 flex-1">
 <iframe
 bind:this={iframe}
 class="h-full w-full border-0 bg-[var(--background)]"
   title="Legacy workspace"
 src={legacyUrl}
 onload={handleLoad}
 ></iframe>

 {#if loading}
 <div class="absolute inset-0 flex items-center justify-center bg-[var(--surface)]/80">
 <div class="rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text-secondary)] shadow-sm">
 Loading full workspace…
 </div>
 </div>
 {/if}
 </div>
</div>
