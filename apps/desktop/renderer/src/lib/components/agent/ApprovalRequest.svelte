<svelte:options runes={true} />

<!--
  Where a held run stopped, in the conversation.

  The answer itself lives on the composer sheet (ApprovalBar), where Enter and
  Esc already are; this band only marks the spot in the turn: what was asked,
  why, and that the run is waiting below. It used to be a second card with its
  own Allow / Deny, so the same question was asked twice on one screen.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { ShieldQuestion } from '$lib/icons';
  import type { PendingApproval } from '$lib/stores/approvals.svelte';
  import { copy } from '$lib/copy';

  interface Props {
    approvals: PendingApproval[];
  }

  let { approvals }: Props = $props();
</script>

{#each approvals as approval (approval.id)}
  <section class="approval" class:dangerous={approval.dangerous} aria-label={copy.tool.needsApproval}>
    <p class="head">
      <ShieldQuestion class="size-3.5 shrink-0" />
      <span class="title">{copy.tool.needsApproval}</span>
      <code class="what">{approval.command}</code>
    </p>
    {#if approval.dangerous}<p class="note is-danger">{copy.tool.approvalDestructive}</p>{/if}
    {#if approval.reason}<p class="note">{approval.reason}</p>{/if}
    <p class="note">{$t('code.approve.below')}</p>
  </section>
{/each}

<style>
  /* The band the Code transcript draws for a held call: a warning rail and a
     whisper of tint, no box of its own. */
  .approval {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0.25rem 0;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--float-border);
    border-radius: var(--float-radius);
    background: color-mix(in srgb, var(--foreground) 3%, transparent);
  }
  .approval.dangerous {
    background: color-mix(in srgb, var(--error) 4%, transparent);
  }
  .head {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    color: var(--warning);
    font-size: var(--text-sm);
  }
  .dangerous .head {
    color: var(--error);
  }
  .title {
    flex-shrink: 0;
    color: var(--foreground);
    font-weight: 500;
  }
  .what {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted-foreground);
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    font-size: var(--text-xs);
  }
  .note {
    margin: 0;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    line-height: 1.45;
  }
  .note.is-danger {
    color: var(--error);
  }
</style>
