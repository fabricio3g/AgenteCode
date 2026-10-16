<svelte:options runes={true} />

<!--
  The prompt that opens at the selection: pick an element, type the change
  right under it, Enter sends. It is the same turn the composer would send —
  the selection rides along through designStore.takeTurnContext — so this is a
  shortcut, not a second chat. Esc lets go of the selection.
-->

<script lang="ts">
  import { ArrowUp, Sparkles } from 'lucide-svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import { designStore } from './design.svelte';

  let { label, more = 0 }: {
    /** What is selected, as its chip names it. */
    label: string;
    /** How many other elements ride along. */
    more?: number;
  } = $props();

  let text = $state('');

  async function send() {
    const change = text.trim();
    if (!change) return;
    // The composer is the one send path; keep whatever draft was waiting in it.
    const draft = appStore.composer;
    appStore.composer = change;
    text = '';
    await appStore.sendCurrentMessage();
    if (draft.trim() && !appStore.composer) appStore.composer = draft;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      designStore.clearSelection();
    }
  }
</script>

<div class="selection-prompt ui-float" data-selection-prompt>
  <span class="target" title={label}>
    <Sparkles aria-hidden="true" />
    <span class="target-name">{label}</span>
    {#if more > 0}<span class="target-more">+{more}</span>{/if}
  </span>
  <div class="row">
    <Input
      variant="inline"
      class="min-w-0 flex-1 text-[length:var(--text-sm)]"
      bind:value={text}
      placeholder={copy.design.prompt.placeholder}
      aria-label={copy.design.prompt.placeholder}
      onkeydown={onKeydown}
    />
    <IconButton label={copy.design.prompt.send} size="xs" variant="ghost" class="send" disabled={!text.trim()} onclick={() => void send()}>
      <ArrowUp aria-hidden="true" />
    </IconButton>
  </div>
</div>

<style>
  .selection-prompt {
    display: flex;
    width: 17rem;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.375rem 0.375rem 0.375rem 0.625rem;
  }

  /* What the prompt is about, quiet above the field: the ember spark marks it as the agent's. */
  .target {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 0.375rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .target :global(svg) { width: 12px; height: 12px; flex-shrink: 0; color: var(--brand-accent); }
  .target-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .target-more { flex-shrink: 0; font-variant-numeric: tabular-nums; }

  .row { display: flex; align-items: center; gap: 0.25rem; }

  .row :global(.send:not(:disabled)) {
    background: var(--brand-accent);
    color: #fff;
  }
</style>
