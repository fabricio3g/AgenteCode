<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { AlertCircle, Check, ChevronRight, Copy, Download, ExternalLink, Folder, FolderOpen, Pencil, Play, Plus, RefreshCw, Trash2, X, FilePlus } from 'lucide-svelte';
  import JSZip from 'jszip';
  import hljs from 'highlight.js';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { sandboxExec } from '$lib/services/sandbox';
  import { isTauri } from '$lib/services/tauri';
  import CodeEditor from '$lib/ui/components/CodeEditor.svelte';

  type TreeNode = { name: string; path: string; type: 'file' | 'folder'; children?: TreeNode[]; expanded?: boolean };
  type PreviewLog = { level: 'log' | 'warn' | 'error'; text: string };
  type PreviewBuild = { html: string; externalRefs: string[] };

  const TEXT_ASSET_EXTENSIONS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'json', 'svg', 'txt', 'md', 'xml', 'webmanifest']);
  const MIME_BY_EXT: Record<string, string> = {
    html: 'text/html;charset=utf-8',
    htm: 'text/html;charset=utf-8',
    css: 'text/css;charset=utf-8',
    js: 'text/javascript;charset=utf-8',
    mjs: 'text/javascript;charset=utf-8',
    cjs: 'text/javascript;charset=utf-8',
    ts: 'text/plain;charset=utf-8',
    jsx: 'text/plain;charset=utf-8',
    tsx: 'text/plain;charset=utf-8',
    json: 'application/json;charset=utf-8',
    svg: 'image/svg+xml;charset=utf-8',
    txt: 'text/plain;charset=utf-8',
    md: 'text/markdown;charset=utf-8',
    xml: 'application/xml;charset=utf-8',
    webmanifest: 'application/manifest+json;charset=utf-8'
  };

  let selectedPath = $state('');
  let activePane = $state<'code' | 'preview' | 'terminal'>('code');
  let copied = $state(false);
  let downloading = $state(false);
  let editing = $state(false);
  let editBuffer = $state('');
  let treeExpanded = $state<Record<string, boolean>>({});
  let openTabs = $state<string[]>([]);

  let terminalCommand = $state('');
  let terminalOutput = $state<Array<{ cmd: string; stdout: string; stderr: string; code: number | null; timedOut: boolean }>>([]);
  let terminalRunning = $state(false);
  let terminalEl = $state<HTMLDivElement | undefined>(undefined);
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
    const paths = Object.keys(files).sort();

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

  const fileList = $derived(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));

  let prevArtifactFileKeys = $state('');
  let prevPreviewHtml = $state('');

  $effect(() => {
    const currentKeys = Object.keys(files).sort().join('|');
    const currentPreviewHtml = artifact?.previewHtml || '';
    if (currentKeys === prevArtifactFileKeys && currentPreviewHtml === prevPreviewHtml) return;
    const oldKeys = prevArtifactFileKeys;
    prevArtifactFileKeys = currentKeys;
    prevPreviewHtml = currentPreviewHtml;

    if (!Object.keys(files).length) {
      selectedPath = '';
      if (artifact?.previewHtml) activePane = 'preview';
      return;
    }

    const htmlFile = Object.keys(files).find((path) => path.endsWith('.html'));
    const isNewHtml = htmlFile && !oldKeys.split('|').filter(Boolean).includes(htmlFile);

    if (!selectedPath || !files[selectedPath]) {
      selectedPath = htmlFile ?? Object.keys(files)[0] ?? '';
      if (htmlFile || artifact?.previewHtml) activePane = 'preview';
    } else if (isNewHtml) {
      selectedPath = htmlFile;
      activePane = 'preview';
    } else if (!htmlFile && artifact?.previewHtml && activePane !== 'terminal') {
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
  const isHtml = $derived(selectedPath.endsWith('.html'));
  const hasPreview = $derived(Boolean((isHtml && selectedContent) || artifact?.previewHtml));
  const previewLabel = $derived(isHtml && selectedPath ? selectedPath : (artifact?.previewHtml ? 'Generated preview' : 'Preview'));
  const previewBasePath = $derived.by(() => {
    if (isHtml && selectedPath) return selectedPath;
    return Object.keys(files).find((path) => path.endsWith('.html')) || 'index.html';
  });

  function openTab(path: string) {
    if (!openTabs.includes(path)) {
      openTabs = [...openTabs, path];
    }
    selectedPath = path;
    activePane = 'code';
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
    const unused = Object.keys(files).filter(p => !openTabs.includes(p));
    if (unused.length > 0) {
      openTab(unused[0]);
    }
  }

  $effect(() => {
    const currentKeys = Object.keys(files).filter(k => !k.startsWith('__'));
    // Add any new files that aren't already open as tabs
    const newFiles = currentKeys.filter(p => !openTabs.includes(p));
    if (newFiles.length > 0) {
      openTabs = [...openTabs, ...newFiles];
    }
    // Remove tabs for files that no longer exist
    const validTabs = openTabs.filter(p => p in files);
    if (validTabs.length !== openTabs.length) {
      openTabs = validTabs;
    }
  });

  function normalizePath(path: string): string {
    const normalized: string[] = [];
    for (const part of path.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        normalized.pop();
        continue;
      }
      normalized.push(part);
    }
    return normalized.join('/');
  }

  function dirname(path: string): string {
    const parts = normalizePath(path).split('/');
    parts.pop();
    return parts.join('/');
  }

  function isExternalResource(ref: string): boolean {
    return /^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(ref) || /^[a-z][a-z\d+.-]*:/i.test(ref);
  }

  function resolveArtifactPath(basePath: string, ref: string): string | null {
    const cleaned = ref.trim().split(/[?#]/)[0] || '';
    if (!cleaned || cleaned.startsWith('#') || cleaned.startsWith('data:') || isExternalResource(cleaned)) return null;
    if (cleaned.startsWith('/')) return normalizePath(cleaned.slice(1));
    const baseDir = dirname(basePath);
    return normalizePath(baseDir ? `${baseDir}/${cleaned}` : cleaned);
  }

  function encodeBase64(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  function buildAssetDataUrl(path: string, content: string): string | null {
    if (content.startsWith('data:')) return content;
    const ext = path.split('.').pop()?.toLowerCase() || '';
    if (!TEXT_ASSET_EXTENSIONS.has(ext)) return null;
    const mime = MIME_BY_EXT[ext];
    if (!mime) return null;
    return `data:${mime};base64,${encodeBase64(content)}`;
  }

  function recordExternalRef(externalRefs: string[], ref: string) {
    if (!externalRefs.includes(ref)) externalRefs.push(ref);
  }

  function rewriteCssAssetUrls(css: string, cssPath: string, allFiles: Record<string, string>, externalRefs: string[]): string {
    return css.replace(/url\(([^)]+)\)/g, (match, rawValue: string) => {
      const ref = rawValue.trim().replace(/^['"]|['"]$/g, '');
      if (!ref || ref.startsWith('#') || ref.startsWith('data:')) return match;
      if (isExternalResource(ref)) {
        recordExternalRef(externalRefs, ref);
        return match;
      }
      const resolved = resolveArtifactPath(cssPath, ref);
      const content = resolved ? allFiles[resolved] : null;
      const dataUrl = resolved && content ? buildAssetDataUrl(resolved, content) : null;
      return dataUrl ? `url("${dataUrl}")` : match;
    });
  }

  function buildPreviewBridgeScript(): string {
    return `(() => {
  const send = (level, args) => {
    try {
      parent.postMessage({
        source: 'openui-preview',
        level,
        text: args.map((value) => {
          if (typeof value === 'string') return value;
          try { return JSON.stringify(value); } catch { return String(value); }
        }).join(' ')
      }, '*');
    } catch {}
  };

  ['log', 'warn', 'error'].forEach((level) => {
    const original = console[level];
    console[level] = (...args) => {
      send(level, args);
      return original.apply(console, args);
    };
  });

  window.addEventListener('error', (event) => {
    send('error', [event.message || 'Preview error']);
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason || 'Unhandled promise rejection');
    send('error', [reason]);
  });
})();`;
  }

  function inlineAssets(html: string, allFiles: Record<string, string>, basePath: string): PreviewBuild {
    const externalRefs: string[] = [];
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    doc.querySelectorAll('link[href]').forEach((link) => {
      const href = link.getAttribute('href');
      if (!href) return;
      if (isExternalResource(href)) {
        recordExternalRef(externalRefs, href);
        return;
      }
      const resolved = resolveArtifactPath(basePath, href);
      if (resolved && allFiles[resolved] && (((link.getAttribute('rel') || '').includes('stylesheet')) || resolved.endsWith('.css'))) {
        const style = doc.createElement('style');
        style.textContent = `/* ${resolved} */\n${rewriteCssAssetUrls(allFiles[resolved], resolved, allFiles, externalRefs)}`;
        link.replaceWith(style);
        return;
      }
      const dataUrl = resolved && allFiles[resolved] ? buildAssetDataUrl(resolved, allFiles[resolved]) : null;
      if (dataUrl) link.setAttribute('href', dataUrl);
    });

    doc.querySelectorAll('style').forEach((styleEl) => {
      styleEl.textContent = rewriteCssAssetUrls(styleEl.textContent || '', basePath, allFiles, externalRefs);
    });

    doc.querySelectorAll('script[src]').forEach((scriptEl) => {
      const script = scriptEl as HTMLScriptElement;
      const src = script.getAttribute('src');
      if (!src) return;
      if (isExternalResource(src)) {
        recordExternalRef(externalRefs, src);
        return;
      }
      const resolved = resolveArtifactPath(basePath, src);
      if (!resolved || !allFiles[resolved]) return;

      const inline = doc.createElement('script');
      if (script.type) inline.type = script.type;
      if (script.noModule) inline.noModule = true;
      if (script.hasAttribute('defer')) inline.setAttribute('defer', '');
      if (script.hasAttribute('async')) inline.setAttribute('async', '');
      inline.textContent = `/* ${resolved} */\n${allFiles[resolved]}`;
      script.replaceWith(inline);
    });

    const assetTargets: Array<[string, string]> = [
      ['img[src]', 'src'],
      ['source[src]', 'src'],
      ['audio[src]', 'src'],
      ['video[poster]', 'poster'],
      ['link[rel="icon"][href]', 'href']
    ];

    for (const [selector, attribute] of assetTargets) {
      doc.querySelectorAll(selector).forEach((element) => {
        const ref = element.getAttribute(attribute);
        if (!ref || ref.startsWith('data:') || ref.startsWith('#')) return;
        if (isExternalResource(ref)) {
          recordExternalRef(externalRefs, ref);
          return;
        }
        const resolved = resolveArtifactPath(basePath, ref);
        const content = resolved ? allFiles[resolved] : null;
        const dataUrl = resolved && content ? buildAssetDataUrl(resolved, content) : null;
        if (dataUrl) element.setAttribute(attribute, dataUrl);
      });
    }

    let head = doc.querySelector('head');
    if (!head) {
      head = doc.createElement('head');
      const htmlEl = doc.querySelector('html') || doc.documentElement;
      htmlEl.insertBefore(head, htmlEl.firstChild);
    }

    if (!doc.querySelector('meta[charset]')) {
      const charset = doc.createElement('meta');
      charset.setAttribute('charset', 'utf-8');
      head.insertBefore(charset, head.firstChild);
    }

    if (!doc.querySelector('meta[name="viewport"]')) {
      const viewport = doc.createElement('meta');
      viewport.setAttribute('name', 'viewport');
      viewport.setAttribute('content', 'width=device-width, initial-scale=1');
      head.appendChild(viewport);
    }

    const bridgeScript = doc.createElement('script');
    bridgeScript.textContent = buildPreviewBridgeScript();
    (doc.body || doc.documentElement).appendChild(bridgeScript);

    return { html: '<!DOCTYPE html>' + doc.documentElement.outerHTML, externalRefs };
  }

  const previewBuild = $derived.by(() => {
    const htmlSource = isHtml && selectedContent ? selectedContent : (artifact?.previewHtml || '');
    if (!htmlSource) return { html: '', externalRefs: [] } satisfies PreviewBuild;
    return inlineAssets(htmlSource, files, previewBasePath);
  });

  const previewSrc = $derived(previewBuild.html);
  const previewExternalRefs = $derived(previewBuild.externalRefs);

  const highlightedCode = $derived.by(() => {
    if (!selectedContent) return '';
    const ext = selectedPath.split('.').pop() || '';
    const langMap: Record<string, string> = {
      js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
      html: 'xml', css: 'css', py: 'python', json: 'json', md: 'markdown', sh: 'bash',
      rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp', rb: 'ruby', svg: 'xml'
    };
    const lang = langMap[ext];
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(selectedContent, { language: lang }).value;
      return hljs.highlightAuto(selectedContent).value;
    } catch {
      return selectedContent.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
  });

  const lineCount = $derived(selectedContent ? selectedContent.split('\n').length : 0);

  function copyContent() {
    navigator.clipboard.writeText(selectedContent).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1800);
    });
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

  function getFileIcon(path: string) {
    const ext = path.split('.').pop() || '';
    const icons: Record<string, string> = {
      html: 'o', css: '*', js: '~', ts: '~', py: 'py', json: '{ }', md: 'md', sh: '>',
      rs: 'rs', go: 'go', java: 'jv', c: 'c', cpp: 'c++', rb: 'rb', svg: 'svg'
    };
    return icons[ext] || 'file';
  }

  function toggleFolder(path: string) {
    treeExpanded[path] = !treeExpanded[path];
  }

  function selectFile(path: string) {
    selectedPath = path;
    if (activePane === 'terminal') activePane = 'code';
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
        zip.file(path, content);
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

  async function runCommand() {
    const cmd = terminalCommand.trim();
    if (!cmd || terminalRunning || !isTauri()) return;
    terminalRunning = true;
    try {
      const result = await sandboxExec({
        project_name: projectName,
        files: artifact?.files || {},
        command: cmd,
        shell: true,
        timeout_ms: 30000
      });
      terminalOutput = [...terminalOutput, {
        cmd,
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.exit_code ?? null,
        timedOut: result.timed_out
      }];
      if (artifact) {
        appStore.setCurrentArtifact({
          ...artifact,
          files: { ...result.files }
        }, appStore.currentArtifactMessageId, appStore.sandboxOpen);
      }
      terminalCommand = '';
      requestAnimationFrame(() => {
        terminalEl?.scrollTo({ top: terminalEl.scrollHeight });
      });
    } catch (err) {
      terminalOutput = [...terminalOutput, {
        cmd,
        stdout: '',
        stderr: String((err as Error)?.message || err),
        code: -1,
        timedOut: false
      }];
    } finally {
      terminalRunning = false;
    }
  }

  function handleTerminalKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      runCommand();
    }
  }

  onMount(() => {
    const handleMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.source !== 'openui-preview' || typeof data.text !== 'string') return;
      const level = data.level === 'warn' || data.level === 'error' ? data.level : 'log';
      previewMessages = [...previewMessages, { level, text: data.text }].slice(-40);
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  });
</script>

<div class="flex h-full w-full flex-col overflow-hidden bg-[var(--surface)]">
  <div class="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
    <span class="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--text)]">{artifact?.title || 'Sandbox'}</span>

    <div class="flex items-center gap-0.5 rounded-lg bg-[var(--surface-highlight)] p-0.5">
      <button
        class={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${activePane === 'code' ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm' : 'text-[var(--text-tertiary)] hover:text-[var(--text)]'}`}
        onclick={() => (activePane = 'code')}
      >Code</button>
      {#if hasPreview}
        <button
          class={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${activePane === 'preview' ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm' : 'text-[var(--text-tertiary)] hover:text-[var(--text)]'}`}
          onclick={() => (activePane = 'preview')}
        >Preview</button>
      {/if}
      {#if isTauri()}
        <button
          class={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${activePane === 'terminal' ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm' : 'text-[var(--text-tertiary)] hover:text-[var(--text)]'}`}
          onclick={() => (activePane = 'terminal')}
        >Terminal</button>
      {/if}
    </div>

    <div class="flex items-center gap-0.5">
      <button class="rounded-md p-1.5 text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)] disabled:opacity-40" onclick={downloadAsZip} title="Download ZIP" disabled={downloading || (!fileList.length && !artifact?.previewHtml)}>
        <Download class="h-3.5 w-3.5" />
      </button>
      {#if activePane === 'code' && !editing}
        <button class="rounded-md p-1.5 text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]" onclick={startEdit} title="Edit file">
          <Pencil class="h-3.5 w-3.5" />
        </button>
      {/if}
      {#if activePane === 'code'}
        <button class="rounded-md p-1.5 text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]" onclick={copyContent} title="Copy">
          {#if copied}<Check class="h-3.5 w-3.5 text-emerald-500" />{:else}<Copy class="h-3.5 w-3.5" />{/if}
        </button>
      {/if}
      {#if activePane === 'preview' && previewSrc}
        <button class="rounded-md p-1.5 text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]" onclick={() => (previewRefreshKey += 1)} title="Reload preview">
          <RefreshCw class="h-3.5 w-3.5" />
        </button>
      {/if}
      <button class="rounded-md p-1.5 text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]" onclick={() => (appStore.sandboxOpen = false)} title="Close">
        <X class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>

  <div class="flex min-h-0 flex-1 overflow-hidden">
    {#if (fileList.length > 0 || true) && activePane !== 'terminal'}
      <div class="flex w-52 shrink-0 flex-col overflow-y-auto border-r border-[var(--border)]">
        <div class="flex items-center justify-between px-2.5 py-2 border-b border-[var(--border)]">
          <span class="text-[11px] font-medium text-[var(--text-secondary)]">Files</span>
          <div class="flex items-center gap-0.5">
            <button
              class="rounded p-1 text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]"
              onclick={() => openNewFileModal()}
              title="New file"
            >
              <FilePlus class="h-3.5 w-3.5" />
            </button>
            <button
              class="rounded p-1 text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]"
              onclick={() => openNewFolderModal()}
              title="New folder"
            >
              <Folder class="h-3.5 w-3.5" />
            </button>
          </div>
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
        <div class="flex items-end overflow-x-auto border-b border-[var(--border)] bg-[var(--surface-highlight)]" style="min-height:33px">
          {#each openTabs as tab}
            <div class="group relative flex shrink-0 items-center border-r border-[var(--border)] {selectedPath === tab ? 'bg-[var(--surface)]' : 'hover:bg-[var(--surface)]'}" style="height:33px">
              {#if selectedPath === tab}
                <div class="absolute inset-x-0 top-0 h-[2px] bg-[var(--primary)]"></div>
              {/if}
              <button
                type="button"
                class="flex h-full items-center gap-1.5 pl-3 pr-1 text-[11px] {selectedPath === tab ? 'text-[var(--text)]' : 'text-[var(--text-tertiary)] hover:text-[var(--text)]'}"
                onclick={() => openTab(tab)}
              >
                <span class="font-mono opacity-50 text-[10px]">{getFileIcon(tab)}</span>
                <span class="max-w-[100px] truncate">{tab.split('/').pop()}</span>
              </button>
              <button
                type="button"
                class="mr-1.5 ml-0.5 flex shrink-0 items-center rounded p-0.5 text-[var(--text-tertiary)] opacity-0 transition group-hover:opacity-60 hover:!opacity-100 hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]"
                onclick={(e) => { e.stopPropagation(); closeTab(tab); }}
                aria-label="Close {tab}"
              >
                <X class="h-3 w-3" />
              </button>
            </div>
          {/each}
          {#if Object.keys(files).filter(p => !openTabs.includes(p)).length > 0}
            <button
              type="button"
              class="flex shrink-0 items-center justify-center px-2 text-[var(--text-tertiary)] opacity-50 transition hover:opacity-100 hover:text-[var(--text)]"
              style="height:33px"
              onclick={addNewTab}
              title="Open another file"
            >
              <span class="text-base leading-none">+</span>
            </button>
          {/if}
        </div>
      {/if}
      {#if fileList.length === 0 && !previewSrc}
        <div class="flex h-full flex-col items-center justify-center gap-3 text-[var(--text-tertiary)]">
          <span class="text-4xl opacity-20">&lt;/&gt;</span>
          <p class="text-sm font-medium">No artifact yet</p>
          <p class="text-xs opacity-60">Ask the assistant to build something</p>
        </div>
      {:else if activePane === 'code'}
        {#if editing}
          <div class="flex h-full flex-col">
            <div class="flex h-8 shrink-0 items-center justify-between border-b border-[var(--border)] px-4">
              <span class="text-[11px] font-mono text-[var(--text-tertiary)]">{selectedPath} (editing)</span>
              <div class="flex items-center gap-1.5">
                <button
                  class="rounded-lg bg-emerald-600 px-3 py-1 text-[11px] font-medium text-white transition hover:bg-emerald-500"
                  onclick={saveEdit}
                >Save</button>
                <button
                  class="rounded-lg border border-[var(--border)] px-3 py-1 text-[11px] text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)]"
                  onclick={cancelEdit}
                >Cancel</button>
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
        {:else}
          <div class="flex h-full flex-col">
            <div class="flex h-8 shrink-0 items-center border-b border-[var(--border)] px-4">
              <span class="text-[11px] font-mono text-[var(--text-tertiary)]">{selectedPath}</span>
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
        <div class="flex h-full w-full flex-col overflow-hidden bg-white">
          <div class="flex shrink-0 items-center justify-between gap-3 border-b border-black/8 px-3 py-2 text-[11px] text-neutral-700">
            <div class="min-w-0 flex-1 truncate font-medium">{previewLabel}</div>
            <div class="flex items-center gap-2">
              {#if previewExternalRefs.length}
                <span class="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                  <AlertCircle class="h-3 w-3" /> {previewExternalRefs.length} external
                </span>
              {/if}
              <button class="rounded-md p-1 text-neutral-500 transition hover:bg-black/5 hover:text-neutral-900" onclick={openPreviewInNewWindow} title="Open in new window">
                <ExternalLink class="h-3.5 w-3.5" />
              </button>
              <button class="rounded-md p-1 text-neutral-500 transition hover:bg-black/5 hover:text-neutral-900" onclick={() => (previewRefreshKey += 1)} title="Reload preview">
                <RefreshCw class="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div class="min-h-0 flex-1 overflow-hidden">
            {#key `${previewRefreshKey}:${previewSrc}`}
              <iframe
                class="h-full w-full border-0"
                srcdoc={previewSrc}
                sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
                title="Preview"
              ></iframe>
            {/key}
          </div>
          {#if previewExternalRefs.length || previewMessages.length}
            <div class="max-h-36 shrink-0 overflow-auto border-t border-black/8 bg-neutral-50 px-3 py-2 font-mono text-[11px]">
              {#if previewExternalRefs.length}
                <div class="mb-2 text-neutral-600">Remote assets stay linked for preview:</div>
                {#each previewExternalRefs as ref}
                  <div class="truncate text-neutral-500">{ref}</div>
                {/each}
              {/if}
              {#if previewMessages.length}
                <div class={`space-y-1 ${previewExternalRefs.length ? 'mt-3 border-t border-black/6 pt-2' : ''}`}>
                  {#each previewMessages as log}
                    <div class={`${log.level === 'error' ? 'text-red-600' : log.level === 'warn' ? 'text-amber-700' : 'text-neutral-700'} whitespace-pre-wrap break-words`}>{log.text}</div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {:else if activePane === 'preview'}
        <div class="flex h-full flex-col items-center justify-center gap-3 bg-white px-6 text-center text-neutral-500">
          <span class="text-4xl opacity-20">&lt;/&gt;</span>
          <p class="text-sm font-medium text-neutral-800">No previewable page yet</p>
          <p class="text-xs">Generate an HTML artifact or use the agent's report and preview tools to create one.</p>
        </div>
      {:else if activePane === 'terminal'}
        <div class="flex h-full flex-col bg-[#0a0a0a]">
          <div bind:this={terminalEl} class="flex-1 overflow-y-auto p-4 font-mono text-xs leading-relaxed">
            {#if terminalOutput.length === 0}
              <div class="text-neutral-500">
                <p>Sandbox terminal - files written to project folder.</p>
                <p class="mt-1 text-neutral-600">Run any command: <span class="text-neutral-400">ls, python, node, etc.</span></p>
              </div>
            {/if}
            {#each terminalOutput as entry}
              <div class="mb-3">
                <div class="text-emerald-400"><span class="text-neutral-600">$</span> {entry.cmd}</div>
                {#if entry.stdout}<pre class="mt-1 whitespace-pre-wrap text-neutral-300">{entry.stdout}</pre>{/if}
                {#if entry.stderr}<pre class="mt-1 whitespace-pre-wrap text-red-400">{entry.stderr}</pre>{/if}
                {#if entry.timedOut}<div class="mt-1 text-[11px] text-amber-400">Timed out</div>{/if}
                {#if entry.code !== null && entry.code !== 0 && !entry.timedOut}<div class="text-[11px] text-neutral-600">exit {entry.code}</div>{/if}
              </div>
            {/each}
          </div>
          <div class="flex items-center gap-2 border-t border-white/6 px-4 py-2">
            <span class="text-xs font-mono text-emerald-500">$</span>
            <input
              type="text"
              bind:value={terminalCommand}
              onkeydown={handleTerminalKeydown}
              placeholder="command..."
              disabled={terminalRunning}
              class="flex-1 bg-transparent font-mono text-xs text-neutral-200 outline-none placeholder:text-neutral-600 disabled:opacity-50"
            />
            <button
              class="rounded p-1.5 text-neutral-500 transition hover:text-white disabled:opacity-30"
              onclick={runCommand}
              disabled={terminalRunning || !terminalCommand.trim()}
            >
              {#if terminalRunning}
                <span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border border-neutral-600 border-t-neutral-300"></span>
              {:else}
                <Play class="h-3.5 w-3.5" />
              {/if}
            </button>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>

{#if showNewFileModal}
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onclick={closeNewItemModal} role="dialog" aria-modal="true">
    <div class="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl" onclick={(e) => e.stopPropagation()}>
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-sm font-semibold text-[var(--text)]">New File</h3>
        <button class="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-highlight)]" onclick={closeNewItemModal}>
          <X class="h-4 w-4" />
        </button>
      </div>
      {#if newItemParent}
        <p class="mb-2 text-[11px] text-[var(--text-tertiary)]">in: {newItemParent}</p>
      {/if}
      <input
        bind:this={newItemInput}
        bind:value={newItemName}
        type="text"
        placeholder="filename.ext"
        class="mb-4 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--primary)]"
        onkeydown={(e) => { if (e.key === 'Enter') createFile(); if (e.key === 'Escape') closeNewItemModal(); }}
      />
      <div class="flex justify-end gap-2">
        <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)]" onclick={closeNewItemModal}>Cancel</button>
        <button class="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90" onclick={createFile}>Create</button>
      </div>
    </div>
  </div>
{/if}

{#if showNewFolderModal}
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onclick={closeNewItemModal} role="dialog" aria-modal="true">
    <div class="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl" onclick={(e) => e.stopPropagation()}>
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-sm font-semibold text-[var(--text)]">New Folder</h3>
        <button class="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-highlight)]" onclick={closeNewItemModal}>
          <X class="h-4 w-4" />
        </button>
      </div>
      {#if newItemParent}
        <p class="mb-2 text-[11px] text-[var(--text-tertiary)]">in: {newItemParent}</p>
      {/if}
      <input
        bind:this={newItemInput}
        bind:value={newItemName}
        type="text"
        placeholder="folder-name"
        class="mb-4 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--primary)]"
        onkeydown={(e) => { if (e.key === 'Enter') createFolder(); if (e.key === 'Escape') closeNewItemModal(); }}
      />
      <div class="flex justify-end gap-2">
        <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)]" onclick={closeNewItemModal}>Cancel</button>
        <button class="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90" onclick={createFolder}>Create</button>
      </div>
    </div>
  </div>
{/if}

{#if showDeleteConfirm}
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onclick={cancelDelete} role="dialog" aria-modal="true">
    <div class="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl" onclick={(e) => e.stopPropagation()}>
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-sm font-semibold text-[var(--text)]">Confirm Delete</h3>
        <button class="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-highlight)]" onclick={cancelDelete}>
          <X class="h-4 w-4" />
        </button>
      </div>
      <p class="mb-4 text-sm text-[var(--text-secondary)]">
        Delete {pendingDeleteType} "<span class="font-mono text-[var(--text)]">{pendingDeletePath}</span>"?
        {#if pendingDeleteType === 'folder'}<br><span class="text-xs text-amber-500">This will delete all files inside.</span>{/if}
      </p>
      <div class="flex justify-end gap-2">
        <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)]" onclick={cancelDelete}>Cancel</button>
        <button class="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-red-500" onclick={confirmDelete}>Delete</button>
      </div>
    </div>
  </div>
{/if}

{#if showRenameModal}
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onclick={cancelRename} role="dialog" aria-modal="true">
    <div class="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xl" onclick={(e) => e.stopPropagation()}>
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-sm font-semibold text-[var(--text)]">Rename {pendingRenameType === 'folder' ? 'Folder' : 'File'}</h3>
        <button class="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-highlight)]" onclick={cancelRename}>
          <X class="h-4 w-4" />
        </button>
      </div>
      <p class="mb-2 text-[11px] text-[var(--text-tertiary)]">Current: {pendingRenamePath}</p>
      <input
        bind:this={renameInput}
        bind:value={renameValue}
        type="text"
        class="mb-4 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-highlight)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--primary)]"
        onkeydown={(e) => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') cancelRename(); }}
      />
      <div class="flex justify-end gap-2">
        <button class="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-secondary)] transition hover:bg-[var(--surface-highlight)]" onclick={cancelRename}>Cancel</button>
        <button class="rounded-lg bg-[var(--primary)] px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90" onclick={confirmRename}>Rename</button>
      </div>
    </div>
  </div>
{/if}

{#snippet renderTreeNode(node: TreeNode, depth: number)}
  {#if node.type === 'folder'}
    <div class="group/folder">
      <div class="flex items-center">
        <button
          class="flex flex-1 items-center gap-1 px-2.5 py-1.5 text-left transition hover:bg-[var(--surface-highlight)]"
          style="padding-left: {8 + depth * 12}px"
          onclick={() => toggleFolder(node.path)}
        >
          <ChevronRight class={`h-3 w-3 shrink-0 text-[var(--text-tertiary)] transition-transform duration-150 ${treeExpanded[node.path] ? 'rotate-90' : ''}`} />
          {#if treeExpanded[node.path]}
            <FolderOpen class="h-3.5 w-3.5 shrink-0 text-amber-500" />
          {:else}
            <Folder class="h-3.5 w-3.5 shrink-0 text-amber-500" />
          {/if}
          <span class="truncate text-[11px] font-medium text-[var(--text-secondary)]">{node.name}</span>
        </button>
        <div class="flex items-center gap-0.5 px-1 opacity-0 group-hover/folder:opacity-100 transition">
          <button
            class="rounded p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text)] hover:bg-[var(--surface-highlight)]"
            onclick={(e) => { e.stopPropagation(); openNewFileModal(node.path); }}
            title="New file in folder"
          >
            <FilePlus class="h-3 w-3" />
          </button>
          <button
            class="rounded p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text)] hover:bg-[var(--surface-highlight)]"
            onclick={(e) => { e.stopPropagation(); requestRename(node.path, 'folder'); }}
            title="Rename folder"
          >
            <Pencil class="h-3 w-3" />
          </button>
          <button
            class="rounded p-0.5 text-[var(--text-tertiary)] hover:text-red-400 hover:bg-[var(--surface-highlight)]"
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
        class="flex flex-1 items-center gap-2 px-2.5 py-1.5 text-left transition {selectedPath === node.path ? 'bg-[var(--surface-highlight)] text-[var(--text)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-highlight)]'}"
        style="padding-left: {20 + depth * 12}px"
        onclick={() => selectFile(node.path)}
      >
        <span class="w-4 shrink-0 text-center text-[11px] uppercase">{getFileIcon(node.path)}</span>
        <span class="truncate text-[11px]">{node.name}</span>
      </button>
      <button
        class="rounded p-0.5 text-[var(--text-tertiary)] opacity-0 group-hover/file:opacity-100 transition hover:text-[var(--text)] hover:bg-[var(--surface-highlight)]"
        onclick={(e) => { e.stopPropagation(); requestRename(node.path, 'file'); }}
        title="Rename file"
      >
        <Pencil class="h-3 w-3" />
      </button>
      <button
        class="mr-1 rounded p-0.5 text-[var(--text-tertiary)] opacity-0 group-hover/file:opacity-100 transition hover:text-red-400 hover:bg-[var(--surface-highlight)]"
        onclick={(e) => { e.stopPropagation(); requestDelete(node.path, 'file'); }}
        title="Delete file"
      >
        <Trash2 class="h-3 w-3" />
      </button>
    </div>
  {/if}
{/snippet}

<style>
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
</style>
