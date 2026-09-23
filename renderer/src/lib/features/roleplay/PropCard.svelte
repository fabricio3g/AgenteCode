<svelte:options runes={true} />

<!--
  Prop card: something the scene handed the user.

  A roleplay artifact, not a work product — no artifact studio, no manifest, no
  report machinery. It renders as a thing: what it is, what it is called, and
  the first line of what is on it. Open it to read the whole thing.
-->

<script lang="ts">
  import { Box, FileText, Image as ImageIcon, Mail, Map, StickyNote } from 'lucide-svelte';
  import type { RoleplayProp } from './roleplay-props';
  import PropViewerModal from './PropViewerModal.svelte';

  interface Props {
    prop: RoleplayProp;
    /** The turn it came from, so the journal can link back. */
    messageId?: string | null;
  }

  let { prop, messageId = null }: Props = $props();

  let open = $state(false);

  const KIND_ICONS = {
    letter: Mail,
    note: StickyNote,
    map: Map,
    document: FileText,
    object: Box,
    photo: ImageIcon
  } as const;

  const Icon = $derived(KIND_ICONS[prop.kind] || Box);
  const preview = $derived(prop.body.split('\n')[0] || '');
</script>

<button type="button" class="prop" onclick={() => (open = true)} aria-label={`Open ${prop.title}`}>
  <span class="prop-icon"><Icon class="size-3.5" /></span>
  <span class="min-w-0 flex-1">
    <span class="prop-title">{prop.title}</span>
    {#if preview}
      <span class="prop-preview">{preview}</span>
    {/if}
  </span>
  <span class="prop-kind">{prop.kind}</span>
</button>

{#if open}
  <PropViewerModal {prop} {messageId} onclose={() => (open = false)} />
{/if}

<style>
  .prop {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    max-width: 34rem;
    margin-top: 0.5rem;
    padding: 0.4375rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--card);
    color: var(--foreground);
    text-align: left;
    cursor: pointer;
    transition:
      border-color var(--motion-fast) var(--motion-ease),
      background-color var(--motion-fast) var(--motion-ease);
  }

  .prop:hover {
    border-color: var(--border-hover);
    background: var(--surface-hover);
  }

  .prop-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    flex-shrink: 0;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-input);
    background: var(--muted);
    color: var(--text-muted);
  }

  .prop-title {
    display: block;
    font-size: 0.8125rem;
    font-weight: 550;
  }

  .prop-preview {
    display: block;
    overflow: hidden;
    color: var(--text-tertiary);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .prop-kind {
    flex-shrink: 0;
    color: var(--text-tertiary);
    font-size: 0.625rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
</style>
