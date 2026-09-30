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
  import { t } from 'svelte-i18n';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import { modalLayer } from '$lib/components/ui/modal-layer';
  import Portal from '$lib/components/ui/Portal.svelte';
  import { roleplayStore } from '$lib/features/roleplay/roleplay.svelte';
  import { copy } from '$lib/copy';

  interface Props {
    messageId: string;
    onclose: () => void;
  }

  let { messageId, onclose }: Props = $props();

  // Snapshot on open: the prompt is a record, not a live form.
  const parts = untrack(() => roleplayStore.previewPrompt(messageId));
  const estimatedTokens = $derived(Math.ceil((parts.systemPrompt.length || 0) / 4));
</script>

<Portal>
<div
  class="ui-modal-backdrop"
  role="presentation"
  use:modalLayer={{ onclose: onclose }}
  transition:motionFade={{ duration: 150 }}
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="ui-modal-surface max-w-2xl"
     role="dialog"
     aria-label={$t('roleplay.inspector.title')}
    aria-modal="true"
    tabindex="-1"
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
    onclick={(e) => e.stopPropagation()}
  >
    <div class="ui-modal-header">
      <div class="min-w-0">
        <div class="ui-modal-title">{$t('roleplay.inspector.title')}</div>
        <div class="text-xs text-muted-foreground">
          {parts.speaker ? $t('roleplay.inspector.turn', { values: { name: parts.speaker.name } }) : $t('roleplay.inspector.scene')} · {$t('roleplay.inspector.tokens', { values: { n: estimatedTokens } })}
        </div>
      </div>
      <button type="button" class="ui-icon-button" onclick={onclose} aria-label={copy.actions.close}>
        <X class="size-4" />
      </button>
    </div>

    <div class="ui-modal-body space-y-4">
      <div class="space-y-1.5">
        <div class="text-xs font-medium text-muted-foreground">
          {$t('roleplay.inspector.lore', { values: { n: parts.loreEntries.length } })}
        </div>
        {#if !parts.loreEntries.length}
          <p class="text-xs text-muted-foreground">{$t('roleplay.inspector.noLore')}</p>
        {:else}
          <div class="flex flex-wrap gap-1.5">
            {#each parts.loreEntries as entry (entry.id)}
              <span class="prompt-chip">{entry.comment || entry.keys[0] || 'Entry'}</span>
            {/each}
          </div>
        {/if}
      </div>

      <div class="space-y-1.5">
        <div class="text-xs font-medium text-muted-foreground">{$t('roleplay.inspector.system')}</div>
        {#if parts.systemPrompt}
          <pre class="prompt-block">{parts.systemPrompt}</pre>
        {:else}
          <p class="rounded-[var(--radius-md)] border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-muted-foreground">
            This scene resolved no character, so no prompt was sent. Choose a character first.
          </p>
        {/if}
      </div>
    </div>

    <div class="ui-modal-footer">
      <button type="button" class="ui-btn ui-btn-ghost" onclick={onclose}>{copy.actions.close}</button>
    </div>
  </div>
</div>
</Portal>

<style>
  .prompt-chip {
    padding: 0.0625rem 0.4375rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    color: var(--text-muted);
    font-size: 0.6875rem;
  }

  .prompt-block {
    padding: 0.75rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-sunken, var(--card));
    color: var(--foreground);
    font-variant-numeric: tabular-nums;
    font-size: 0.6875rem;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
