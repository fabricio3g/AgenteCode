<svelte:options runes={true} />

<script lang="ts">
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
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
  class="aui-modal-backdrop z-[63] overflow-hidden"
  transition:motionFade={{ duration: 200 }}
  onclick={(e) => { if (e.target === e.currentTarget) close(); }}
>
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-title"
    tabindex="-1"
    class="aui-modal-surface mx-3 max-h-[calc(100vh-2rem)] w-[calc(100vw-1.5rem)] max-w-5xl sm:mx-6 sm:max-h-[calc(100vh-4rem)]"
    transition:flyAndScale={{ y: -20, start: 0.95, duration: 250 }}
  >
    <div class="aui-modal-header">
      <div>
        <h3 id="settings-title" class="aui-modal-title">Settings</h3>
        <p class="text-xs text-muted-foreground">App preferences, search, and hardware</p>
      </div>
      <button type="button" class="aui-icon-button size-8" onclick={close} aria-label="Close">
        <X class="size-3.5" />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <UnifiedSettingsPanel />
    </div>
  </div>
</div>
