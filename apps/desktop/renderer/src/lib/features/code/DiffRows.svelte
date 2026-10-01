<svelte:options runes={true} />

<!--
  The rows of a unified diff, shared by the transcript's diff cards and the
  Changes pane: old and new line numbers, a sign, the code syntax-highlighted
  for the file's language, additions and removals tinted. Long lines wrap
  under their own code column, so nothing scrolls sideways.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { highlightLines, languageForPath } from '$lib/utils/highlight-lines';
  import type { PatchRow } from './patch';

  let { rows, path }: { rows: PatchRow[]; path: string } = $props();

  /** Past this many lines a diff stays plain: highlighting would stall the UI. */
  const HIGHLIGHT_LIMIT = 4000;

  /** Each row's highlighted HTML; the old and new sides are highlighted apart. */
  const highlighted = $derived.by(() => {
    const language = languageForPath(path);
    if (!language || rows.length > HIGHLIGHT_LIMIT) return null;
    const oldSide: number[] = [];
    const newSide: number[] = [];
    rows.forEach((row, index) => {
      if (row.kind === 'ctx' || row.kind === 'del') oldSide.push(index);
      if (row.kind === 'ctx' || row.kind === 'add') newSide.push(index);
    });
    const html: string[] = [];
    for (const indexes of [oldSide, newSide]) {
      highlightLines(indexes.map((i) => rows[i].text), language).forEach((line, n) => {
        html[indexes[n]] ??= line;
      });
    }
    return html;
  });
</script>

<div class="diff-rows" role="table" aria-label={$t('codeWs.diff')}>
  {#each rows as row, index (index)}
    {#if row.kind === 'hunk'}
      <div class="hunk" aria-hidden="true">⋯</div>
    {:else}
      <div class="line {row.kind}" role="row">
        <span class="num" aria-hidden="true">{row.oldNo ?? ''}</span>
        <span class="num" aria-hidden="true">{row.newNo ?? ''}</span>
        <span class="sign" aria-hidden="true">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</span>
        {#if highlighted?.[index]}
          <!-- highlight.js escapes the source text it returns. -->
          <span class="code">{@html highlighted[index]}</span>
        {:else}
          <span class="code">{row.text || ' '}</span>
        {/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .diff-rows {
    padding: 0.25rem 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    line-height: 1.6;
  }
  .line {
    display: flex;
    color: var(--foreground);
  }
  .line.add {
    background: color-mix(in srgb, var(--success) 12%, transparent);
  }
  .line.del {
    background: color-mix(in srgb, var(--error) 11%, transparent);
  }
  .num {
    width: 2.5rem;
    flex-shrink: 0;
    padding-right: 0.5rem;
    text-align: right;
    color: var(--muted-foreground);
    user-select: none;
  }
  .sign {
    width: 1rem;
    flex-shrink: 0;
    color: var(--muted-foreground);
    user-select: none;
  }
  .add .sign {
    color: var(--success);
  }
  .del .sign {
    color: var(--error);
  }
  .code {
    min-width: 0;
    flex: 1;
    padding-right: 0.75rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .hunk {
    padding: 0 0.75rem 0 5.5rem;
    color: var(--muted-foreground);
    user-select: none;
  }
</style>
