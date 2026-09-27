<svelte:options runes={true} />

<!--
  A unified diff of one file: hunks with three lines of context, old and new
  line numbers in the gutter, additions and deletions tinted.
-->

<script lang="ts">
  import { structuredPatch } from 'diff';
  import { t } from 'svelte-i18n';

  let { before, after }: { before: string; after: string } = $props();

  type Row = { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string; oldNo?: number; newNo?: number };

  const rows = $derived.by((): Row[] => {
    const patch = structuredPatch('a', 'b', before, after, '', '', { context: 3 });
    const out: Row[] = [];
    for (const hunk of patch.hunks) {
      out.push({ kind: 'hunk', text: `@@ −${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
      let oldNo = hunk.oldStart;
      let newNo = hunk.newStart;
      for (const line of hunk.lines) {
        if (line.startsWith('\\')) continue; // "\ No newline at end of file"
        const text = line.slice(1);
        if (line[0] === '+') out.push({ kind: 'add', text, newNo: newNo++ });
        else if (line[0] === '-') out.push({ kind: 'del', text, oldNo: oldNo++ });
        else out.push({ kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
      }
    }
    return out;
  });
</script>

{#if !rows.length}
  <p class="px-4 py-6 text-center text-xs text-muted-foreground">{$t('codeWs.noDifferences')}</p>
{:else}
  <div class="diff font-mono text-[12px] leading-[1.55]" role="table" aria-label={$t('codeWs.diff')}>
    {#each rows as row, index (index)}
      {#if row.kind === 'hunk'}
        <div class="hunk px-3 py-1 text-[11px] text-muted-foreground">{row.text}</div>
      {:else}
        <div class="line {row.kind}" role="row">
          <span class="num" aria-hidden="true">{row.oldNo ?? ''}</span>
          <span class="num" aria-hidden="true">{row.newNo ?? ''}</span>
          <span class="sign" aria-hidden="true">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</span>
          <span class="code">{row.text || ' '}</span>
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .diff {
    min-width: max-content;
  }
  .hunk {
    background: color-mix(in srgb, var(--muted) 70%, transparent);
    border-block: 1px solid var(--border-subtle);
  }
  .line {
    display: grid;
    grid-template-columns: 3rem 3rem 1.25rem 1fr;
    white-space: pre;
  }
  .num {
    padding-right: 0.5rem;
    text-align: right;
    color: var(--text-muted);
    user-select: none;
  }
  .sign {
    text-align: center;
    user-select: none;
    color: var(--text-muted);
  }
  .code {
    padding-right: 1rem;
    color: var(--foreground);
  }
  .add {
    background: color-mix(in srgb, var(--success) 12%, transparent);
  }
  .add .sign {
    color: var(--success);
  }
  .del {
    background: color-mix(in srgb, var(--error) 11%, transparent);
  }
  .del .sign {
    color: var(--error);
  }
</style>
