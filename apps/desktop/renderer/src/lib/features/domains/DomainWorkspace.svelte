<svelte:options runes={true} />
<script lang="ts">
  import { Dialog } from '$lib/components/ui';
  import { domainsStore } from './domains.svelte';
  import AudioStudio from './AudioStudio.svelte';
  import CreativeWorkspace from './CreativeWorkspace.svelte';
</script>
{#if domainsStore.open && domainsStore.project}
  <Dialog title={domainsStore.project.title} description={`Local project · revision ${domainsStore.project.revision}`} size="full" onclose={() => { domainsStore.open = false; }}>
    {#if domainsStore.project.domain === 'music'}<AudioStudio />{:else}<CreativeWorkspace />{/if}
  </Dialog>
{/if}
