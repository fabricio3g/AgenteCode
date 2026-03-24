<svelte:options runes={true} />

<script lang="ts">
  import { fade } from 'svelte/transition';
  import { flyAndScale } from '$lib/utils/transitions';
  import { FileCode2, Eye, Copy, Check, X, ExternalLink, Maximize2, Minimize2 } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import hljs from 'highlight.js';

  let selectedPath = $state('');
  let activePane = $state<'code' | 'preview'>('code');
  let copied = $state(false);
  let fullscreen = $state(false);

  const artifact = $derived(appStore.currentArtifact);
  const files = $derived(Object.entries(artifact?.files || {}).sort(([a], [b]) => a.localeCompare(b)));

  $effect(() => {
    if (!selectedPath && files.length) {
      selectedPath = files[0][0];
    }
  });

  const selectedContent = $derived(artifact?.files?.[selectedPath] || '');
  const isHtml = $derived(selectedPath.endsWith('.html'));

  // Build combined HTML for preview (inlines CSS + JS if found next to index.html)
  const previewSrc = $derived.by(() => {
    if (!isHtml) return '';
    let html = selectedContent;
    // Inline CSS references
    html = html.replace(/href=["']([^"']+\.css)["']/g, (_, ref) => {
      const css = artifact?.files?.[ref];
      if (css) return `style="${css.replace(/"/g, '&quot;')}"`;
      return `href="${ref}"`;
    });
    // Inline script references
    html = html.replace(/<script\s+src=["']([^"']+\.js)["'][^>]*><\/script>/gi, (_, ref) => {
      const js = artifact?.files?.[ref];
      if (js) return `<script>${js}<\/script>`;
      return `<script src="${ref}"><\/script>`;
    });
    return html;
  });

  const highlightedCode = $derived.by(() => {
    if (!selectedContent) return '';
    const ext = selectedPath.split('.').pop() || '';
    const langMap: Record<string, string> = {
      js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
      html: 'html', css: 'css', py: 'python', json: 'json', md: 'markdown', sh: 'bash'
    };
    const lang = langMap[ext];
    try {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(selectedContent, { language: lang }).value;
      }
      return hljs.highlightAuto(selectedContent).value;
    } catch {
      return selectedContent.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
  });

  function copyContent() {
    navigator.clipboard.writeText(selectedContent).then(() => {
      copied = true;
      setTimeout(() => (copied = false), 1800);
    });
  }

  function openInWindow() {
    if (!isHtml) return;
    const w = window.open('about:blank', '_blank', 'width=1024,height=768');
    if (w) { w.document.write(previewSrc); w.document.close(); }
  }

  function getFileIcon(path: string) {
    const ext = path.split('.').pop() || '';
    const icons: Record<string, string> = {
      html: '🌐', css: '🎨', js: '⚡', ts: '⚡', py: '🐍', json: '{ }', md: '📝', sh: '💻'
    };
    return icons[ext] || '📄';
  }
</script>

<div
  class={`modal-backdrop fixed inset-0 z-[62] flex items-center justify-center bg-black/50 px-4`}
  role="dialog"
  aria-modal="true"
  transition:fade={{ duration: 150 }}
>
  <div
    class={`modal-surface flex overflow-hidden rounded-2xl bg-[var(--surface)] shadow-2xl ring-1 ring-[var(--border)] transition-all ${fullscreen ? 'h-screen w-screen rounded-none' : 'h-[88vh] w-full max-w-6xl'}`}
    transition:flyAndScale={{ y: -12, start: 0.96, duration: 200 }}
  >
    <!-- File tree -->
    <div class="flex w-60 shrink-0 flex-col border-r border-[var(--border)]">
      <div class="flex items-center justify-between px-3 py-2.5 border-b border-[var(--border)]">
        <div class="min-w-0">
          <div class="truncate text-[13px] font-semibold text-[var(--text)]">{artifact?.title || 'Artifact'}</div>
          <div class="text-[11px] text-[var(--text-tertiary)]">{files.length} file{files.length !== 1 ? 's' : ''}</div>
        </div>
      </div>
      <div class="flex-1 overflow-y-auto p-1.5 space-y-px">
        {#each files as [path]}
          <button
            class={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${selectedPath === path ? 'bg-[var(--surface-highlight)] text-[var(--text)]' : 'text-[var(--text-secondary)] hover:bg-[var(--surface-highlight)]'}`}
            onclick={() => (selectedPath = path, activePane = 'code')}
          >
            <span class="text-[13px] leading-none w-4 text-center shrink-0">{getFileIcon(path)}</span>
            <span class="truncate text-[12px]">{path}</span>
          </button>
        {/each}
      </div>
    </div>

    <!-- Editor/Preview area -->
    <div class="flex min-w-0 flex-1 flex-col">
      <!-- Header bar -->
      <div class="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <!-- Pane tabs -->
        <div class="flex items-center gap-1 rounded-lg bg-[var(--surface-highlight)] p-1">
          <button
            class={`rounded-md px-3 py-1 text-[12px] font-medium transition ${activePane === 'code' ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm' : 'text-[var(--text-tertiary)] hover:text-[var(--text)]'}`}
            onclick={() => (activePane = 'code')}
          >Code</button>
          {#if isHtml}
            <button
              class={`rounded-md px-3 py-1 text-[12px] font-medium transition ${activePane === 'preview' ? 'bg-[var(--surface)] text-[var(--text)] shadow-sm' : 'text-[var(--text-tertiary)] hover:text-[var(--text)]'}`}
              onclick={() => (activePane = 'preview')}
            >
              <Eye class="inline-block mr-1 h-3 w-3" />Preview
            </button>
          {/if}
        </div>

        <span class="text-[12px] text-[var(--text-tertiary)]">{selectedPath}</span>

        <div class="ml-auto flex items-center gap-1">
          {#if isHtml}
            <button
              class="rounded-lg p-1.5 text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]"
              onclick={openInWindow}
              title="Open in new window"
            ><ExternalLink class="h-3.5 w-3.5" /></button>
          {/if}
          <button
            class="rounded-lg p-1.5 text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]"
            onclick={copyContent}
            title="Copy file contents"
          >{#if copied}<Check class="h-3.5 w-3.5 text-emerald-500" />{:else}<Copy class="h-3.5 w-3.5" />{/if}</button>
          <button
            class="rounded-lg p-1.5 text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]"
            onclick={() => (fullscreen = !fullscreen)}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >{#if fullscreen}<Minimize2 class="h-3.5 w-3.5" />{:else}<Maximize2 class="h-3.5 w-3.5" />{/if}</button>
          <button
            class="rounded-lg p-1.5 text-[var(--text-tertiary)] transition hover:bg-[var(--surface-highlight)] hover:text-[var(--text)]"
            onclick={() => (appStore.agentWorkspaceOpen = false)}
            aria-label="Close artifact workspace"
          ><X class="h-4 w-4" /></button>
        </div>
      </div>

      <!-- Content -->
      <div class="min-h-0 flex-1 overflow-auto">
        {#if activePane === 'code'}
          <pre class="h-full p-4 text-[13px] leading-relaxed font-mono text-[var(--text)] bg-[var(--surface)]"><code class="hljs">{@html highlightedCode || selectedContent}</code></pre>
        {:else if isHtml}
          <iframe
            class="h-full w-full border-0 bg-white"
            srcdoc={previewSrc}
            sandbox="allow-scripts allow-same-origin"
            title="HTML preview"
          ></iframe>
        {/if}
      </div>
    </div>
  </div>
</div>
