<script lang="ts">
  import { t } from 'svelte-i18n';
  import { readArrayBuffer } from './viewer-source';
  import { buildArtifactPreviewHtml } from '$lib/utils/preview-builder';
  import { registerViewerControls, useViewerControls } from './viewer-controls.svelte';
  import TextViewer from './TextViewer.svelte';
  import ViewerStatus from './ViewerStatus.svelte';
  let { html = '', src = '', filename }: { html?: string; src?: string; filename: string } = $props();
  let content = $state(''), loading = $state(true), error = $state<string | null>(null), sourceView = $state(false), revision = $state(0);
  const controls = useViewerControls();
  const action = $derived({ label: sourceView ? $t('artifacts.studio.preview') : $t('artifacts.studio.source'), run: () => { sourceView = !sourceView; } });
  registerViewerControls(controls, () => sourceView ? null : { actions: [action], retry: error ? () => { revision += 1; } : undefined });
  // The child owns source search; add the same preview switch to its menu.
  $effect(() => {
    if (!sourceView || !controls?.current) return;
    if (!controls.current.actions?.some((item) => item.label === action.label)) controls.current.actions = [...(controls.current.actions || []), action];
  });
  $effect(() => {
    const inline = html, source = src; revision;
    let current = true; loading = true; error = null;
    void (async () => {
      try {
        const value = inline || new TextDecoder().decode(await readArrayBuffer(source, 'HTML'));
        if (current) content = value;
      } catch (failure) { if (current) error = failure instanceof Error ? failure.message : 'Could not read this HTML file'; }
      finally { if (current) loading = false; }
    })();
    return () => { current = false; };
  });
  const preview = $derived.by(() => {
    const page = buildArtifactPreviewHtml(content, {}, filename).html;
    const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data:;">';
    return page.replace(/<head(?:\s[^>]*)?>/i, (head) => head + policy);
  });
  const sourceUrl = $derived(`data:text/html;charset=utf-8,${encodeURIComponent(content)}`);
</script>

{#if loading || error}
  <ViewerStatus {loading} {error} label={$t('viewer.doc.loading')} retry={error ? () => { revision += 1; } : undefined} />
{:else if sourceView}
  <TextViewer src={sourceUrl} {filename} lang="html" />
{:else}
  <iframe class="artifact-preview-frame h-full min-h-0 w-full flex-1" srcdoc={preview} sandbox="" referrerpolicy="no-referrer" title={filename}></iframe>
{/if}
