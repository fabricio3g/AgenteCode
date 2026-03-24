<script lang="ts">
  import type { WorkContextMeta } from '$lib/types/chat';
  import { BriefcaseBusiness, Database, Globe } from 'lucide-svelte';

  interface Props {
    workContext?: WorkContextMeta | null;
    sourceCount?: number;
    ragCount?: number;
  }

  let { workContext = null, sourceCount = 0, ragCount = 0 }: Props = $props();
</script>

{#if workContext || sourceCount > 0 || ragCount > 0}
  <div class="context-row mb-3">
    {#if workContext}
      <span class="context-pill work">
        <BriefcaseBusiness class="h-3 w-3" />
        {workContext.indexedCount}
      </span>
    {/if}
    {#if sourceCount > 0}
      <span class="context-pill">
        <Globe class="h-3 w-3" />
        {sourceCount}
      </span>
    {/if}
    {#if ragCount > 0}
      <span class="context-pill">
        <Database class="h-3 w-3" />
        {ragCount}
      </span>
    {/if}
  </div>
{/if}

<style>
  .context-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  .context-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    font-size: 0.6875rem;
    font-weight: 500;
    color: var(--text-muted);
    background: var(--surface-highlight);
  }

  .context-pill.work {
    color: var(--work-accent-strong);
    background: var(--work-accent-soft);
  }
</style>
