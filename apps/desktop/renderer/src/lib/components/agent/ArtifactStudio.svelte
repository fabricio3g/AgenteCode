<svelte:options runes={true} />

<!--
  The artifact studio, inline: preview or source, a file rail, and
  save / discard / ZIP. Hosted by the Artifacts screen and by the in-chat
  studio dialog; the host owns closing (and guards it on `dirty`).
-->

<script lang="ts">
  import JSZip from 'jszip';
  import { Download, RotateCcw, Save } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import ArtifactFileRail from './ArtifactFileRail.svelte';
  import ArtifactSourcePane from './ArtifactSourcePane.svelte';
  import ArtifactStudioPreview from './ArtifactStudioPreview.svelte';
  import {
    createArtifactDraft,
    createDraftFile,
    deleteDraftPath,
    isArtifactDraftDirty,
    renameDraftPath,
    updateDraftFile,
    visibleDraftFiles,
    type ArtifactDraft
  } from '$lib/services/artifact-draft';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';
  import { artifactFileBlob, artifactFilePayload } from '$lib/utils/artifact-files';
  import { t } from 'svelte-i18n';
  import type { AgentArtifact } from '$lib/types/chat';
  import type { Snippet } from 'svelte';

  import ViewerToolbar from '$lib/features/chat/viewers/ViewerToolbar.svelte';
  import { createViewerControls, provideViewerControls, viewerShortcuts } from '$lib/features/chat/viewers/viewer-controls.svelte';

  interface Props {
    artifact: AgentArtifact;
    /** The chat and message the artifact lives on (Save writes back there). */
    chatId: string;
    messageId: string;
    /** True while there are unsaved edits (the owner guards closing on it). */
    dirty?: boolean;
    /** One slim toolbar with icon actions, for the chat side panel. */
    compact?: boolean;
    /** Toolbar start (e.g. the artifact's title) and end (e.g. close). */
    lead?: Snippet;
    trail?: Snippet;
  }

  let { artifact, chatId, messageId, dirty = $bindable(false), compact = false, lead, trail }: Props = $props();

  const controls = createViewerControls();
  provideViewerControls(controls);
  type PathMode = 'create' | 'rename' | null;
  // The studio edits a snapshot; re-keying the component opens another artifact.
  // Drafts are cloned, and reactive proxies can't be, so snapshot them first.
  // svelte-ignore state_referenced_locally
  const initialDraft = createArtifactDraft($state.snapshot(artifact));
  let draft = $state<ArtifactDraft>(initialDraft);
  let selectedPath = $state(visibleDraftFiles(initialDraft.current)[0]?.[0] || '');
  let activeView = $state<'preview' | 'source'>(resolveArtifactPresentation(initialDraft.current).capabilities.preview ? 'preview' : 'source');
  let railCollapsed = $state(false);
  let downloading = $state(false);
  let pathMode = $state<PathMode>(null);
  let pathValue = $state('');

  const files = $derived(visibleDraftFiles(draft.current));
  const selectedContent = $derived(draft.current.files[selectedPath] || '');
  $effect(() => {
    dirty = isArtifactDraftDirty(draft);
  });
  const resolved = $derived(resolveArtifactPresentation(draft.current));
  /** Text files worth reading as code; binaries (xlsx, docx, pptx, pdf) are not. */
  const hasReadableSource = $derived(resolved.capabilities.edit);

  function replaceCurrent(current: ArtifactDraft['current']) {
    draft = { ...draft, current };
  }

  function save() {
    const current = $state.snapshot(draft.current);
    const saved = appStore.saveArtifactToMessage(chatId, messageId, current);
    if (!saved) {
      toastStore.error($t('artifacts.studio.messageGone'));
      return;
    }
    draft = createArtifactDraft(current);
    toastStore.success($t('artifacts.studio.saved'));
  }

  function discard() {
    draft = createArtifactDraft($state.snapshot(draft.original));
    if (!(selectedPath in draft.current.files)) selectedPath = visibleDraftFiles(draft.current)[0]?.[0] || '';
  }

  function updateSelected(content: string) {
    if (!selectedPath) return;
    try { replaceCurrent(updateDraftFile(draft.current, selectedPath, content)); }
    catch (error) { toastStore.error(String((error as Error).message || error)); }
  }

  function defaultContent(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    if (ext === 'html' || ext === 'htm') return '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8" />\n  <meta name="viewport" content="width=device-width, initial-scale=1" />\n  <title>Artifact</title>\n</head>\n<body>\n\n</body>\n</html>\n';
    if (ext === 'json') return '{}\n';
    if (ext === 'md') return '# Document\n\n';
    return '';
  }

  function openPathDialog(mode: Exclude<PathMode, null>) {
    pathMode = mode;
    pathValue = mode === 'rename' ? selectedPath : '';
  }

  function applyPathDialog() {
    try {
      if (pathMode === 'create') {
        replaceCurrent(createDraftFile(draft.current, pathValue, defaultContent(pathValue)));
        selectedPath = pathValue.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      } else if (pathMode === 'rename' && selectedPath) {
        const previous = selectedPath;
        replaceCurrent(renameDraftPath(draft.current, previous, pathValue));
        selectedPath = pathValue.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      }
      pathMode = null;
      activeView = 'source';
    } catch (error) {
      toastStore.error(String((error as Error).message || error));
    }
  }

  function requestDelete() {
    if (!selectedPath) return;
    const target = selectedPath;
    confirmStore.show({
      title: $t('artifacts.studio.deleteTitle'),
      message: $t('artifacts.studio.deleteMessage', { values: { path: target } }),
      confirmLabel: $t('artifacts.studio.deleteFile'),
      danger: true,
      onConfirm: () => {
        try {
          replaceCurrent(deleteDraftPath(draft.current, target));
          selectedPath = visibleDraftFiles(draft.current)[0]?.[0] || '';
        } catch (error) {
          toastStore.error(String((error as Error).message || error));
        }
      }
    });
  }

  function downloadPath(path: string) {
    if (!path || !(path in draft.current.files)) return;
    const url = URL.createObjectURL(artifactFileBlob(draft.current.files[path]));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = path.split('/').pop() || 'artifact-file';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function downloadSelected() {
    downloadPath(selectedPath);
  }

  /** One file downloads as itself; several come as a ZIP. */
  function downloadAll() {
    if (files.length === 1) downloadPath(files[0][0]);
    else void downloadZip();
  }

  async function downloadZip() {
    if (downloading || !files.length) return;
    downloading = true;
    try {
      const zip = new JSZip();
      for (const [path, content] of files) zip.file(path, artifactFilePayload(content));
      const url = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${(draft.current.title || 'artifact').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toastStore.error(String((error as Error).message || error || $t('artifacts.studio.zipFailed')));
    } finally {
      downloading = false;
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col" use:viewerShortcuts={controls}>
  {#if resolved.manifest.presentation === 'document'}
    <ViewerToolbar title={(activeView === 'source' ? selectedPath : '') || draft.current.title || $t('artifacts.untitled')} ondownload={activeView === 'preview' ? (controls.download ?? downloadAll) : downloadSelected} {trail}
      actions={[
        ...(hasReadableSource ? [{ label: activeView === 'preview' ? $t('artifacts.studio.source') : $t('artifacts.studio.preview'), run: () => { activeView = activeView === 'preview' ? 'source' : 'preview'; } }] : []),
        ...(dirty ? [{ label: $t('artifacts.studio.discard'), run: discard }] : []),
        ...(files.length > 1 ? [{ label: $t('artifacts.studio.zipHint'), run: () => void downloadZip(), disabled: downloading }] : [])
      ]}>
      {#snippet beforeMenu()}{#if dirty}<Button size="sm" onclick={save}><Save /> {$t('artifacts.studio.save')}</Button>{/if}{/snippet}
    </ViewerToolbar>
  {:else if compact}
    <div class="flex h-12 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] pl-3 pr-2">
      <div class="min-w-0 flex-1">{@render lead?.()}</div>
      <!-- Source only for readable files (HTML, code, text); an Office file's bytes are not code. -->
      {#if hasReadableSource && resolved.capabilities.preview}
        <SegmentedControl bind:value={activeView} options={[{ value: 'preview', label: $t('artifacts.studio.preview') }, { value: 'source', label: $t('artifacts.studio.source') }]} label={$t('artifacts.studio.view')} />
      {/if}
      {#if dirty}
        <Button variant="ghost" size="icon-sm" onclick={discard} aria-label={$t('artifacts.studio.discard')} title={$t('artifacts.studio.discard')}><RotateCcw /></Button>
        <Button size="sm" onclick={save}><Save /> {$t('artifacts.studio.save')}</Button>
      {/if}
      <Button variant="ghost" size="icon-sm" onclick={downloadAll} loading={downloading} disabled={!files.length} aria-label={files.length === 1 ? $t('artifacts.card.download') : $t('artifacts.studio.zipHint')} title={files.length === 1 ? $t('artifacts.card.download') : $t('artifacts.studio.zipHint')}><Download /></Button>
      {@render trail?.()}
    </div>
  {:else}
  <div class="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-2 sm:px-4">
    {@render lead?.()}
    {#if hasReadableSource}
      <SegmentedControl bind:value={activeView} options={[{ value: 'preview', label: $t('artifacts.studio.preview'), disabled: !resolved.capabilities.preview }, { value: 'source', label: $t('artifacts.studio.source') }]} label={$t('artifacts.studio.view')} />
    {/if}
    <div class="flex min-w-0 items-center gap-1.5">
      {#if dirty}<span class="hidden text-[11px] text-muted-foreground sm:inline">{$t('artifacts.studio.unsaved')}</span>{/if}
      <Button variant="ghost" size="sm" onclick={discard} disabled={!dirty} title={$t('artifacts.studio.discard')}><RotateCcw /> <span class="hidden sm:inline">{$t('artifacts.studio.discard')}</span></Button>
      <Button variant="outline" size="sm" onclick={downloadZip} loading={downloading} disabled={!files.length} title={$t('artifacts.studio.zipHint')}><Download /> <span class="hidden sm:inline">ZIP</span></Button>
      <Button size="sm" onclick={save} disabled={!dirty}><Save /> {$t('artifacts.studio.save')}</Button>
      {@render trail?.()}
    </div>
  </div>
  {/if}

  {#if resolved.manifest.issues?.length}
    <div class="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--muted)] px-4 py-2 text-xs text-muted-foreground">{resolved.manifest.issues[0].message}</div>
  {/if}

  <div class="flex min-h-0 flex-1 flex-col sm:flex-row">
    <!-- A lone file needs no file list, except while editing its source. -->
    {#if (!compact && resolved.manifest.presentation !== 'document' && files.length > 1) || activeView === 'source'}
    <ArtifactFileRail {files} {selectedPath} collapsed={railCollapsed} onselect={(path) => { selectedPath = path; activeView = 'source'; }} ontoggle={() => (railCollapsed = !railCollapsed)} oncreate={() => openPathDialog('create')} onrename={() => openPathDialog('rename')} ondelete={requestDelete} />
    {/if}
    <main class="min-h-0 min-w-0 flex-1">
      {#if activeView === 'preview'}
        <ArtifactStudioPreview artifact={draft.current} />
      {:else}
        {#key selectedPath}
          <ArtifactSourcePane chrome={resolved.manifest.presentation !== 'document'} path={selectedPath} content={selectedContent} onchange={updateSelected} ondownload={downloadSelected} />
        {/key}
      {/if}
    </main>
  </div>
</div>

{#if pathMode}
  <Dialog title={pathMode === 'create' ? $t('artifacts.studio.createTitle') : $t('artifacts.studio.renameTitle')} description={$t('artifacts.studio.pathHint')} size="sm" onclose={() => (pathMode = null)}>
    <div class="space-y-4 p-4">
      <input class="ui-input" aria-label={$t('artifacts.studio.path')} bind:value={pathValue} placeholder={pathMode === 'create' ? 'src/file.ext' : 'new/path.ext'} onkeydown={(event) => { if (event.key === 'Enter') applyPathDialog(); }} />
      <div class="flex justify-end gap-2">
        <Button variant="ghost" onclick={() => (pathMode = null)}>{$t('artifacts.studio.cancel')}</Button>
        <Button onclick={applyPathDialog}>{pathMode === 'create' ? $t('artifacts.studio.create') : $t('artifacts.studio.rename')}</Button>
      </div>
    </div>
  </Dialog>
{/if}
