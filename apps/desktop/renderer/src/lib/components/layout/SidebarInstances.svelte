<svelte:options runes={true} />

<!--
  The sidebar's "Running" list: local models that are loaded right now, with
  their state and port. Only there while something runs; a row opens
  Models → Running.

  It lives in the sidebar's footer, below the conversation list: a model
  loading is not a reason to move the search field and every conversation down
  the rail.
-->

<script lang="ts">
  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import { cn as uiClass } from '$lib/utils/cn';

  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Wifi } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { instancesStore } from '$lib/stores/instances.svelte';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';

  onMount(() => void instancesStore.watch());

  function open() {
    appStore.openSettings('loaded');
  }

  const tone = (state: string) =>
    state === 'error' ? 'error' : state === 'ready' || state === 'model_ready' ? 'active' : 'busy';
</script>

{#if instancesStore.running.length}
  <div class="running">
    <p class="sidebar-section">{$t('instances.sidebarTitle')}</p>
    {#each instancesStore.running as instance (instance.id)}
      <UiListRow  type="button" class={uiClass("sidebar-row")} onclick={open} title={instance.model_path}>
        <StatusDot tone={tone(instance.state)} />
        <span class="sidebar-row-label">{instance.model_id.replace(/\.gguf$/i, '')}</span>
        {#if instance.shared}<Wifi class="size-3 shrink-0 opacity-60" aria-label={$t('instances.shared')} />{/if}
        {#if instancesStore.inChat(instance)}<span class="tag">{$t('instances.inChatShort')}</span>{:else if instance.port}<span class="port">:{instance.port}</span>{/if}
      </UiListRow>
    {/each}
  </div>
{/if}

<style>
  .running {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .port,
  .tag {
    flex-shrink: 0;
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }

  .tag {
    padding: 0 0.4rem;
    border-radius: var(--radius-full);
    background: var(--accent-green-bg);
    color: var(--accent-green-text);
    font-weight: 500;
  }
</style>
