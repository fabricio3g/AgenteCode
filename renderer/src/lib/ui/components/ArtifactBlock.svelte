<script lang="ts">
  import type { AgentArtifact } from '$lib/types/chat';
  import { FileCode2, ExternalLink } from 'lucide-svelte';

  interface Props {
    artifact?: AgentArtifact | null;
    onOpen: () => void;
  }

  let { artifact = null, onOpen }: Props = $props();

  const fileCount = $derived(
    Object.keys(artifact?.files || {}).filter(k => !k.startsWith('__')).length
  );
</script>

{#if artifact}
  <div class="artifact-card openui-card mt-3 flex items-center justify-between gap-4 px-4 py-3">
    <div class="flex min-w-0 flex-1 items-center gap-3">
      <div class="icon-wrap">
        <FileCode2 class="h-4 w-4" />
      </div>
      <div class="min-w-0">
        <div class="title truncate">{artifact.title || 'Agent workspace'}</div>
        <div class="subtitle">{fileCount} file{fileCount !== 1 ? 's' : ''}</div>
      </div>
    </div>
    <button class="view-btn openui-button-secondary flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-xs font-medium" onclick={onOpen}>
      View in Sandbox
      <ExternalLink class="h-3 w-3 opacity-60" />
    </button>
  </div>
{/if}

<style>
  .artifact-card {
    --openui-card-bg: var(--surface-highlight);
  }

  .icon-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    border-radius: var(--radius-s);
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .title {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text);
  }

  .subtitle {
    font-size: 0.6875rem;
    color: var(--text-muted);
    margin-top: 0.0625rem;
  }

  .view-btn {
    --openui-button-secondary-radius: var(--radius-m);
    font-size: 0.75rem;
  }
</style>
