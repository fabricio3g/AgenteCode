<svelte:options runes={true} />

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';

  const composerMode = $derived(appStore.composerMode);
  const searchMode = $derived(appStore.searchMode);

  const searchModeLabel = $derived.by(() => {
    if (searchMode === 'deep') return 'Deep Search';
    if (searchMode === 'max') return 'Max Search';
    if (searchMode === 'search') return 'Web Search';
    return 'Search';
  });

  const activeCapabilityChips = $derived.by(() => {
    const chips: Array<{ label: string }> = [];

    if (composerMode !== 'chat') {
      chips.push({
        label: composerMode === 'agent' ? 'Agent Mode' : 'Slides Mode'
      });
    }

    if (searchMode !== 'chat') {
      chips.push({ label: searchModeLabel });
    }

    if (appStore.pendingAttachments.length > 0 || appStore.currentRagDocuments.length > 0) {
      chips.push({
        label: `${appStore.pendingAttachments.length + appStore.currentRagDocuments.length} context item${appStore.pendingAttachments.length + appStore.currentRagDocuments.length === 1 ? '' : 's'}`
      });
    }

    return chips;
  });
</script>

{#if activeCapabilityChips.length > 0}
  <div class="flex gap-1 px-2 pt-1">
    <div class="flex flex-wrap items-center gap-1 px-1 text-xs font-medium text-[var(--text-tertiary)]">
      {#each activeCapabilityChips as chip, i}
        {#if i > 0}<span class="text-[var(--text-muted)]"> · </span>{/if}
        <span>{chip.label}</span>
      {/each}
    </div>
  </div>
{/if}
