<script lang="ts">
  import type { AgentArtifact } from '$lib/types/chat';
  import { ExternalLink } from 'lucide-svelte';
  import InlineArtifactPreview from './InlineArtifactPreview.svelte';
  import { isSimpleArtifact } from '$lib/utils/preview-builder';

  interface Props {
    artifact?: AgentArtifact | null;
    onOpen: () => void;
  }

  let { artifact = null, onOpen }: Props = $props();

  const fileCount = $derived(
    Object.keys(artifact?.files || {}).filter(k => !k.startsWith('__')).length
  );

  const isSimple = $derived(isSimpleArtifact(artifact));
</script>

{#if artifact}
  {#if isSimple}
    <InlineArtifactPreview artifact={artifact} onOpenSandbox={onOpen} />
  {:else}
    <div class="artifact-card mt-3 flex items-center justify-between gap-4 py-2">
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <div class="min-w-0">
          <div class="title truncate">{artifact.title || 'Agent workspace'}</div>
          <div class="subtitle">
            {fileCount} file{fileCount !== 1 ? 's' : ''}{#if artifact.previewHtml} · preview ready{/if}
          </div>
        </div>
      </div>
      <button class="view-btn flex shrink-0 items-center gap-1.5" onclick={onOpen}>
        Open
        <ExternalLink class="h-3 w-3" />
      </button>
    </div>
  {/if}
{/if}

<style>
  .artifact-card {
    border-top: 1px solid color-mix(in srgb, var(--border) 78%, transparent);
  }

  .title {
    font-size: 0.78rem;
    font-weight: 500;
    color: var(--text);
  }

  .subtitle {
    font-size: 0.6875rem;
    color: var(--text-muted);
    margin-top: 0.1rem;
  }

  .view-btn {
    font-size: 0.75rem;
    color: var(--text-secondary);
    padding: 0.25rem 0;
    transition: color 150ms ease;
  }

  .view-btn:hover {
    color: var(--text);
  }
</style>
