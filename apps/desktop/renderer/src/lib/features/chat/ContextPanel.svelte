<svelte:options runes={true} />

<!--
  What this conversation has produced and drawn on, in one column beside it:
  the latest reply in brief, then the artifacts it made, the pages it read and
  (in Code) the files it changed. Every row is a door: an artifact opens in its
  viewer, a page in the browser, a file in the Changes pane. Sections with
  nothing in them are not drawn.
-->

<script lang="ts">
  import { t, locale } from 'svelte-i18n';
  import { FileDiff, FileSpreadsheet, FileText, Files, Globe, Presentation, Shapes } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';
  import type { ArtifactKind, ChatSession } from '$lib/types/chat';
  import { appStore } from '$lib/stores/app.svelte';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';
  import { editedFiles } from '$lib/features/code/work-blocks';
  import { codeWorkspace } from '$lib/features/code/workspace.svelte';

  let { chat, code = false }: { chat: ChatSession; /** Code conversations list the files they changed. */ code?: boolean } = $props();

  const ICONS: Partial<Record<ArtifactKind, typeof FileText>> = {
    report: FileText, work_product: FileText, document: FileText, pdf: FileText,
    spreadsheet: FileSpreadsheet, presentation: Presentation, web: Globe, files: Files, research_package: Files
  };

  const replies = $derived(chat.messages.filter((message) => message.role === 'assistant'));

  /** The newest reply with words in it, flattened to a few plain lines. */
  const latest = $derived.by(() => {
    const message = [...replies].reverse().find((item) => item.content?.trim());
    if (!message) return null;
    const text = message.content
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[#*_`>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return text ? { text, at: message.createdAt } : null;
  });

  const artifacts = $derived(replies.flatMap((message) => (message.artifacts ?? []).map((artifact, index) => {
    const kind = resolveArtifactPresentation(artifact).manifest.kind;
    return { key: `${message.id}:${index}`, messageId: message.id, index, title: artifact.title || $t('artifacts.untitled'), kind, icon: ICONS[kind] ?? Shapes };
  })));

  /** Each page once, in the order it was first read. */
  const pages = $derived.by(() => {
    const seen = new Map<string, { url: string; title: string; host: string }>();
    for (const message of replies) {
      for (const source of message.sources ?? []) {
        if (!source.url || seen.has(source.url)) continue;
        let host = source.url;
        try { host = new URL(source.url).hostname.replace(/^www\./, ''); } catch { /* keep the raw address */ }
        seen.set(source.url, { url: source.url, title: source.title || host, host });
      }
    }
    return [...seen.values()];
  });

  const files = $derived(code ? editedFiles(replies.flatMap((message) => message.agentSteps ?? [])) : []);
  const empty = $derived(!latest && !artifacts.length && !pages.length && !files.length);

  const when = (at: number) => new Date(at).toLocaleString($locale || undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<div class="context">
  {#if empty}
    <p class="empty">{$t('context.empty')}</p>
  {/if}

  {#if latest}
    <section class="brief" aria-label={$t('context.latest')}>
      <p class="stamp">{$t('context.latest')} · {when(latest.at)}</p>
      <p class="brief-text">{latest.text}</p>
    </section>
  {/if}

  {#if artifacts.length}
    <section>
      <h3 class="heading">{$t('artifacts.title')}</h3>
      {#each artifacts as item (item.key)}
        <Button variant="plain" class={uiClass('row', 'ui-local-c0a1e7f4')} title={item.title} onclick={() => appStore.openArtifactPanel(chat.id, item.messageId, item.index)}>
          <span class="tile" aria-hidden="true"><item.icon class="size-3.5" /></span>
          <span class="label">{item.title}</span>
        </Button>
      {/each}
    </section>
  {/if}

  {#if pages.length}
    <section>
      <h3 class="heading">{$t('context.web')}</h3>
      {#each pages as page (page.url)}
        <Button variant="plain" class={uiClass('row', 'ui-local-c0a1e7f4')} title={page.url} onclick={() => window.open(page.url, '_blank', 'noopener,noreferrer')}>
          <span class="tile" aria-hidden="true"><Globe class="size-3.5" /></span>
          <span class="label">{page.title}</span>
          <span class="aside">{page.host}</span>
        </Button>
      {/each}
    </section>
  {/if}

  {#if files.length}
    <section>
      <h3 class="heading">{$t('context.files')}</h3>
      {#each files as file (file.path)}
        <Button variant="plain" class={uiClass('row', 'ui-local-c0a1e7f4')} title={file.path} onclick={() => codeWorkspace.showFileInChanges(file.path)}>
          <span class="tile" aria-hidden="true"><FileDiff class="size-3.5" /></span>
          <span class="label">{file.name}</span>
          <span class="aside churn"><span class="text-success">+{file.additions}</span><span class="text-error">−{file.deletions}</span></span>
        </Button>
      {/each}
    </section>
  {/if}
</div>

<style>
  .context {
    display: flex;
    min-height: 0;
    flex: 1;
    flex-direction: column;
    gap: 1.125rem;
    overflow-y: auto;
    padding: 0.75rem;
  }
  .empty {
    margin: 2rem 0.5rem;
    color: var(--muted-foreground);
    font-size: var(--text-sm);
    line-height: 1.5;
    text-align: center;
  }

  /* The brief is the one card in the column; everything under it is rows. */
  .brief {
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    background: var(--artifact-surface);
  }
  .stamp {
    margin: 0 0 0.375rem;
    color: var(--muted-foreground);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }
  .brief-text {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    line-height: 1.55;
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 6;
    line-clamp: 6;
  }

  .heading {
    margin: 0 0 0.25rem;
    padding: 0 0.5rem;
    color: var(--muted-foreground);
    font-size: var(--text-sm);
    font-weight: 400;
  }
  :global(.row.ui-local-c0a1e7f4) {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    gap: 0.625rem;
    padding: 0.3125rem 0.5rem;
    border-radius: 0.5rem;
    color: var(--foreground);
    font-size: var(--text-sm);
    text-align: left;
    transition: background-color var(--motion-instant) var(--motion-ease);
  }
  :global(.row.ui-local-c0a1e7f4:hover) {
    background: var(--float-row-hover);
  }
  .tile {
    display: inline-flex;
    width: 1.5rem;
    height: 1.5rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
    background: color-mix(in srgb, var(--foreground) 8%, transparent);
    color: var(--text-secondary);
  }
  .label {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .aside {
    flex-shrink: 0;
    max-width: 40%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .churn {
    display: inline-flex;
    gap: 0.375rem;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
</style>
