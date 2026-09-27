<svelte:options runes={true} />

<!--
  The chat's artifact side panel: the artifact a card in this chat opened,
  beside the conversation, like the browser panel. Drag the left edge to
  resize (remembered); Escape or ✕ closes it. Unsaved edits ask first.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { FileSpreadsheet, FileText, Files, Globe, Library, Presentation, X } from 'lucide-svelte';
  import type { ArtifactKind } from '$lib/types/chat';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { artifactsForMessage } from '$lib/stores/app-store-artifacts';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';
  import ArtifactStudio from '$lib/components/agent/ArtifactStudio.svelte';
  import ResizeHandle from '$lib/components/ui/ResizeHandle.svelte';

  const WIDTH_KEY = 'flaxeo.artifactPanel.width';
  const MIN = 320;

  function storedWidth(): number {
    try {
      const value = Number(localStorage.getItem(WIDTH_KEY));
      return Number.isFinite(value) && value >= MIN ? value : 640;
    } catch {
      return 640;
    }
  }

  let width = $state(storedWidth());
  let startWidth = 0;
  let resizing = $state(false);
  let dirty = $state(false);

  const ref = $derived(appStore.artifactPanel);
  const artifact = $derived.by(() => {
    if (!ref) return null;
    const message = appStore.currentChat?.messages.find((item) => item.id === ref.messageId);
    return artifactsForMessage(message)[ref.index] ?? null;
  });
  const resolved = $derived(artifact ? resolveArtifactPresentation(artifact) : null);

  const ICONS: Partial<Record<ArtifactKind, typeof FileText>> = {
    report: FileText,
    work_product: FileText,
    document: FileText,
    pdf: FileText,
    spreadsheet: FileSpreadsheet,
    presentation: Presentation,
    research_package: Library,
    web: Globe
  };
  const Icon = $derived((resolved && ICONS[resolved.manifest.kind]) || Files);

  function maxWidth(): number {
    return Math.max(MIN, Math.round(window.innerWidth * 0.72));
  }

  function resize(delta: number) {
    width = Math.min(maxWidth(), Math.max(MIN, startWidth - delta));
  }

  function endResize() {
    resizing = false;
    try {
      localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
    } catch {
      /* remembered width is a convenience */
    }
  }

  function close() {
    const chatId = ref?.chatId;
    if (!chatId) return;
    const done = () => {
      dirty = false;
      appStore.closeArtifactPanel(chatId);
    };
    if (!dirty) return done();
    confirmStore.show({
      title: $t('artifacts.studio.discardTitle'),
      message: $t('artifacts.studio.discardMessage'),
      confirmLabel: $t('artifacts.studio.discardConfirm'),
      danger: true,
      onConfirm: done
    });
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !ref || event.defaultPrevented) return;
    // Leave Escape to dialogs and menus that are open on top.
    if (document.querySelector('[role="dialog"], [role="menu"]')) return;
    close();
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if ref && artifact && resolved}
  <aside class="artifact-panel" class:is-resizing={resizing} style:width={`${width}px`} aria-label={artifact.title || $t('artifacts.untitled')}>
    <ResizeHandle
      label={$t('artifacts.panel.resize')}
      onstart={() => { startWidth = width; resizing = true; }}
      onresize={resize}
      onend={endResize}
    />
    <div class="panel-body">
      {#key `${ref.messageId}:${ref.index}`}
        <ArtifactStudio {artifact} chatId={ref.chatId} messageId={ref.messageId} bind:dirty compact>
          {#snippet lead()}
            <div class="flex min-w-0 items-center gap-2.5">
              <span class="panel-icon" aria-hidden="true"><Icon class="size-4" /></span>
              <span class="min-w-0">
                <span class="panel-title">{artifact.title || $t('artifacts.untitled')}</span>
                <span class="panel-meta">{$t(`artifacts.kind.${resolved.manifest.kind}`)}</span>
              </span>
            </div>
          {/snippet}
          {#snippet trail()}
            <button type="button" class="panel-close" onclick={close} aria-label={$t('artifacts.reader.close')} title={$t('artifacts.reader.close')}>
              <X class="size-4" />
            </button>
          {/snippet}
        </ArtifactStudio>
      {/key}
    </div>
  </aside>
{/if}

<style>
  .artifact-panel {
    position: relative;
    display: flex;
    min-width: min(380px, 60%);
    /* The conversation always keeps a readable column. */
    max-width: calc(100% - 22rem);
    flex-shrink: 0;
    border-left: 1px solid var(--border);
    background: var(--background);
  }
  .artifact-panel :global(> [role='separator']) {
    position: absolute;
    top: 0;
    bottom: 0;
    left: -3px;
    z-index: 5;
  }
  .artifact-panel.is-resizing {
    user-select: none;
  }
  .artifact-panel.is-resizing :global(iframe) {
    pointer-events: none;
  }
  .panel-body {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
  }
  .panel-icon {
    display: inline-flex;
    width: 1.75rem;
    height: 1.75rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.5rem;
    background: var(--muted);
    color: var(--muted-foreground);
  }
  .panel-title,
  .panel-meta {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .panel-title {
    font-size: 13px;
    font-weight: 500;
    color: var(--foreground);
  }
  .panel-meta {
    font-size: 11.5px;
    color: var(--muted-foreground);
  }
  .panel-close {
    display: inline-flex;
    width: 2rem;
    height: 2rem;
    align-items: center;
    justify-content: center;
    border-radius: 0.5rem;
    color: var(--muted-foreground);
  }
  .panel-close:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }
</style>
