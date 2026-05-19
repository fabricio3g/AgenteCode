<svelte:options runes={true} />

<script lang="ts">
  import { fade } from 'svelte/transition';
  import { flyAndScale } from '$lib/utils/transitions';
  import { X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import LocalRuntimePanel from './LocalRuntimePanel.svelte';

  function close() {
    appStore.runtimeManagerOpen = false;
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<div
  role="presentation"
  class="modal-backdrop fixed inset-0 z-[63] flex items-center justify-center overflow-hidden bg-overlay"
  transition:fade={{ duration: 200 }}
  onclick={(e) => { if (e.target === e.currentTarget) close(); }}
>
  <div
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    class="modal-surface relative mx-4 flex max-h-[calc(100vh-4rem)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]"
    transition:flyAndScale={{ y: -20, start: 0.95, duration: 250 }}
  >
    <div class="flex shrink-0 items-center justify-between border-b border-[var(--border)] px-5 py-2.5">
      <div>
        <h3 class="text-sm font-semibold text-[var(--text)]">Runtime Manager</h3>
        <p class="text-xs text-[var(--text-muted)]">llama.cpp - the engine that runs local models</p>
      </div>
      <button type="button" class="chateaui-icon-button h-7 w-7 p-0" onclick={close} aria-label="Close">
        <X class="h-3.5 w-3.5" />
      </button>
    </div>

    <LocalRuntimePanel closeOnUse={true} />
  </div>
</div>
