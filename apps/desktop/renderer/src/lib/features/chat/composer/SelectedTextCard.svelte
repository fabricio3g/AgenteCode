<svelte:options runes={true} />

<!--
  The quoted-selection card that appears above the input when highlighted
  text is added to the chat. Click to expand into an editable textarea.
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import UiButton from '$lib/components/ui/Button.svelte';
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { X } from 'lucide-svelte';

  interface Props {
    /** Editable quote text, bound so the composer can send the edited version. */
    text: string;
    ondiscard: () => void;
  }

  let { text = $bindable(), ondiscard }: Props = $props();

  let expanded = $state(false);
</script>

<div class="selected-text-card" class:expanded>
  <IconButton label={"Discard selected text"} size="xs" variant="ghost"
    type="button"
    class={uiClass("card-close", "ui-local-8b67dee0")}

    onclick={ondiscard}
  >
    <X class="size-3" />
  </IconButton>
  <div class="card-body">
    {#if expanded}
      <UiTextarea variant="composer"
        class={uiClass("card-textarea", "ui-local-8b67dee0")}
        bind:value={text}
        rows={3}
        onblur={() => (expanded = false)}
      ></UiTextarea>
    {:else}
      <UiButton variant="plain" type="button" class={uiClass("card-preview", "ui-local-8b67dee0")} onclick={() => (expanded = true)}>
        {text}
      </UiButton>
    {/if}
  </div>
</div>

<style>
  .selected-text-card {
    position: relative;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--background);
  }

  .card-body {
    padding: 0.65rem 2rem 0.65rem 0.75rem;
  }

  :global(.card-preview.ui-local-8b67dee0) {
    width: 100%;
    padding: 0;
    overflow: hidden;
    border: 0;
    background: transparent;
    color: var(--foreground);
    cursor: pointer;
    font-size: 12px;
    line-height: 1.4;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.card-textarea.ui-local-8b67dee0) {
    width: 100%;
    padding: 0;
    border: 0;
    outline: none;
    resize: none;
    background: transparent;
    color: var(--foreground);
    font-family: inherit;
    font-size: 12px;
    line-height: 1.4;
  }

  :global(.card-close.ui-local-8b67dee0) {
    position: absolute;
    top: 0.35rem;
    right: 0.35rem;
    display: inline-flex;
    width: 1.35rem;
    height: 1.35rem;
    padding: 0;
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 9999px;
    background: var(--card);
    color: var(--muted-foreground);
    cursor: pointer;
    transition:
      background 0.12s ease,
      color 0.12s ease;
  }

  :global(.card-close:hover.ui-local-8b67dee0) {
    background: var(--surface-hover);
    color: var(--foreground);
  }
</style>
