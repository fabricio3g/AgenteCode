<svelte:options runes={true} />

<!--
  Prompt inspector: exactly what the model was told for a roleplay turn.

  The composed system prompt, which lore entries fired, and a token estimate.
  Memory and cards you cannot inspect are memory and cards you cannot trust —
  this is also the fastest way to answer "is my card actually being used?".
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { X } from 'lucide-svelte';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';

  interface Props {
    messageId: string;
    onclose: () => void;
  }

  let { messageId, onclose }: Props = $props();

  // Snapshot on open: the prompt is a record, not a live form.
  const parts = untrack(() => appStore.previewRoleplayPrompt(messageId));
  const estimatedTokens = $derived(Math.ceil((parts.systemPrompt.length || 0) / 4));
</script>

<div
  class="aui-modal-backdrop z-[61]"
  role="presentation"
  transition:motionFade={{ duration: 150 }}
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="aui-modal-surface max-w-2xl"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="aui-modal-header">
      <div class="min-w-0">
        <div class="aui-modal-title">What the model saw</div>
        <div class="text-xs text-muted-foreground">
          {parts.speaker ? `${parts.speaker.name}'s turn` : 'Scene prompt'} · ~{estimatedTokens} tokens
        </div>
      </div>
      <button type="button" class="aui-icon-button size-8" onclick={onclose} aria-label={copy.actions.close}>
        <X class="size-4" />
      </button>
    </div>

    <div class="aui-modal-body max-h-[62vh] space-y-4 overflow-y-auto">
      <div class="space-y-1.5">
        <div class="text-xs font-medium text-muted-foreground">
          Lore entries ({parts.loreEntries.length})
        </div>
        {#if !parts.loreEntries.length}
          <p class="text-xs text-muted-foreground">No lorebook entries matched this turn.</p>
        {:else}
          <div class="flex flex-wrap gap-1.5">
            {#each parts.loreEntries as entry (entry.id)}
              <span class="prompt-chip">{entry.comment || entry.keys[0] || 'Entry'}</span>
            {/each}
          </div>
        {/if}
      </div>

      <div class="space-y-1.5">
        <div class="text-xs font-medium text-muted-foreground">System prompt</div>
        {#if parts.systemPrompt}
          <pre class="prompt-block">{parts.systemPrompt}</pre>
        {:else}
          <p class="rounded-[var(--radius-md)] border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-muted-foreground">
            This scene resolved no character, so no prompt was sent. Choose a character first.
          </p>
        {/if}
      </div>
    </div>

    <div class="aui-modal-footer">
      <button type="button" class="aui-btn aui-btn-ghost" onclick={onclose}>{copy.actions.close}</button>
    </div>
  </div>
</div>

<style>
  .prompt-chip {
    padding: 0.0625rem 0.4375rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    color: var(--text-muted);
    font-size: 0.6875rem;
  }

  .prompt-block {
    max-height: 22rem;
    overflow: auto;
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-sunken, var(--card));
    color: var(--foreground);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.6875rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
