<svelte:options runes={true} />

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';
  import ChatSandbox from '$lib/components/agent/ChatSandbox.svelte';

  let open = $derived(appStore.sandboxOpen && !!appStore.currentArtifact);

  function close() {
    appStore.sandboxOpen = false;
  }

  function onOverlayClick(e: MouseEvent) {
    if (e.target === e.currentTarget) close();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 z-[200] flex items-center justify-center bg-overlay px-4"
    onclick={onOverlayClick}
    onkeydown={onKeyDown}
    role="dialog"
    aria-modal="true"
  >
    <div
      class="flex w-[95vw] max-w-7xl flex-col rounded-lg border bg-surface shadow-lg"
      style="height: 90vh;"
      onclick={(e) => e.stopPropagation()}
    >
      <!-- Body -->
      <div class="min-h-0 flex-1 overflow-hidden">
        <ChatSandbox />
      </div>
    </div>
  </div>
{/if}
