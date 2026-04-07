<svelte:options runes={true} />

<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';

  const composerMode = $derived(appStore.composerMode);
  const searchMode = $derived(appStore.searchMode);

  function chipClass(tone: 'neutral' | 'accent' | 'strong') {
    if (tone === 'strong') {
      return '[--openui-pill-border:var(--border-strong)] [--openui-pill-bg:var(--surface-highlight)] text-[var(--text)]';
    }
    if (tone === 'accent') {
      return '[--openui-pill-border:var(--border)] [--openui-pill-bg:var(--surface)] text-[color:var(--info)]';
    }
    return '[--openui-pill-border:var(--border)] [--openui-pill-bg:var(--surface-highlight)] text-[var(--text-tertiary)]';
  }

  const searchModeLabel = $derived.by(() => {
    if (searchMode === 'deep') return 'Deep Search';
    if (searchMode === 'max') return 'Max Search';
    if (searchMode === 'search') return 'Web Search';
    return 'Search';
  });

  const activeCapabilityChips = $derived.by(() => {
    const chips: Array<{ label: string; tone: 'neutral' | 'accent' | 'strong' }> = [];

    if (composerMode !== 'chat') {
      chips.push({
        label: composerMode === 'agent' ? 'Agent Mode' : 'Slides Mode',
        tone: 'strong'
      });
    }

    if (searchMode !== 'chat') {
      chips.push({ label: searchModeLabel, tone: 'accent' });
    }

    if (appStore.pendingAttachments.length > 0 || appStore.currentRagDocuments.length > 0) {
      chips.push({
        label: `${appStore.pendingAttachments.length + appStore.currentRagDocuments.length} context item${appStore.pendingAttachments.length + appStore.currentRagDocuments.length === 1 ? '' : 's'}`,
        tone: 'neutral'
      });
    }

    return chips;
  });
</script>

{#if activeCapabilityChips.length > 0}
  <div class="flex gap-1.5 px-2 pt-1.5">
    <div class="flex flex-wrap items-center gap-1 px-1">
      {#each activeCapabilityChips as chip}
        <span class={`openui-pill inline-flex items-center border px-2 py-0.5 text-[11px] font-medium ${chipClass(chip.tone)}`}>
          {chip.label}
        </span>
      {/each}
    </div>
  </div>
{/if}
