<svelte:options runes={true} />

<script lang="ts">
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
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
  class="aui-modal-backdrop z-[63] overflow-hidden"
  transition:motionFade={{ duration: 200 }}
  onclick={(e) => { if (e.target === e.currentTarget) close(); }}
>
  <div
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    class="aui-modal-surface mx-4 max-h-[calc(100vh-4rem)] max-w-3xl"
    transition:flyAndScale={{ y: -20, start: 0.95, duration: 250 }}
  >
    <div class="aui-modal-header">
      <div>
        <h3 class="aui-modal-title">Runtime Manager</h3>
        <p class="text-xs text-muted-foreground">llama.cpp - the engine that runs local models</p>
      </div>
      <button type="button" class="aui-icon-button size-8" onclick={close} aria-label="Close">
        <X class="size-3.5" />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <LocalRuntimePanel closeOnUse={true} />
    </div>
  </div>
</div>
