<svelte:options runes={true} />

<!--
  What a turn changed on disk, as one card: a header that says how many files
  and how much (+/−), then one row per file — path hard left, counts hard
  right. The first few files show; the rest wait behind "show more". A row
  opens the file's new (or, for a deletion, old) contents in place.
-->

<script lang="ts">
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import { ChevronDown, FileDiff } from 'lucide-svelte';
  import type { CodeAgentDiffStat } from '$lib/types/chat';
  import Button from '$lib/components/ui/Button.svelte';

  interface Props {
    stats: CodeAgentDiffStat[];
    /** Opens the full review (the Changes pane) where the surface has one. */
    onreview?: () => void;
  }

  /** Files listed before "show more". */
  const VISIBLE = 3;

  let { stats, onreview }: Props = $props();
  let open = $state<Set<string>>(new Set());
  let showAll = $state(false);

  /** One row per file: a file touched twice in a turn keeps its last state and the sum of its counts. */
  const files = $derived.by(() => {
    const byPath = new Map<string, CodeAgentDiffStat>();
    for (const stat of stats) {
      const seen = byPath.get(stat.path);
      byPath.set(stat.path, seen
        ? { ...stat, additions: seen.additions + stat.additions, deletions: seen.deletions + stat.deletions, before: seen.before ?? stat.before }
        : stat);
    }
    return [...byPath.values()];
  });
  const adds = $derived(files.reduce((sum, file) => sum + file.additions, 0));
  const dels = $derived(files.reduce((sum, file) => sum + file.deletions, 0));
  const shown = $derived(showAll ? files : files.slice(0, VISIBLE));
  const hidden = $derived(files.length - shown.length);

  function toggle(path: string) {
    const next = new Set(open);
    if (!next.delete(path)) next.add(path);
    open = next;
  }

  const body = (file: CodeAgentDiffStat) => (file.kind === 'deleted' ? file.before : file.after) || '';
</script>

<section class="card">
  <header class="hdr">
    <span class="tile" aria-hidden="true"><FileDiff class="size-[18px]" /></span>
    <div class="min-w-0 flex-1">
      <p class="title">{$t('code.activity.done.edit', { values: { n: files.length } })}</p>
      <p class="cnt"><span class="a">+{adds}</span><span class="d">−{dels}</span></p>
    </div>
    {#if onreview}
      <Button variant="outline" size="sm" onclick={onreview}>{$t('codeWs.viewChanges')}</Button>
    {/if}
  </header>
  <ul class="list">
    {#each shown as file (file.path)}
      <li>
        <Button variant="plain" class={uiClass('row', 'ui-local-9cb339f3')} aria-expanded={open.has(file.path)} disabled={!body(file)} onclick={() => toggle(file.path)}>
          <span class="path" class:gone={file.kind === 'deleted'} title={file.path}>{file.path}</span>
          <span class="cnt"><span class="a">+{file.additions}</span><span class="d">−{file.deletions}</span></span>
        </Button>
        {#if open.has(file.path)}<pre class="diff">{body(file)}</pre>{/if}
      </li>
    {/each}
  </ul>
  {#if hidden > 0 || (showAll && files.length > VISIBLE)}
    <Button variant="plain" class={uiClass('more', 'ui-local-9cb339f3')} aria-expanded={showAll} onclick={() => (showAll = !showAll)}>
      {showAll ? $t('code.showLess') : `${$t('modelHub.loadMore')} · ${hidden}`}
      <ChevronDown class={uiClass('size-3.5 transition-transform', showAll && 'rotate-180')} />
    </Button>
  {/if}
</section>

<style>
  /* The same sheet as a file card in chat (ArtifactBlock): one step above the
     page, a hairline ring, no rules heavier than the row separators. */
  .card {
    width: var(--inline-block-width);
    max-width: 100%;
    margin-top: 0.5rem;
    overflow: hidden;
    border: 1px solid var(--border-subtle);
    border-radius: 0.875rem;
    background: var(--artifact-surface);
  }
  .hdr {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem 0.625rem 0.625rem;
  }
  .tile {
    display: inline-flex;
    width: 2.5rem;
    height: 2.5rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.625rem;
    background: color-mix(in srgb, var(--foreground) 7%, transparent);
    color: var(--muted-foreground);
  }
  .title {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--foreground);
    font-size: var(--text-sm);
    font-weight: 600;
  }
  .title::first-letter { text-transform: uppercase; }
  .cnt {
    display: inline-flex;
    flex-shrink: 0;
    gap: 0.5rem;
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }
  .hdr .cnt { margin-top: 0.125rem; }
  .a { color: var(--success); }
  .d { color: var(--error); }

  .list { margin: 0; padding: 0; list-style: none; max-height: 28rem; overflow-y: auto; border-top: 1px solid var(--border-subtle); }
  :global(.row.ui-local-9cb339f3) {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.5rem 0.875rem;
    border-radius: 0;
    color: var(--text-secondary);
    text-align: left;
    transition: background-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease);
  }
  :global(.row.ui-local-9cb339f3:hover:not(:disabled)) { background: var(--artifact-surface-hover); color: var(--foreground); }
  :global(.row.ui-local-9cb339f3:disabled) { cursor: default; opacity: 1; }
  .path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); }
  .path.gone { text-decoration: line-through; color: var(--muted-foreground); }

  /* Matches .ui-tool-fallback-args-value so agent code blocks read the same
     inline as they do in the activity drawer. */
  .diff {
    margin: 0;
    max-height: 16rem;
    overflow: auto;
    padding: 0.5rem 0.875rem;
    background: color-mix(in srgb, var(--foreground) 4%, transparent);
    color: color-mix(in srgb, var(--foreground) 90%, transparent);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.5;
    white-space: pre-wrap;
  }
  :global(.more.ui-local-9cb339f3) {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.875rem 0.625rem;
    border-radius: 0;
    color: var(--muted-foreground);
    font-size: var(--text-sm);
    font-weight: 500;
    text-align: left;
  }
  :global(.more.ui-local-9cb339f3:hover) { color: var(--foreground); }
</style>
