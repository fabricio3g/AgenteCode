<svelte:options runes={true} />

<!-- The "Add project" modal: the in-app folder browser, opened by any
     Add project button through `codeStore.addProject()`. -->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Dialog } from '$lib/components/ui';
  import { codeStore } from './code.svelte';
  import FolderBrowser from './FolderBrowser.svelte';
</script>

{#if codeStore.folderBrowserOpen}
  <Dialog title={$t('code.addProject')} description={$t('code.noProjectsHint')} size="lg" onclose={() => codeStore.resolveFolderBrowser(null)}>
    <FolderBrowser embedded onopen={(path) => codeStore.resolveFolderBrowser(path)} onsystem={() => void codeStore.pickWithSystemDialog()} />
  </Dialog>
{/if}
