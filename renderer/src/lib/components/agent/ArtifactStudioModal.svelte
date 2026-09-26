<svelte:options runes={true} />

<!-- The in-chat artifact studio: the inline studio in a large dialog. -->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import ArtifactStudio from './ArtifactStudio.svelte';

  const artifact = appStore.currentArtifact!;
  const originChatId = appStore.currentChatId || '';
  const originMessageId = appStore.currentArtifactMessageId || '';
  let dirty = $state(false);
  let chatChangeHandled = $state(false);

  function closeNow() {
    appStore.artifactStudioOpen = false;
  }

  function requestClose() {
    if (!dirty) return closeNow();
    confirmStore.show({
      title: $t('artifacts.studio.discardTitle'),
      message: $t('artifacts.studio.discardMessage'),
      confirmLabel: $t('artifacts.studio.discardConfirm'),
      danger: true,
      onConfirm: closeNow
    });
  }

  // Switching chats with the studio open closes it (asking first if edited).
  $effect(() => {
    if (!appStore.artifactStudioOpen || appStore.currentChatId === originChatId || chatChangeHandled) return;
    chatChangeHandled = true;
    requestClose();
  });
</script>

<Dialog title={artifact.title || $t('artifacts.untitled')} onclose={requestClose} class="artifact-studio-dialog h-[88vh] w-[96vw] max-w-6xl">
  <div class="min-h-0 flex-1">
    <ArtifactStudio {artifact} chatId={originChatId} messageId={originMessageId} bind:dirty />
  </div>
</Dialog>

<style>
  :global(.artifact-studio-dialog > header) { min-height: 3.5rem; }
</style>
