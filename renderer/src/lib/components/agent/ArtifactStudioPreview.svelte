<svelte:options runes={true} />

<script lang="ts">
  import type { AgentArtifact } from '$lib/types/chat';
  import { AlertCircle, Play, RefreshCw, ShieldCheck } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import ArtifactRenderer from '$lib/ui/components/ArtifactRenderer.svelte';
  import PdfViewer from '$lib/features/chat/viewers/PdfViewer.svelte';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import { invoke, isElectron } from '$lib/services/bridge';

  interface Props { artifact: AgentArtifact; refreshKey?: number }
  let { artifact, refreshKey = 0 }: Props = $props();
  let opening = $state(false);
  let error = $state('');
  const resolved = $derived(resolveArtifactPresentation(artifact));
  const entryPath = $derived(resolved.manifest.entryPath || '');
  const pdfSource = $derived(/\.pdf$/i.test(entryPath) ? resolved.artifact.files[entryPath] : '');
  const previewBuild = $derived(resolved.preview
    ? buildPreviewHtml(resolved.preview.html, resolved.artifact.files, resolved.preview.basePath)
    : { html: '', externalRefs: [] as string[] });

  async function runPreview() {
    if (opening || !resolved.preview) return;
    opening = true;
    error = '';
    try {
      const { html } = buildPreviewHtml(resolved.preview.html, resolved.artifact.files, resolved.preview.basePath, true);
      await invoke('artifact_preview_open', { html, title: artifact.title });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not open preview. Try again.';
    } finally {
      opening = false;
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-background">
  {#if resolved.manifest.presentation === 'inline' && resolved.artifact.inline}
    <div class="min-h-0 flex-1 overflow-auto p-4 sm:p-6"><ArtifactRenderer artifact={resolved.artifact} /></div>
  {:else if pdfSource?.startsWith('data:application/pdf')}
    <div class="min-h-0 flex-1 overflow-auto"><PdfViewer src={pdfSource} filename={entryPath} /></div>
  {:else if previewBuild.html}
    <div class="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface)] px-3 py-2">
      <span class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><ShieldCheck class="size-3.5 shrink-0" /><span class="truncate">Offline preview</span></span>
      <div class="flex items-center gap-1">
        <Button variant="ghost" size="sm" onclick={runPreview} loading={opening} disabled={!isElectron()} title="Run JavaScript in an isolated, network-blocked app window"><Play /> Run preview</Button>
        <button type="button" class="aui-icon-button size-8" onclick={() => (refreshKey += 1)} aria-label="Refresh preview" title="Refresh preview"><RefreshCw class="size-3.5" /></button>
      </div>
    </div>
    <div class="min-h-0 flex-1 overflow-hidden bg-white">
      {#key `${refreshKey}:${previewBuild.html}`}
        <iframe class="h-full w-full border-0" srcdoc={previewBuild.html} sandbox="" referrerpolicy="no-referrer" title="Artifact preview"></iframe>
      {/key}
    </div>
    <div class="shrink-0 border-t border-[var(--border-subtle)] px-3 py-2 text-[11px] text-muted-foreground">Static preview · Run preview to use interactive code in an isolated app window.</div>
  {:else}
    <div class="min-h-0 flex-1 overflow-auto p-4 sm:p-6"><ArtifactRenderer artifact={resolved.artifact} /></div>
  {/if}

  {#if error}
    <div role="alert" class="shrink-0 border-t border-border px-3 py-2 text-xs text-[var(--error)]">{error}</div>
  {/if}
  {#if previewBuild.externalRefs.length}
    <details class="max-h-32 shrink-0 overflow-auto border-t border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
      <summary class="cursor-pointer"><AlertCircle class="mr-1 inline size-3.5" />{previewBuild.externalRefs.length} remote assets blocked</summary>
      {#each previewBuild.externalRefs as ref}<div class="mt-1 truncate font-mono">{ref}</div>{/each}
    </details>
  {/if}
</div>
