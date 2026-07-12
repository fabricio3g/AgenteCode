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
    class="aui-modal-backdrop z-[200] px-3"
    onclick={onOverlayClick}
    onkeydown={onKeyDown}
    role="dialog"
    aria-modal="true"
    tabindex="-1"
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="aui-modal-surface w-[96vw] max-w-6xl"
      style="height: 88vh;"
      onclick={(e) => e.stopPropagation()}
    >
      <!-- Body -->
      <div class="min-h-0 flex-1 overflow-hidden">
        <ChatSandbox />
      </div>
    </div>
  </div>
{/if}
