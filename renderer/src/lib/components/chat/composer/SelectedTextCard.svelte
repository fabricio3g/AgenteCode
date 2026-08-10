<svelte:options runes={true} />

<!--
  The quoted-selection card that appears above the input when the user asks a
  question about highlighted text. Click to expand into an editable textarea.
-->

<script lang="ts">
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
  <button
    type="button"
    class="card-close"
    aria-label="Discard selected text"
    onclick={ondiscard}
  >
    <X class="size-3" />
  </button>
  <div class="card-body">
    {#if expanded}
      <textarea
        class="card-textarea"
        bind:value={text}
        rows="3"
        onblur={() => (expanded = false)}
      ></textarea>
    {:else}
      <button type="button" class="card-preview" onclick={() => (expanded = true)}>
        {text}
      </button>
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
    padding: 0.65rem 0.75rem;
  }

  .card-preview {
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

  .card-textarea {
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

  .card-close {
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

  .card-close:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }
</style>
