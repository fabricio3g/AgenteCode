<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentArtifact } from '$lib/types/chat';
  import { AlertCircle, ExternalLink, RefreshCw } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import ArtifactRenderer from '$lib/ui/components/ArtifactRenderer.svelte';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';

  interface Props { artifact: AgentArtifact; refreshKey?: number }
  let { artifact, refreshKey = 0 }: Props = $props();

  type PreviewLog = { level: 'log' | 'warn' | 'error'; text: string };
  let frame = $state<HTMLIFrameElement>();
  let logs = $state<PreviewLog[]>([]);
  const resolved = $derived(resolveArtifactPresentation(artifact));
  const previewBuild = $derived(resolved.preview
    ? buildPreviewHtml(resolved.preview.html, resolved.artifact.files, resolved.preview.basePath)
    : { html: '', externalRefs: [] as string[] });

  $effect(() => {
    void refreshKey;
    void previewBuild.html;
    logs = [];
  });

  function openWindow() {
    if (!previewBuild.html) return;
    const url = URL.createObjectURL(new Blob([previewBuild.html], { type: 'text/html' }));
    const opened = window.open(url, '_blank', 'width=1200,height=800');
    if (opened) opened.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    else URL.revokeObjectURL(url);
  }

  onMount(() => {
    const handleMessage = (event: MessageEvent) => {
      if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || data.source !== 'chateaui-preview' || typeof data.text !== 'string') return;
      const level = data.level === 'warn' || data.level === 'error' ? data.level : 'log';
      logs = [...logs, { level, text: data.text }].slice(-40);
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  });
</script>

<div class="flex h-full min-h-0 flex-col bg-background">
  {#if resolved.manifest.presentation === 'inline' && resolved.artifact.inline}
    <div class="min-h-0 flex-1 overflow-auto p-4 sm:p-6"><ArtifactRenderer artifact={resolved.artifact} /></div>
  {:else if previewBuild.html}
    <div class="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
      <span class="truncate text-xs font-medium">{resolved.preview?.basePath || 'Preview'}</span>
      <div class="flex items-center gap-1">
        <Button variant="ghost" size="icon-sm" onclick={openWindow} aria-label="Open preview in a new window"><ExternalLink /></Button>
        <Button variant="ghost" size="icon-sm" onclick={() => (refreshKey += 1)} aria-label="Refresh preview"><RefreshCw /></Button>
      </div>
    </div>
    <div class="min-h-0 flex-1 overflow-hidden">
      {#key `${refreshKey}:${previewBuild.html}`}
        <iframe bind:this={frame} class="h-full w-full border-0" srcdoc={previewBuild.html} sandbox="allow-scripts allow-forms allow-modals allow-popups" title="Artifact preview"></iframe>
      {/key}
    </div>
  {:else}
    <div class="min-h-0 flex-1 overflow-auto p-4 sm:p-6"><ArtifactRenderer artifact={resolved.artifact} /></div>
  {/if}

  {#if previewBuild.externalRefs.length || logs.length}
    <div class="max-h-36 shrink-0 overflow-auto border-t border-border bg-muted/30 px-3 py-2 font-mono text-[11px]">
      {#if previewBuild.externalRefs.length}
        <div class="mb-1.5 flex items-center gap-1.5 font-sans text-muted-foreground"><AlertCircle class="size-3.5" /> Remote assets blocked for deterministic preview</div>
        {#each previewBuild.externalRefs as ref}<div class="truncate text-muted-foreground">{ref}</div>{/each}
      {/if}
      {#if logs.length}
        <div class:mt-3={previewBuild.externalRefs.length > 0} class="space-y-1 border-border">
          {#each logs as log}<div class:error={log.level === 'error'} class:warning={log.level === 'warn'} class="whitespace-pre-wrap break-words">{log.text}</div>{/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .error { color: var(--error); }
  .warning { color: var(--warning); }
</style>
