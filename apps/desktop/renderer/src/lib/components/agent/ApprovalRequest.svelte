<svelte:options runes={true} />

<!--
  Inline approval prompt.

  The run is stopped until this is answered. It previously lived only inside the
  activity drawer, so with the drawer closed a blocked agent showed nothing at
  all and the user had no way to know why it had stalled.
-->

<script lang="ts">
  import { ShieldQuestion } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { approvalsStore, type PendingApproval } from '$lib/stores/approvals.svelte';
  import { copy } from '$lib/copy';

  interface Props {
    approvals: PendingApproval[];
  }

  let { approvals }: Props = $props();
</script>

{#each approvals as approval (approval.id)}
  <section class="approval" aria-label={copy.tool.needsApproval}>
    <header class="head">
      <ShieldQuestion class="size-3.5 shrink-0" />
      <span class="title">{copy.tool.needsApproval}</span>
    </header>

    <p class="lede">{copy.tool.approvalLede}</p>

    <pre class="aui-tool-fallback-args-value">{approval.command}</pre>

    {#if approval.cwd}
      <p class="cwd" title={approval.cwd}>{approval.cwd}</p>
    {/if}

    <div class="actions">
      <Button variant="outline" size="sm" onclick={() => approvalsStore.resolve(approval.id, false)}>
        {copy.tool.deny}
      </Button>
      <Button size="sm" onclick={() => approvalsStore.resolve(approval.id, true)}>
        {copy.tool.allow}
      </Button>
    </div>
  </section>
{/each}

<style>
  /* Same card recipe as FileChangesCard, so the two agent cards in one turn
     read as a set. */
  .approval {
    margin: 0.5rem 0;
    width: var(--inline-block-width);
    max-width: 100%;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--muted) 45%, transparent);
    padding: 0.75rem;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--muted-foreground);
    /* Matches AgentBlock's status line, which this sits directly beneath. */
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .title {
    color: var(--foreground);
  }

  .lede {
    margin: 0.35rem 0 0.5rem;
    color: var(--muted-foreground);
    font-size: 0.75rem;
    line-height: 1.5;
  }

  .cwd {
    margin: 0.35rem 0 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted-foreground);
    font-family: var(--font-mono);
    font-size: 0.68rem;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.65rem;
  }
</style>
