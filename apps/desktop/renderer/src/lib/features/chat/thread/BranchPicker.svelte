<svelte:options runes={true} />

<!--
  Pager for regenerated versions of a message. Lives at the top of the overflow
  menu rather than as an untyped `div` of buttons wedged between menu items.
-->

<script lang="ts">
  import { ChevronLeft, ChevronRight } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import { useMessage } from './message-context';

  const ctx = useMessage();

  const atStart = $derived(ctx.activeVersionIndex <= 0);
  const atEnd = $derived(ctx.activeVersionIndex >= ctx.versionCount - 1);
</script>

<div class="branch-picker" role="group" aria-label="Message versions">
  <button
    type="button"
    class="msg-action-btn"
    disabled={atStart}
    onclick={() => appStore.setMessageActiveVersion(ctx.message.id, -1)}
    aria-label={copy.thread.previousVersion}
    title={copy.thread.previousVersion}
  >
    <ChevronLeft class="size-3" />
  </button>
  <span class="branch-count tabular-nums">
    {ctx.activeVersionIndex + 1}/{ctx.versionCount}
  </span>
  <button
    type="button"
    class="msg-action-btn"
    disabled={atEnd}
    onclick={() => appStore.setMessageActiveVersion(ctx.message.id, 1)}
    aria-label={copy.thread.nextVersion}
    title={copy.thread.nextVersion}
  >
    <ChevronRight class="size-3" />
  </button>
</div>

<style>
  .branch-picker {
    display: flex;
    align-items: center;
    gap: 0.125rem;
    padding: 0.125rem 0.35rem 0.25rem;
    margin-bottom: 0.125rem;
    border-bottom: 1px solid var(--border);
  }

  .branch-count {
    flex: 1;
    text-align: center;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
</style>
