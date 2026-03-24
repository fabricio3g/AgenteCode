<svelte:options runes={true} />

<script lang="ts">
  import { MessageSquare, Bot, Presentation } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';

  const composerMode = $derived(appStore.composerMode);

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
    if (appStore.searchMode === 'deep') return 'Deep Search';
    if (appStore.searchMode === 'max') return 'Max Search';
    if (appStore.searchMode === 'search') return 'Web Search';
    return 'Chat Only';
  });

  const activeCapabilityChips = $derived.by(() => {
    const chips: Array<{ label: string; tone: 'neutral' | 'accent' | 'strong' }> = [];

    if (composerMode !== 'chat') {
      chips.push({
        label: composerMode === 'agent' ? 'Agent Mode' : 'Slides Mode',
        tone: 'strong'
      });
    }

    if (appStore.searchMode !== 'chat') {
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

<div class="flex gap-1.5 px-2 pt-1.5">
  <div class="flex items-center gap-1.5 overflow-x-auto">
    <div class="openui-segmented flex items-center gap-1">
      <button
        class={`openui-segment flex items-center gap-1 px-2.5 py-1 text-xs font-medium transition ${composerMode === 'chat' ? 'is-active' : ''}`}
        onclick={() => appStore.setComposerMode('chat')}
      >
        <MessageSquare class="h-3.5 w-3.5" />
        <span>Chat</span>
      </button>
      <button
        class={`openui-segment flex items-center gap-1 px-2.5 py-1 text-xs font-medium transition ${composerMode === 'agent' ? 'is-active' : ''}`}
        onclick={() => appStore.setComposerMode('agent')}
      >
        <Bot class="h-3.5 w-3.5" />
        <span>Agent</span>
      </button>
      <button
        class={`openui-segment flex items-center gap-1 px-2.5 py-1 text-xs font-medium transition ${composerMode === 'slides' ? 'is-active' : ''}`}
        onclick={() => appStore.setComposerMode('slides')}
      >
        <Presentation class="h-3.5 w-3.5" />
        <span>Slides</span>
      </button>
    </div>
  </div>

  {#if activeCapabilityChips.length > 0}
    <div class="flex flex-wrap items-center gap-1 px-1">
      {#each activeCapabilityChips as chip}
        <span class={`openui-pill inline-flex items-center border px-2 py-0.5 text-[11px] font-medium ${chipClass(chip.tone)}`}>
          {chip.label}
        </span>
      {/each}
    </div>
  {/if}
</div>
