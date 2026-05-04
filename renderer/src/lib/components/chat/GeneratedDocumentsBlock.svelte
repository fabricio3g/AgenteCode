<svelte:options runes={true} />

<script lang="ts">
  import { Download, Files } from 'lucide-svelte';
  import { getFileIcon, downloadFromDataUrl } from '$lib/utils/doc-utils';
  import GeneratedDocumentBlock from './GeneratedDocumentBlock.svelte';

  export type GeneratedDocumentItem = {
    name: string;
    dataUrl: string;
    previewHtml: string;
  };

  interface Props {
    docs: GeneratedDocumentItem[];
  }

  let { docs }: Props = $props();

  let activeName = $state('');

  const activeDoc = $derived.by(() => {
    if (!docs.length || !activeName) return null;
    return docs.find((doc) => doc.name === activeName) || null;
  });

  function baseName(name: string) {
    return name.split('/').pop() || name;
  }

  function fileType(name: string) {
    return (name.split('.').pop() || 'file').toUpperCase();
  }
</script>

{#if docs.length}
  <div class="generated-docs-wrap">
    <div class="generated-docs-header">
      <Files class="h-3.5 w-3.5" />
      <span>{docs.length} document{docs.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="generated-docs-list" aria-label="Generated documents">
      {#each docs as doc (doc.name)}
        <div class="generated-doc-row" class:active={activeDoc?.name === doc.name}>
          <button
            type="button"
            class="generated-doc-open"
            onclick={() => (activeName = doc.name)}
            title="View {doc.name}"
          >
            <span class="generated-doc-icon">
              {#each [getFileIcon(doc.name)] as Icon}
                <Icon class="h-4 w-4" />
              {/each}
            </span>
            <span class="generated-doc-copy">
              <span class="generated-doc-name">{baseName(doc.name)}</span>
              <span class="generated-doc-type">{fileType(doc.name)}</span>
            </span>
          </button>
          <button
            type="button"
            class="generated-doc-download"
            title="Download {doc.name}"
            onclick={(event) => { event.stopPropagation(); downloadFromDataUrl(doc.dataUrl, baseName(doc.name)); }}
          >
            <Download class="h-3.5 w-3.5" />
          </button>
        </div>
      {/each}
    </div>

    {#if activeDoc}
      <div class="generated-doc-viewer">
        {#key activeDoc.name}
          <GeneratedDocumentBlock
            name={activeDoc.name}
            dataUrl={activeDoc.dataUrl}
            previewHtml={activeDoc.previewHtml}
            defaultOpen={true}
          />
        {/key}
      </div>
    {/if}
  </div>
{/if}

<style>
  .generated-docs-wrap {
    margin-top: 0.75rem;
  }

  .generated-docs-header {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.4rem;
    color: var(--text-muted);
    font-size: 0.72rem;
    font-weight: 600;
  }

  .generated-docs-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.5rem;
  }

  .generated-doc-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    width: min(14rem, 100%);
    min-height: 2.65rem;
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 0.25rem 0;
    text-align: left;
    box-shadow: none;
    transition: color 150ms ease;
  }

  .generated-doc-open {
    all: unset;
    box-sizing: border-box;
    display: grid;
    grid-column: 1 / 3;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 0.45rem;
    min-width: 0;
    text-align: left;
    cursor: pointer;
  }

  .generated-doc-row:hover,
  .generated-doc-row.active {
    color: var(--text);
  }

  .generated-doc-icon {
    display: inline-flex;
    width: 1.3rem;
    height: 1.3rem;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--text-tertiary);
  }

  .generated-doc-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .generated-doc-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--text);
  }

  .generated-doc-type {
    font-size: 0.625rem;
    font-weight: 500;
    color: var(--text-muted);
  }

  .generated-doc-download {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.7rem;
    height: 1.7rem;
    border-radius: var(--radius-sm);
    padding: 0;
    color: var(--text-tertiary);
    transition: background 150ms ease, color 150ms ease;
  }

  .generated-doc-download:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .generated-doc-viewer {
    margin-top: 0.35rem;
  }
</style>
