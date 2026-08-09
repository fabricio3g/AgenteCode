<svelte:options runes={true} />

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

  type PathMode = 'create' | 'rename' | null;
  const initialArtifact = appStore.currentArtifact;
  const originChatId = appStore.currentChatId || '';
  const originMessageId = appStore.currentArtifactMessageId || '';
  const initialDraft = createArtifactDraft(initialArtifact!);
  let draft = $state<ArtifactDraft>(initialDraft);
  let selectedPath = $state(visibleDraftFiles(initialDraft.current)[0]?.[0] || '');
  let activeView = $state<'preview' | 'source'>(resolveArtifactPresentation(initialDraft.current).capabilities.preview ? 'preview' : 'source');
  let railCollapsed = $state(false);
  let downloading = $state(false);
  let pathMode = $state<PathMode>(null);
  let pathValue = $state('');
  let chatChangeHandled = $state(false);

  const files = $derived(visibleDraftFiles(draft.current));
  const selectedContent = $derived(draft.current.files[selectedPath] || '');
  const dirty = $derived(isArtifactDraftDirty(draft));
  const resolved = $derived(resolveArtifactPresentation(draft.current));

  function replaceCurrent(current: ArtifactDraft['current']) {
    draft = { ...draft, current };
  }

  function closeNow() {
    appStore.artifactStudioOpen = false;
  }

  function requestClose() {
    if (!dirty) return closeNow();
    confirmStore.show({
      title: 'Discard artifact changes?',
      message: 'Your unsaved artifact edits will be lost.',
      confirmLabel: 'Discard changes',
      danger: true,
      onConfirm: closeNow
    });
  }

  $effect(() => {
    if (!appStore.artifactStudioOpen || appStore.currentChatId === originChatId || chatChangeHandled) return;
    chatChangeHandled = true;
    requestClose();
  });

  function save() {
    const saved = appStore.saveArtifactToMessage(originChatId, originMessageId, draft.current);
    if (!saved) {
      toastStore.error('The original artifact message is no longer available.');
      return;
    }
    draft = createArtifactDraft(draft.current);
    toastStore.success('Artifact changes saved');
  }

  function discard() {
    draft = createArtifactDraft(draft.original);
    if (!draft.current.files[selectedPath]) selectedPath = visibleDraftFiles(draft.current)[0]?.[0] || '';
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
      title: 'Delete artifact file?',
      message: `Delete “${target}” from the draft? This is not persisted until you save.`,
      confirmLabel: 'Delete file',
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

  function downloadSelected() {
    if (!selectedPath || !(selectedPath in draft.current.files)) return;
    const url = URL.createObjectURL(artifactFileBlob(draft.current.files[selectedPath]));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = selectedPath.split('/').pop() || 'artifact-file';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
      toastStore.error(String((error as Error).message || error || 'Could not create ZIP'));
    } finally {
      downloading = false;
    }
  }
</script>

<Dialog title={draft.current.title || 'Artifact studio'} description={`${resolved.manifest.kind.replaceAll('_', ' ')} · ${files.length} file${files.length === 1 ? '' : 's'}`} onclose={requestClose} class="artifact-studio-dialog h-[88vh] w-[96vw] max-w-6xl">
  <div class="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-3 sm:px-4">
    <SegmentedControl bind:value={activeView} options={[{ value: 'preview', label: 'Preview', disabled: !resolved.capabilities.preview }, { value: 'source', label: 'Source', disabled: !resolved.capabilities.source }]} label="Artifact view" />
    <div class="flex min-w-0 items-center gap-1.5">
      {#if dirty}<span class="hidden text-[11px] text-muted-foreground sm:inline">Unsaved changes</span>{/if}
      <Button variant="ghost" size="sm" onclick={discard} disabled={!dirty}><RotateCcw /> <span class="hidden sm:inline">Discard</span></Button>
      <Button variant="outline" size="sm" onclick={downloadZip} loading={downloading} disabled={!files.length}><Download /> <span class="hidden sm:inline">ZIP</span></Button>
      <Button size="sm" onclick={save} disabled={!dirty}><Save /> Save</Button>
    </div>
  </div>

  {#if resolved.manifest.issues?.length}
    <div class="shrink-0 border-b border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">{resolved.manifest.issues[0].message}</div>
  {/if}

  <div class="flex min-h-0 flex-1 flex-col sm:flex-row">
    <ArtifactFileRail {files} {selectedPath} collapsed={railCollapsed} onselect={(path) => (selectedPath = path)} ontoggle={() => (railCollapsed = !railCollapsed)} oncreate={() => openPathDialog('create')} onrename={() => openPathDialog('rename')} ondelete={requestDelete} />
    <main class="min-h-0 min-w-0 flex-1">
      {#if activeView === 'preview'}
        <ArtifactStudioPreview artifact={draft.current} />
      {:else}
        <ArtifactSourcePane path={selectedPath} content={selectedContent} onchange={updateSelected} ondownload={downloadSelected} />
      {/if}
    </main>
  </div>
</Dialog>

{#if pathMode}
  <Dialog title={pathMode === 'create' ? 'Create artifact file' : 'Rename artifact file'} description="Use a relative path; folders are created implicitly." onclose={() => (pathMode = null)} class="max-w-sm">
    <div class="space-y-4 p-4">
      <input class="aui-input" bind:value={pathValue} placeholder={pathMode === 'create' ? 'src/file.ext' : 'new/path.ext'} onkeydown={(event) => { if (event.key === 'Enter') applyPathDialog(); }} />
      <div class="flex justify-end gap-2">
        <Button variant="ghost" onclick={() => (pathMode = null)}>Cancel</Button>
        <Button onclick={applyPathDialog}>{pathMode === 'create' ? 'Create' : 'Rename'}</Button>
      </div>
    </div>
  </Dialog>
{/if}

<style>
  :global(.artifact-studio-dialog > header) { min-height: 3.5rem; }
</style>
