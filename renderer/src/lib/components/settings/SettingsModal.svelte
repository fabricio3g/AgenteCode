<svelte:options runes={true} />

<script lang="ts">
  import { fade } from 'svelte/transition';
  import { flyAndScale } from '$lib/utils/transitions';
  import { X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import UnifiedSettingsPanel from './UnifiedSettingsPanel.svelte';

  function close() {
    appStore.settingsOpen = false;
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
    aria-labelledby="settings-title"
    tabindex="-1"
    class="modal-surface relative mx-3 flex max-h-[calc(100vh-2rem)] w-[calc(100vw-1.5rem)] max-w-5xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--background)] shadow-2xl sm:mx-6 sm:max-h-[calc(100vh-4rem)]"
    transition:flyAndScale={{ y: -20, start: 0.95, duration: 250 }}
  >
    <div class="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-5 py-3">
      <div>
        <h3 id="settings-title" class="text-base font-semibold text-[var(--text)]">Settings</h3>
        <p class="text-xs text-[var(--text-muted)]">App preferences, search, and hardware</p>
      </div>
      <button type="button" class="chateaui-icon-button h-7 w-7 p-0" onclick={close} aria-label="Close">
        <X class="h-3.5 w-3.5" />
      </button>
    </div>

    <UnifiedSettingsPanel />
  </div>
</div>
