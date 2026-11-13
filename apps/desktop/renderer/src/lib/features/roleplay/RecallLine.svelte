<svelte:options runes={true} />

<!--
  "Remembered": the memory one reply was written from, one quiet line under it.

  It lists the pinned memories, the lore entries that fired and whether the
  story summary was in the prompt, as the prompt builder saw them that turn.
  When the context budget cut anything to fit the window, a second quiet line
  names what was trimmed. Nothing here is editable; the Memory panel is where
  memories change.
-->

<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { BookOpen, ChevronDown, ChevronRight, Pin, ScrollText } from '$lib/icons';
  import { t } from 'svelte-i18n';
  import type { RoleplayRecall, RoleplayTrimNote } from '$lib/types/chat';

  let { recall }: { recall: RoleplayRecall } = $props();

  let open = $state(false);
  /** Titles are plain labels; markdown marks from the line they came from are dropped. */
  const plain = (text: string) => text.replace(/[*_`#>~]+/g, '').replace(/\s+/g, ' ').trim();
  const total = $derived(recall.memories.length + recall.lore.length + (recall.summary ? 1 : 0));
  /** One label per trim the budget made, in the order it made them (cheapest first). */
  const trimLabel = (note: RoleplayTrimNote) => {
    switch (note.kind) {
      case 'examples': return $t('roleplay.trim.examples');
      case 'lore': return $t('roleplay.trim.lore', { values: { count: note.count ?? 0 } });
      case 'descriptions': return $t('roleplay.trim.descriptions');
      case 'history': return $t('roleplay.trim.history', { values: { count: note.count ?? 0 } });
    }
  };
  const trimNotice = $derived(
    recall.trimmed?.length
      ? $t('roleplay.trim.notice', { values: { items: recall.trimmed.map(trimLabel).join(', ') } })
      : ''
  );
</script>

{#if total > 0 || trimNotice}
  <div class="recall">
    {#if total > 0}
      <UiButton variant="plain" type="button" class={uiClass("recall-toggle", "ui-local-770c8860")} aria-expanded={open} onclick={() => (open = !open)}>
        {#if open}<ChevronDown class="size-3" />{:else}<ChevronRight class="size-3" />{/if}
        <span>{$t('roleplay.recall.label', { values: { n: total } })}</span>
      </UiButton>
    {/if}
    {#if open && total > 0}
      <ul class="recall-list">
        {#if recall.summary}
          <li><ScrollText class="size-3" /><span>{$t('roleplay.recall.summary')}</span></li>
        {/if}
        {#each recall.memories as memory (memory.id)}
          <li><Pin class="size-3" /><span class="truncate">{plain(memory.title) || $t('roleplay.journal.untitled')}</span></li>
        {/each}
        {#each recall.lore as entry (entry.id)}
          <li><BookOpen class="size-3" /><span class="truncate">{plain(entry.title) || $t('roleplay.lore.untitled')}</span></li>
        {/each}
      </ul>
    {/if}
    {#if trimNotice}
      <p class="recall-trim">{trimNotice}</p>
    {/if}
  </div>
{/if}

<style>
  .recall {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.375rem;
  }

  :global(.recall-toggle.ui-local-770c8860) {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    align-self: flex-start;
    padding: 0.125rem 0.25rem;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  :global(.recall-toggle:hover.ui-local-770c8860) {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .recall-trim {
    margin: 0 0.25rem;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .recall-list {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    margin: 0;
    padding: 0.375rem 0.5rem;
    border-radius: var(--radius-md);
    background: var(--surface-hover);
    list-style: none;
  }

  .recall-list li {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    min-width: 0;
    color: var(--text-secondary);
    font-size: var(--text-xs);
  }

  .recall-list :global(svg) {
    flex-shrink: 0;
    color: var(--text-muted);
  }
</style>
