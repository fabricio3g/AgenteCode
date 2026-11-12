<svelte:options runes={true} />

<!--
  The session at a glance, in one column beside the conversation. A dense card
  first: when it started, how long and how much it took, which model, what it
  changed, over the latest reply in brief. Then lists: what was asked, the
  artifacts made, the pages read and (in Code) the files changed. Every row is
  a door: a request scrolls to its message, an artifact opens in its viewer, a
  page in the browser, a file in the Changes pane. Empty sections are not drawn.
-->

<script lang="ts">
  import { t, locale } from 'svelte-i18n';
  import { FileDiff, FileSpreadsheet, FileText, Files, Globe, Presentation, Shapes } from 'lucide-svelte';
  import { formatToolDuration } from '$lib/utils/tool-ui';
  import Button from '$lib/components/ui/Button.svelte';
  import type { ArtifactKind, ChatSession } from '$lib/types/chat';
  import { appStore } from '$lib/stores/app.svelte';
  import { resolveArtifactPresentation } from '$lib/services/artifact-model';
  import { editedFiles } from '$lib/features/code/work-blocks';
  import { codeWorkspace } from '$lib/features/code/workspace.svelte';
  import { codeStore } from '$lib/features/code/code.svelte';

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

  /** What was asked, in order; `index` is the message's place in the transcript. */
  const requests = $derived(chat.messages.flatMap((message, index) => {
    const text = message.role === 'user' ? message.content.replace(/\s+/g, ' ').trim() : '';
    return text ? [{ id: message.id, index, text }] : [];
  }));

  /** The facts of the session, each drawn only when it is known. */
  const facts = $derived.by(() => {
    const tokens = replies.reduce((sum, { metadata: m }) => sum + (m?.totalTokens ?? m?.tokens ?? ((m?.inputTokens ?? 0) + (m?.outputTokens ?? 0))), 0);
    const worked = replies.reduce((sum, { metadata: m }) => sum + (m?.codeElapsedMs ?? (m?.totalElapsedSeconds ?? 0) * 1000), 0);
    const model = [...replies].reverse().find((message) => message.metadata?.modelName)?.metadata?.modelName;
    const compact = new Intl.NumberFormat($locale || undefined, { notation: 'compact', maximumFractionDigits: 1 });
    const rows: Array<{ label: string; value: string }> = [
      { label: $t('context.started'), value: when(chat.createdAt) },
      { label: $t('context.messages'), value: String(chat.messages.length) }
    ];
    if (model) rows.push({ label: $t('context.model'), value: model });
    if (tokens) rows.push({ label: $t('context.tokens'), value: compact.format(tokens) });
    if (worked >= 1000) rows.push({ label: $t('context.worked'), value: formatToolDuration(worked) });
    const project = codeStore.projectById(chat.projectId ?? null)?.rootName;
    const tools = replies.reduce((sum, message) => sum + (message.agentSteps?.length ?? 0), 0);
    const children = replies.reduce((sum, message) => sum + (message.metadata?.codeChildren?.length ?? 0), 0);
    const todos = [...replies].reverse().find((message) => message.metadata?.codeTodos?.length)?.metadata?.codeTodos ?? [];
    if (project) rows.push({ label: $t('conversationInfo.project'), value: project });
    if (tools) rows.push({ label: $t('home.tools.title'), value: String(tools) });
    if (children) rows.push({ label: $t('code.cmd.subagents.label'), value: String(children) });
    if (todos.length) rows.push({ label: $t('code.todosTitle'), value: `${todos.filter((todo) => todo.status === 'completed').length}/${todos.length}` });
    if (artifacts.length) rows.push({ label: $t('artifacts.title'), value: String(artifacts.length) });
    if (pages.length) rows.push({ label: $t('context.sources'), value: String(pages.length) });
    return rows;
  });
  const churn = $derived({ add: files.reduce((sum, file) => sum + file.additions, 0), del: files.reduce((sum, file) => sum + file.deletions, 0) });

  /** Message slots are drawn in transcript order by both Home's thread and Code's. */
  function jumpTo(index: number) {
    document.querySelectorAll<HTMLElement>('.message-slot, .code-message-slot')[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function when(at: number): string {
    return new Date(at).toLocaleString($locale || undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
</script>

<div class="pane-body">
  <section class="brief" aria-label={$t('context.button')}>
    <h2 class="brief-title">{chat.title}</h2>
    <dl class="facts">
      {#each facts as fact (fact.label)}
        <div class="fact"><dt>{fact.label}</dt><dd title={fact.value}>{fact.value}</dd></div>
      {/each}
      {#if files.length}
        <div class="fact"><dt>{$t('context.changes')}</dt><dd class="pane-churn"><span class="text-success">+{churn.add}</span><span class="text-error">−{churn.del}</span><span>· {files.length}</span></dd></div>
      {/if}
    </dl>
    {#if latest}
      <p class="stamp">{$t('context.latest')} · {when(latest.at)}</p>
      <p class="brief-text">{latest.text}</p>
    {/if}
  </section>

  {#if requests.length}
    <section>
      <h3 class="pane-heading">{$t('context.requests')}<span class="pane-count">{requests.length}</span></h3>
      {#each requests as request, order (request.id)}
        <Button variant="plain" class="pane-row" title={request.text} onclick={() => jumpTo(request.index)}>
          <span class="pane-row-tile" aria-hidden="true">{order + 1}</span>
          <span class="pane-row-label">{request.text}</span>
        </Button>
      {/each}
    </section>
  {/if}

  {#if artifacts.length}
    <section>
      <h3 class="pane-heading">{$t('artifacts.title')}<span class="pane-count">{artifacts.length}</span></h3>
      {#each artifacts as item (item.key)}
        <Button variant="plain" class="pane-row" title={item.title} onclick={() => appStore.openArtifactPanel(chat.id, item.messageId, item.index)}>
          <span class="pane-row-tile" aria-hidden="true"><item.icon class="size-3.5" /></span>
          <span class="pane-row-label">{item.title}</span>
        </Button>
      {/each}
    </section>
  {/if}

  {#if pages.length}
    <section>
      <h3 class="pane-heading">{$t('context.web')}<span class="pane-count">{pages.length}</span></h3>
      {#each pages as page (page.url)}
        <Button variant="plain" class="pane-row" title={page.url} onclick={() => window.open(page.url, '_blank', 'noopener,noreferrer')}>
          <span class="pane-row-tile" aria-hidden="true"><Globe class="size-3.5" /></span>
          <span class="pane-row-label">{page.title}</span>
          <span class="pane-row-aside">{page.host}</span>
        </Button>
      {/each}
    </section>
  {/if}

  {#if files.length}
    <section>
      <h3 class="pane-heading">{$t('context.files')}<span class="pane-count">{files.length}</span></h3>
      {#each files as file (file.path)}
        <Button variant="plain" class="pane-row" title={file.path} onclick={() => codeWorkspace.showFileInChanges(file.path)}>
          <span class="pane-row-tile" aria-hidden="true"><FileDiff class="size-3.5" /></span>
          <span class="pane-row-label">{file.name}</span>
          <span class="pane-row-aside pane-churn"><span class="text-success">+{file.additions}</span><span class="text-error">−{file.deletions}</span></span>
        </Button>
      {/each}
    </section>
  {/if}
</div>

<style>
  /* The brief is the one card in the column; everything under it is rows. */
  .brief {
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    background: var(--artifact-surface);
  }
  .brief-title {
    margin: 0 0 0.5rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--foreground);
    font-size: var(--text-sm);
    font-weight: 600;
  }
  /* Facts: label hard left, value hard right, two to a line while there is room. */
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
    gap: 0.125rem 1.25rem;
    margin: 0;
    font-size: var(--text-xs);
  }
  .fact {
    display: flex;
    min-width: 0;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.1875rem 0;
  }
  .fact dt {
    flex-shrink: 0;
    color: var(--muted-foreground);
  }
  .fact dd {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--foreground);
    font-variant-numeric: tabular-nums;
  }
  .stamp {
    margin: 0.625rem 0 0.25rem;
    padding-top: 0.625rem;
    border-top: 1px solid var(--border-subtle);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .brief-text {
    margin: 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    line-height: 1.5;
    display: -webkit-box;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }
</style>
