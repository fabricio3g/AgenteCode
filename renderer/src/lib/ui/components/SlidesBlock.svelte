<script lang="ts">
  import type { ChatMessage } from '$lib/types/chat';
  import { Download } from 'lucide-svelte';
  import SlidesViewer from '$lib/components/chat/SlidesViewer.svelte';

  interface Props {
    slides?: ChatMessage['slides'];
    mode?: ChatMessage['mode'];
    onDownload: () => void;
  }

  let { slides = [], mode = 'chat', onDownload }: Props = $props();
</script>

{#if slides?.length}
  {#if mode === 'slides'}
    <SlidesViewer slides={slides} {onDownload} />
  {:else}
    <div class="chateaui-card mt-4 flex items-center justify-between px-4 py-3" style="--chateaui-card-bg: var(--surface-highlight);">
      <div>
        <div class="text-sm font-semibold text-[var(--text)]">Presentation ready</div>
        <div class="text-xs text-[var(--text-secondary)]">{slides.length} slide(s) parsed from the response</div>
      </div>
      <button class="chateaui-button-primary inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium" onclick={onDownload}>
        <Download class="h-3.5 w-3.5" />
        Download PPTX
      </button>
    </div>
  {/if}
{/if}
