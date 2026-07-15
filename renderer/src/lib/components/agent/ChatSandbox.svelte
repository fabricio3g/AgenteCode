<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { AlertCircle, Braces, Check, ChevronRight, Code, Copy, Download, ExternalLink, Eye, FileCode, FileSpreadsheet, FileText, Folder, Image, Palette, Pencil, Plus, Presentation, RefreshCw, Terminal, Trash2, X } from 'lucide-svelte';
  import JSZip from 'jszip';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import CodeEditor from '$lib/ui/components/CodeEditor.svelte';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import { artifactFileBlob, artifactFilePayload, isDataUrlFile, isHiddenArtifactFile, viewerPathFor } from '$lib/utils/artifact-files';

  type TreeNode = { name: string; path: string; type: 'file' | 'folder'; children?: TreeNode[]; expanded?: boolean };
  type PreviewLog = { level: 'log' | 'warn' | 'error'; text: string };

  let selectedPath = $state('');
  let activePane = $state<'code' | 'preview'>('code');
  let copied = $state(false);
  let downloading = $state(false);
  let editing = $state(false);
  let editBuffer = $state('');
  let treeExpanded = $state<Record<string, boolean>>({});
  let openTabs = $state<string[]>([]);

  let previewMessages = $state<PreviewLog[]>([]);
  let previewRefreshKey = $state(0);

  let showNewFileModal = $state(false);
  let showNewFolderModal = $state(false);
  let showDeleteConfirm = $state(false);
  let pendingDeletePath = $state<string | null>(null);
  let pendingDeleteType = $state<'file' | 'folder'>('file');
  let newItemName = $state('');
  let newItemParent = $state('');
  let newItemInput = $state<HTMLInputElement | undefined>(undefined);

  let showRenameModal = $state(false);
  let pendingRenamePath = $state<string | null>(null);
  let pendingRenameType = $state<'file' | 'folder'>('file');
  let renameValue = $state('');
  let renameInput = $state<HTMLInputElement | undefined>(undefined);

  const artifact = $derived(appStore.currentArtifact);
  const files = $derived(artifact?.files || {});
  const projectName = $derived(artifact?.title?.replace(/[^a-z0-9_-]/gi, '-')?.toLowerCase() || 'project');

  const fileTree = $derived.by(() => {
    const root: TreeNode[] = [];
    const paths = Object.keys(files).filter((path) => !isHiddenArtifactFile(path)).sort();

    for (const path of paths) {
      const parts = path.split('/');
      let current = root;

      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const isFile = index === parts.length - 1;
        const currentPath = parts.slice(0, index + 1).join('/');

        let node = current.find((entry) => entry.name === part);

        if (!node) {
          node = {
            name: part,
            path: currentPath,
            type: isFile ? 'file' : 'folder',
            children: isFile ? undefined : [],
            expanded: treeExpanded[currentPath] ?? false
          };
          current.push(node);
        }

        if (!isFile && node.children) {
          current = node.children;
        }
      }
    }

    return root;
  });

  const fileList = $derived(Object.entries(files).filter(([path]) => !isHiddenArtifactFile(path)).sort(([a], [b]) => a.localeCompare(b)));
  const visibleFileCount = $derived(fileList.length);

  let prevArtifactFileKeys = $state('');
  let prevPreviewHtml = $state('');

  $effect(() => {
    const visiblePaths = Object.keys(files).filter((path) => !isHiddenArtifactFile(path));
    const currentKeys = visiblePaths.sort().join('|');
    const currentPreviewHtml = artifact?.previewHtml || '';
    if (currentKeys === prevArtifactFileKeys && currentPreviewHtml === prevPreviewHtml) return;
    const oldKeys = prevArtifactFileKeys;
    prevArtifactFileKeys = currentKeys;
    prevPreviewHtml = currentPreviewHtml;

    if (!visiblePaths.length) {
      selectedPath = '';
      if (artifact?.previewHtml) activePane = 'preview';
      return;
    }

    const htmlFile = visiblePaths.find((path) => path.endsWith('.html'));
    const viewerFile = visiblePaths.find((path) => files[viewerPathFor(path)]);
    const preferredPreviewFile = htmlFile || viewerFile;
    const isNewPreview = preferredPreviewFile && !oldKeys.split('|').filter(Boolean).includes(preferredPreviewFile);

    if (!selectedPath || !files[selectedPath]) {
      selectedPath = preferredPreviewFile ?? visiblePaths[0] ?? '';
      if (preferredPreviewFile || artifact?.previewHtml) activePane = 'preview';
    } else if (isNewPreview && preferredPreviewFile) {
      selectedPath = preferredPreviewFile;
      activePane = 'preview';
    } else if (!preferredPreviewFile && artifact?.previewHtml) {
      activePane = 'preview';
    }
  });

  $effect(() => {
    void selectedPath;
    editing = false;
  });

  $effect(() => {
    void selectedPath;
    void artifact?.previewHtml;
    void previewRefreshKey;
    previewMessages = [];
  });

  const selectedContent = $derived(files[selectedPath] || '');
  const selectedViewerHtml = $derived(selectedPath ? (files[viewerPathFor(selectedPath)] || '') : '');
  const selectedIsBinary = $derived(isDataUrlFile(selectedContent));
  const isHtml = $derived(selectedPath.endsWith('.html'));
  const hasPreview = $derived(Boolean(selectedViewerHtml || (isHtml && selectedContent) || artifact?.previewHtml));
  const previewLabel = $derived(selectedViewerHtml && selectedPath ? selectedPath : (isHtml && selectedPath ? selectedPath : (artifact?.previewHtml ? 'Generated preview' : 'Preview')));
  const previewBasePath = $derived.by(() => {
    if (selectedViewerHtml && selectedPath) return viewerPathFor(selectedPath);
    if (isHtml && selectedPath) return selectedPath;
    return Object.keys(files).filter((path) => !isHiddenArtifactFile(path)).find((path) => path.endsWith('.html')) || 'index.html';
  });

  function openTab(path: string) {
    if (!openTabs.includes(path)) {
      openTabs = [...openTabs, path];
    }
    selectedPath = path;
  }

  function closeTab(path: string, e?: MouseEvent) {
    e?.stopPropagation();
    const idx = openTabs.indexOf(path);
    if (idx === -1) return;
    openTabs = openTabs.filter(p => p !== path);
    if (selectedPath === path) {
      selectedPath = openTabs[idx] || openTabs[idx - 1] || '';
    }
  }

  function addNewTab() {
    const unused = Object.keys(files).filter(p => !isHiddenArtifactFile(p) && !openTabs.includes(p));
    if (unused.length > 0) {
      openTab(unused[0]);
    }
  }

  $effect(() => {
    const currentKeys = Object.keys(files).filter((key) => !isHiddenArtifactFile(key));
    const validTabs = openTabs.filter((path) => currentKeys.includes(path));
    if (validTabs.length !== openTabs.length) {
      openTabs = validTabs;
    }
    if (!openTabs.length && selectedPath && currentKeys.includes(selectedPath)) {
      openTabs = [selectedPath];
    }
  });

  const previewBuild = $derived.by(() => {
    if (activePane !== 'preview') return { html: '', externalRefs: [] };
    const htmlSource = selectedViewerHtml || (isHtml && selectedContent ? selectedContent : (artifact?.previewHtml || ''));
    if (!htmlSource) return { html: '', externalRefs: [] };
    return buildPreviewHtml(htmlSource, files, previewBasePath);
  });

  const previewSrc = $derived(previewBuild.html);
  const previewExternalRefs = $derived(previewBuild.externalRefs);

  function copyContent() {
    navigator.clipboard.writeText(selectedContent).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1800);
    });
  }

  function downloadSelectedFile() {
    if (!selectedPath || !(selectedPath in files)) return;
    const blob = artifactFileBlob(files[selectedPath]);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = selectedPath.split('/').pop() || 'artifact-file';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function openPreviewInNewWindow() {
    if (!previewSrc) return;
    const blob = new Blob([previewSrc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank', 'width=1200,height=800');
    if (win) {
      win.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    } else {
      URL.revokeObjectURL(url);
    }
  }

  function startEdit() {
    editBuffer = selectedContent;
    editing = true;
  }

  function saveEdit() {
    if (!artifact || !selectedPath) return;
    appStore.setCurrentArtifact({
      ...artifact,
      files: { ...artifact.files, [selectedPath]: editBuffer }
    }, appStore.currentArtifactMessageId, appStore.sandboxOpen);
    editing = false;
  }

  function cancelEdit() {
    editing = false;
  }

  function openNewFileModal(parentPath = '') {
    newItemName = '';
    newItemParent = parentPath;
    showNewFileModal = true;
    setTimeout(() => newItemInput?.focus(), 50);
  }

  function openNewFolderModal(parentPath = '') {
    newItemName = '';
    newItemParent = parentPath;
    showNewFolderModal = true;
    setTimeout(() => newItemInput?.focus(), 50);
  }

  function closeNewItemModal() {
    showNewFileModal = false;
    showNewFolderModal = false;
    newItemName = '';
    newItemParent = '';
  }

  function createFile() {
    if (!newItemName.trim() || !artifact) return;
    const cleanName = newItemName.trim();
    if (!/^[a-zA-Z0-9_.-]+$/.test(cleanName)) {
      toastStore.error('Invalid file name. Use letters, numbers, dots, underscores, hyphens.');
      return;
    }
    const fullPath = newItemParent ? `${newItemParent}/${cleanName}` : cleanName;
    if (files[fullPath]) {
      toastStore.error(`File already exists: ${fullPath}`);
      return;
    }
    const ext = cleanName.split('.').pop()?.toLowerCase() || '';
    let content = '';
    if (['html', 'htm'].includes(ext)) {
      content = `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>${cleanName}</title>\n</head>\n<body>\n  \n</body>\n</html>`;
    } else if (['js', 'mjs'].includes(ext)) {
      content = `// ${cleanName}\n`;
    } else if (ext === 'ts') {
      content = `// ${cleanName}\n`;
    } else if (ext === 'css') {
      content = `/* ${cleanName} */\n`;
    } else if (ext === 'json') {
      content = '{\n  \n}';
    } else if (ext === 'md') {
      content = `# ${cleanName.replace(/\.md$/, '')}\n\n`;
    }
    appStore.setCurrentArtifact({
      ...artifact,
      files: { ...artifact.files, [fullPath]: content }
    }, appStore.currentArtifactMessageId, appStore.sandboxOpen);
    closeNewItemModal();
    openTab(fullPath);
  }

  function createFolder() {
    if (!newItemName.trim() || !artifact) return;
    const cleanName = newItemName.trim().replace(/[/\\:*?"<>|]/g, '-');
    if (!cleanName) {
      toastStore.error('Invalid folder name.');
      return;
    }
    const fullPath = newItemParent ? `${newItemParent}/${cleanName}` : cleanName;
    if (files[fullPath]) {
      toastStore.error(`Name already exists: ${fullPath}`);
      return;
    }
    const markerPath = `${fullPath}/.keep`;
    appStore.setCurrentArtifact({
      ...artifact,
      files: { ...artifact.files, [markerPath]: '' }
    }, appStore.currentArtifactMessageId, appStore.sandboxOpen);
    treeExpanded[fullPath] = true;
    closeNewItemModal();
  }

  function requestDelete(path: string, type: 'file' | 'folder') {
    pendingDeletePath = path;
    pendingDeleteType = type;
    showDeleteConfirm = true;
  }

  function confirmDelete() {
    if (!pendingDeletePath || !artifact) {
      showDeleteConfirm = false;
      return;
    }
    const newFiles = { ...artifact.files };
    if (pendingDeleteType === 'folder') {
      const prefix = pendingDeletePath + '/';
      for (const key of Object.keys(newFiles)) {
        if (key === pendingDeletePath || key.startsWith(prefix)) {
          delete newFiles[key];
        }
      }
    } else {
      delete newFiles[pendingDeletePath];
    }
    appStore.setCurrentArtifact({
      ...artifact,
      files: newFiles
    }, appStore.currentArtifactMessageId, appStore.sandboxOpen);
    if (openTabs.includes(pendingDeletePath)) {
      closeTab(pendingDeletePath);
    }
    if (selectedPath === pendingDeletePath || selectedPath.startsWith(pendingDeletePath + '/')) {
      selectedPath = Object.keys(newFiles)[0] || '';
    }
    showDeleteConfirm = false;
    pendingDeletePath = null;
  }

  function cancelDelete() {
    showDeleteConfirm = false;
    pendingDeletePath = null;
  }

  function requestRename(path: string, type: 'file' | 'folder') {
    pendingRenamePath = path;
    pendingRenameType = type;
    const name = path.split('/').pop() || '';
    renameValue = type === 'folder' ? name : name;
    showRenameModal = true;
    setTimeout(() => {
      renameInput?.focus();
      const dotIndex = type === 'file' ? renameValue.lastIndexOf('.') : -1;
      renameInput?.setSelectionRange(0, dotIndex > 0 ? dotIndex : renameValue.length);
    }, 50);
  }

  function confirmRename() {
    if (!pendingRenamePath || !artifact || !renameValue.trim()) {
      showRenameModal = false;
      return;
    }
    const cleanName = renameValue.trim().replace(/[/\\:*?"<>|]/g, '-');
    if (!cleanName) {
      toastStore.error('Invalid name.');
      return;
    }
    const parentPath = pendingRenamePath.split('/').slice(0, -1).join('/');
    const newPath = parentPath ? `${parentPath}/${cleanName}` : cleanName;
    if (newPath === pendingRenamePath) {
      showRenameModal = false;
      return;
    }
    if (Object.keys(files).includes(newPath)) {
      toastStore.error(`Name already exists: ${newPath}`);
      return;
    }
    const oldPrefix = pendingRenamePath + '/';
    const newFiles: Record<string, string> = {};
    for (const [key, value] of Object.entries(artifact.files)) {
      if (key === pendingRenamePath) {
        newFiles[newPath] = value;
      } else if (key.startsWith(oldPrefix)) {
        newFiles[newPath + key.slice(pendingRenamePath.length)] = value;
      } else {
        newFiles[key] = value;
      }
    }
    appStore.setCurrentArtifact({
      ...artifact,
      files: newFiles
    }, appStore.currentArtifactMessageId, appStore.sandboxOpen);
    const oldTabs = [...openTabs];
    const tabRemap: Record<string, string> = { [pendingRenamePath]: newPath };
    if (pendingRenameType === 'folder') {
      for (const t of oldTabs) {
        if (t === pendingRenamePath) tabRemap[t] = newPath;
        else if (t.startsWith(oldPrefix)) tabRemap[t] = newPath + t.slice(pendingRenamePath.length);
      }
    }
    if (pendingRenamePath === selectedPath) {
      selectedPath = tabRemap[pendingRenamePath] || newPath;
    }
    openTabs = oldTabs.map(t => tabRemap[t] ?? t);
    showRenameModal = false;
    pendingRenamePath = null;
  }

  function cancelRename() {
    showRenameModal = false;
    pendingRenamePath = null;
    renameValue = '';
  }

  function getFileIconComponent(path: string) {
    const ext = path.split('.').pop()?.toLowerCase() || '';
    const map: Record<string, typeof FileCode> = {
      html: FileCode, htm: FileCode,
      css: Palette,
      js: Braces, mjs: Braces, cjs: Braces, ts: Braces, jsx: Braces, tsx: Braces,
      py: FileCode,
      json: Braces,
      md: FileText,
      docx: FileText,
      pdf: FileText,
      xlsx: FileSpreadsheet,
      xls: FileSpreadsheet,
      pptx: Presentation,
      ppt: Presentation,
      svg: Image,
      sh: Terminal, bash: Terminal, zsh: Terminal,
      xml: FileCode,
      yaml: FileText, yml: FileText,
      toml: FileText,
      txt: FileText,
      rb: FileCode, rs: FileCode, go: FileCode, java: FileCode,
      c: FileCode, cpp: FileCode,
    };
    return map[ext] || FileText;
  }

  function toggleFolder(path: string) {
    treeExpanded[path] = !treeExpanded[path];
  }

  function selectFile(path: string) {
    selectedPath = path;
  }

  function renderTree(nodes: TreeNode[], depth = 0): TreeNode[] {
    return nodes;
  }

  async function downloadAsZip() {
    if (!artifact || downloading) return;
    downloading = true;
    try {
      const zip = new JSZip();
      for (const [path, content] of Object.entries(files)) {
        if (isHiddenArtifactFile(path)) continue;
        zip.file(path, artifactFilePayload(content));
      }
      if (artifact.previewHtml) {
        zip.file('preview.html', artifact.previewHtml);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${projectName || 'artifact'}.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toastStore.error(String((error as Error)?.message || error || 'Could not download ZIP'));
    } finally {
      downloading = false;
    }
  }

  onMount(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.source !== 'chateaui-preview' || typeof data.text !== 'string') return;
      const level = data.level === 'warn' || data.level === 'error' ? data.level : 'log';
      previewMessages = [...previewMessages, { level, text: data.text }].slice(-40);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  });
</script>

<div class="sandbox-shell flex h-full w-full flex-col overflow-hidden bg-background">
  <div class="sandbox-topbar flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
    <div class="min-w-0 flex-1">
      <div class="truncate text-xs font-semibold text-foreground">{artifact?.title || 'Sandbox'}</div>
      <div class="text-[10px] text-muted-foreground">{visibleFileCount} file{visibleFileCount !== 1 ? 's' : ''}{#if hasPreview} · preview ready{/if}</div>
    </div>

    <div class="flex items-center gap-0.5">
      {#if hasPreview}
        <button
          type="button"
          class="aui-icon-button size-7 {activePane === 'code' ? 'bg-muted text-foreground' : ''}"
          onclick={() => (activePane = 'code')}
          title="Code"
        ><Code class="size-3.5" /></button>
        <button
          type="button"
          class="aui-icon-button size-7 {activePane === 'preview' ? 'bg-muted text-foreground' : ''}"
          onclick={() => (activePane = 'preview')}
          title="Preview"
        ><Eye class="size-3.5" /></button>
      {/if}
    </div>

    <div class="flex items-center gap-0.5">
      <button type="button" class="aui-icon-button size-7 disabled:opacity-40" onclick={downloadAsZip} title="Download ZIP" disabled={downloading || (!fileList.length && !artifact?.previewHtml)}>
        <Download class="size-3.5" />
      </button>
      {#if selectedPath}
        <button type="button" class="aui-icon-button size-7" onclick={downloadSelectedFile} title="Download selected file">
          <ExternalLink class="size-3.5" />
        </button>
      {/if}
      {#if activePane === 'code' && !editing && !selectedIsBinary}
        <button type="button" class="aui-icon-button size-7" onclick={startEdit} title="Edit file">
          <Pencil class="size-3.5" />
        </button>
      {/if}
      {#if activePane === 'code' && !selectedIsBinary}
        <button type="button" class="aui-icon-button size-7" onclick={copyContent} title="Copy">
          {#if copied}<Check class="size-3.5 text-foreground" />{:else}<Copy class="size-3.5" />{/if}
        </button>
      {/if}
      <button type="button" class="aui-icon-button size-7" onclick={() => (appStore.sandboxOpen = false)} title="Close">
        <X class="size-3.5" />
      </button>
    </div>
  </div>

  <div class="flex min-h-0 flex-1 overflow-hidden">
    {#if fileList.length > 0}
      <div class="sandbox-sidebar flex w-48 shrink-0 flex-col overflow-y-auto border-r border-border/60 bg-muted/20">
        <div class="sandbox-sidebar-actions flex items-center gap-0.5 px-2 py-1.5">
          <button
            type="button"
            class="aui-icon-button size-7"
            onclick={() => openNewFileModal()}
            title="New file"
          >
            <Plus class="size-3.5" />
          </button>
          <button
            type="button"
            class="aui-icon-button size-7"
            onclick={() => openNewFolderModal()}
            title="New folder"
          >
            <Folder class="size-3.5" />
          </button>
        </div>
        <div class="flex-1 overflow-y-auto py-1.5">
          {#if fileList.length === 0}
            <div class="px-3 py-4 text-center text-[11px] text-[var(--text-tertiary)]">
              No files yet
            </div>
          {:else}
            {#each renderTree(fileTree) as node}
              {@render renderTreeNode(node, 0)}
            {/each}
          {/if}
        </div>
      </div>
    {/if}

    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      {#if openTabs.length > 0 && activePane === 'code'}
        <div class="sandbox-tabbar flex items-end overflow-x-auto border-b border-border/60 bg-muted/40" style="min-height:33px">
          {#each openTabs as tab}
            <div class="sandbox-tab group relative flex shrink-0 items-center {selectedPath === tab ? 'is-active bg-background' : 'hover:bg-background/60'}" style="height:33px">
              {#if selectedPath === tab}
                <div class="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground"></div>
              {/if}
              <button
                type="button"
                class="sandbox-tab-button flex h-full items-center gap-1.5 pl-3 pr-1 text-[11px] {selectedPath === tab ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}"
                onclick={() => {
                  activePane = 'code';
                  openTab(tab);
                }}
              >
                <span class="file-icon-tab"><svelte:component this={getFileIconComponent(tab)} class="size-3.5 shrink-0 text-muted-foreground" /></span>
                <span class="max-w-[100px] truncate">{tab.split('/').pop()}</span>
              </button>
              <button
                type="button"
                class="aui-icon-button mr-1 size-6 opacity-0 group-hover:opacity-70 hover:!opacity-100"
                onclick={(e) => { e.stopPropagation(); closeTab(tab); }}
                aria-label="Close {tab}"
              >
                <X class="size-3" />
              </button>
            </div>
          {/each}
        </div>
      {/if}
      {#if fileList.length === 0 && !previewSrc}
        <div class="flex h-full flex-col items-center justify-center gap-3 text-[var(--text-tertiary)]">
          <span class="text-4xl opacity-20">&lt;/&gt;</span>
          <p class="text-sm font-medium">No artifact</p>
        </div>
      {:else if activePane === 'code'}
        {#if editing}
          <div class="flex h-full flex-col">
            <div class="sandbox-code-header flex h-8 shrink-0 items-center justify-between border-b border-border/60 px-4">
              <span class="font-mono text-[11px] text-muted-foreground">{selectedPath} (editing)</span>
              <div class="flex items-center gap-1.5">
                <button type="button" class="aui-btn aui-btn-primary h-7 px-3 text-[11px]" onclick={saveEdit}>Save</button>
                <button type="button" class="aui-btn aui-btn-ghost h-7 px-3 text-[11px]" onclick={cancelEdit}>Cancel</button>
              </div>
            </div>
            <div class="min-h-0 flex-1">
              <CodeEditor
                value={editBuffer}
                language={selectedPath.split('.').pop() || 'plaintext'}
                onchange={(v) => (editBuffer = v)}
              />
            </div>
          </div>
        {:else if selectedIsBinary}
          <div class="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-[var(--text-secondary)]">
            <svelte:component this={getFileIconComponent(selectedPath)} class="h-9 w-9 text-[var(--text-muted)]" />
            <div>
              <p class="text-sm font-medium text-[var(--text)]">{selectedPath}</p>
              <p class="mt-1 text-xs text-[var(--text-muted)]">Binary artifact with a generated viewer.</p>
            </div>
            <div class="flex items-center gap-2">
              {#if hasPreview}
                <button type="button" class="aui-btn aui-btn-ghost h-8 px-3 text-xs" onclick={() => (activePane = 'preview')}>Preview</button>
              {/if}
              <button type="button" class="aui-btn aui-btn-primary h-8 px-3 text-xs" onclick={downloadSelectedFile}>Download</button>
            </div>
          </div>
        {:else}
          <div class="flex h-full flex-col">
            <div class="sandbox-code-header flex h-8 shrink-0 items-center border-b border-border/60 px-4">
              <span class="font-mono text-[11px] text-muted-foreground">{selectedPath}</span>
            </div>
            <div class="min-h-0 flex-1">
              <CodeEditor
                value={selectedContent}
                language={selectedPath.split('.').pop() || 'plaintext'}
                readOnly={true}
              />
            </div>
          </div>
        {/if}
      {:else if activePane === 'preview' && previewSrc}
        <div class="flex h-full w-full flex-col overflow-hidden bg-bg">
          <div class="sandbox-preview-header flex shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2 text-[11px] text-fg">
            <div class="min-w-0 flex-1 truncate font-medium">{previewLabel}</div>
            <div class="flex items-center gap-2">
              {#if previewExternalRefs.length}
                <span class="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] font-medium text-[var(--text-secondary)]">
                  <AlertCircle class="h-3 w-3" /> {previewExternalRefs.length} external
                </span>
              {/if}
              <button class="rounded-md p-1 text-fg-ter transition hover:bg-overlay-light hover:text-fg" onclick={openPreviewInNewWindow} title="Open in new window">
                <ExternalLink class="h-3.5 w-3.5" />
              </button>
              <button class="rounded-md p-1 text-fg-ter transition hover:bg-overlay-light hover:text-fg" onclick={() => (previewRefreshKey += 1)} title="Reload preview">
                <RefreshCw class="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div class="min-h-0 flex-1 overflow-hidden">
            {#key `${previewRefreshKey}:${previewSrc}`}
              <iframe
                class="h-full w-full border-0"
                srcdoc={previewSrc}
                sandbox="allow-scripts allow-forms allow-modals allow-popups"
                title="Preview"
              ></iframe>
            {/key}
          </div>
          {#if previewExternalRefs.length || previewMessages.length}
            <div class="max-h-36 shrink-0 overflow-auto border-t border-border bg-surface px-3 py-2 font-mono text-[11px]">
              {#if previewExternalRefs.length}
                <div class="mb-2 text-fg-secondary">Remote assets stay linked for preview:</div>
                {#each previewExternalRefs as ref}
                  <div class="truncate text-fg-ter">{ref}</div>
                {/each}
              {/if}
              {#if previewMessages.length}
                <div class={`space-y-1 ${previewExternalRefs.length ? 'mt-3 border-t border-border-lt pt-2' : ''}`}>
                  {#each previewMessages as log}
                    <div class={`${log.level === 'error' ? 'text-error' : log.level === 'warn' ? 'text-warning' : 'text-fg'} whitespace-pre-wrap break-words`}>{log.text}</div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {:else if activePane === 'preview'}
        <div class="flex h-full flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-fg-ter">
          <span class="text-4xl opacity-20">&lt;/&gt;</span>
          <p class="text-sm font-medium text-fg">No preview</p>
        </div>
      {/if}
    </div>
  </div>
</div>

{#if showNewFileModal}
  <div class="aui-modal-backdrop z-[100]" onclick={closeNewItemModal} role="dialog" aria-modal="true" tabindex="-1">
    <div class="aui-modal-surface max-w-xs p-4" onclick={(e) => e.stopPropagation()}>
      {#if newItemParent}
        <p class="mb-2 text-[11px] text-muted-foreground">in: {newItemParent}</p>
      {/if}
      <input
        bind:this={newItemInput}
        bind:value={newItemName}
        type="text"
        placeholder="filename.ext"
        class="aui-input mb-4"
        onkeydown={(e) => { if (e.key === 'Enter') createFile(); if (e.key === 'Escape') closeNewItemModal(); }}
      />
      <div class="flex justify-end gap-2">
        <button type="button" class="aui-btn aui-btn-ghost h-8 px-3 text-xs" onclick={closeNewItemModal}>Cancel</button>
        <button type="button" class="aui-btn aui-btn-primary h-8 px-3 text-xs" onclick={createFile}>Create</button>
      </div>
    </div>
  </div>
{/if}

{#if showNewFolderModal}
  <div class="aui-modal-backdrop z-[100]" onclick={closeNewItemModal} role="dialog" aria-modal="true" tabindex="-1">
    <div class="aui-modal-surface max-w-xs p-4" onclick={(e) => e.stopPropagation()}>
      {#if newItemParent}
        <p class="mb-2 text-[11px] text-muted-foreground">in: {newItemParent}</p>
      {/if}
      <input
        bind:this={newItemInput}
        bind:value={newItemName}
        type="text"
        placeholder="folder-name"
        class="aui-input mb-4"
        onkeydown={(e) => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') closeNewItemModal(); }}
      />
      <div class="flex justify-end gap-2">
        <button type="button" class="aui-btn aui-btn-ghost h-8 px-3 text-xs" onclick={closeNewItemModal}>Cancel</button>
        <button type="button" class="aui-btn aui-btn-primary h-8 px-3 text-xs" onclick={createFolder}>Create</button>
      </div>
    </div>
  </div>
{/if}

{#if showDeleteConfirm}
  <div class="aui-modal-backdrop z-[100]" onclick={cancelDelete} role="dialog" aria-modal="true" tabindex="-1">
    <div class="aui-modal-surface max-w-xs p-4" onclick={(e) => e.stopPropagation()}>
      <p class="mb-4 text-sm text-muted-foreground">
        Delete {pendingDeleteType} "<span class="font-mono text-foreground">{pendingDeletePath}</span>"?
        {#if pendingDeleteType === 'folder'}<br><span class="text-xs text-muted-foreground">This will delete all files inside.</span>{/if}
      </p>
      <div class="flex justify-end gap-2">
        <button type="button" class="aui-btn aui-btn-ghost h-8 px-3 text-xs" onclick={cancelDelete}>Cancel</button>
        <button type="button" class="aui-btn aui-btn-danger h-8 px-3 text-xs" onclick={confirmDelete}>Delete</button>
      </div>
    </div>
  </div>
{/if}

{#if showRenameModal}
  <div class="aui-modal-backdrop z-[100]" onclick={cancelRename} role="dialog" aria-modal="true" tabindex="-1">
    <div class="aui-modal-surface max-w-xs p-4" onclick={(e) => e.stopPropagation()}>
      <p class="mb-2 text-[11px] text-muted-foreground">Current: {pendingRenamePath}</p>
      <input
        bind:this={renameInput}
        bind:value={renameValue}
        type="text"
        class="aui-input mb-4"
        onkeydown={(e) => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') cancelRename(); }}
      />
      <div class="flex justify-end gap-2">
        <button type="button" class="aui-btn aui-btn-ghost h-8 px-3 text-xs" onclick={cancelRename}>Cancel</button>
        <button type="button" class="aui-btn aui-btn-primary h-8 px-3 text-xs" onclick={confirmRename}>Rename</button>
      </div>
    </div>
  </div>
{/if}

{#snippet renderTreeNode(node: TreeNode, depth: number)}
  {#if node.type === 'folder'}
    <div class="group/folder">
      <div class="flex items-center">
        <button
          class="flex flex-1 items-center gap-1 px-2.5 py-1.5 text-left transition hover:bg-[var(--surface-hover)]"
          style="padding-left: {8 + depth * 12}px"
          onclick={() => toggleFolder(node.path)}
        >
          <ChevronRight class={`h-3 w-3 shrink-0 text-[var(--text-tertiary)] transition-transform duration-150 ${treeExpanded[node.path] ? 'rotate-90' : ''}`} />
          <Folder class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
          <span class="truncate text-[11px] font-medium text-[var(--text-secondary)]">{node.name}</span>
        </button>
        <div class="flex items-center gap-0.5 px-1">
          <button
            class="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)]"
            onclick={(e) => { e.stopPropagation(); openNewFileModal(node.path); }}
            title="New file in folder"
          >
            <Plus class="h-3 w-3" />
          </button>
          <button
            class="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)]"
            onclick={(e) => { e.stopPropagation(); requestRename(node.path, 'folder'); }}
            title="Rename folder"
          >
            <Pencil class="h-3 w-3" />
          </button>
          <button
            class="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)]"
            onclick={(e) => { e.stopPropagation(); requestDelete(node.path, 'folder'); }}
            title="Delete folder"
          >
            <Trash2 class="h-3 w-3" />
          </button>
        </div>
      </div>
      {#if treeExpanded[node.path] && node.children}
        {#each node.children as child}
          {@render renderTreeNode(child, depth + 1)}
        {/each}
      {/if}
    </div>
  {:else}
    <div class="group/file flex items-center">
      <button
        class="flex flex-1 items-center gap-2 px-2.5 py-1.5 text-left transition {selectedPath === node.path ? 'bg-[var(--surface-hover)] text-[var(--text)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]'}"
        style="padding-left: {20 + depth * 12}px"
        onclick={() => {
          activePane = 'code';
          openTab(node.path);
        }}
      >
        <span class="file-icon-tree"><svelte:component this={getFileIconComponent(node.path)} class="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" /></span>
        <span class="truncate text-[11px]">{node.name}</span>
      </button>
      <button
        class="rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)]"
        onclick={(e) => { e.stopPropagation(); requestRename(node.path, 'file'); }}
        title="Rename file"
      >
        <Pencil class="h-3 w-3" />
      </button>
      <button
        class="mr-1 rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-hover)]"
        onclick={(e) => { e.stopPropagation(); requestDelete(node.path, 'file'); }}
        title="Delete file"
      >
        <Trash2 class="h-3 w-3" />
      </button>
    </div>
  {/if}
{/snippet}

<style>
  .sandbox-shell {
    background: var(--surface);
  }

  .sandbox-shell button {
    border-color: transparent;
    box-shadow: none;
  }

  .sandbox-shell button:focus-visible {
    outline: 2px solid var(--accent-soft);
    outline-offset: 2px;
  }

  .sandbox-topbar,
  .sandbox-sidebar-actions,
  .sandbox-code-header,
  .sandbox-preview-header {
    background: transparent;
    border-color: color-mix(in srgb, var(--border) 70%, transparent);
  }

  .sandbox-sidebar {
    background: color-mix(in srgb, var(--surface) 82%, transparent);
    border-color: color-mix(in srgb, var(--border) 70%, transparent);
  }

  .sandbox-tabbar {
    min-height: 2rem !important;
    align-items: center;
    gap: 0.125rem;
    background: transparent;
    padding: 0.2rem 0.35rem 0;
    border-color: color-mix(in srgb, var(--border) 70%, transparent);
  }

  .sandbox-tab {
    height: 1.7rem !important;
    border-right: 0;
    border-radius: var(--radius-sm);
    background: transparent;
  }

  .sandbox-tab:hover,
  .sandbox-tab.is-active {
    background: color-mix(in srgb, var(--surface-hover) 72%, transparent);
  }

  .sandbox-tab > .absolute {
    display: none;
  }

  .sandbox-tab-button {
    padding-left: 0.55rem;
    padding-right: 0.25rem;
  }

  .sandbox-code {
    background: var(--surface);
    color: var(--text);
  }
  .line-numbers {
    min-width: 2.5rem;
  }
  .line-numbers > div {
    height: 1.21875rem;
  }
  :global(.dark) .sandbox-code :global(.hljs-keyword) { color: #ff7b72; }
  :global(.dark) .sandbox-code :global(.hljs-string) { color: #a5d6ff; }
  :global(.dark) .sandbox-code :global(.hljs-comment) { color: #8b949e; }
  :global(.dark) .sandbox-code :global(.hljs-number) { color: #79c0ff; }
  :global(.dark) .sandbox-code :global(.hljs-function) { color: #d2a8ff; }
  :global(.dark) .sandbox-code :global(.hljs-built_in) { color: #ffa657; }
  :global(.dark) .sandbox-code :global(.hljs-title) { color: #d2a8ff; }
  :global(.dark) .sandbox-code :global(.hljs-attr) { color: #79c0ff; }
  :global(.dark) .sandbox-code :global(.hljs-tag) { color: #7ee787; }
  :global(.dark) .sandbox-code :global(.hljs-name) { color: #7ee787; }
  :global(.dark) .sandbox-code :global(.hljs-attribute) { color: #79c0ff; }
  :global(.dark) .sandbox-code :global(.hljs-selector-class) { color: #d2a8ff; }
  :global(.dark) .sandbox-code :global(.hljs-selector-tag) { color: #7ee787; }
  :global(.dark) .sandbox-code :global(.hljs-property) { color: #79c0ff; }
  :global(.dark) .sandbox-code :global(.hljs-literal) { color: #79c0ff; }
  :global(.dark) .sandbox-code :global(.hljs-type) { color: #ffa657; }
  :global(.dark) .sandbox-code :global(.hljs-params) { color: #e6edf3; }

  .file-icon-tab svg {
    height: 0.875rem;
    width: 0.875rem;
    flex-shrink: 0;
    color: var(--text-muted);
    opacity: 0.55;
  }
  .file-icon-tree svg {
    height: 0.875rem;
    width: 0.875rem;
    flex-shrink: 0;
    color: var(--text-muted);
  }
</style>
