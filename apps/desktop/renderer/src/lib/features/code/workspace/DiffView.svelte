<svelte:options runes={true} />

<!--
  A unified diff of one file from its before/after text: hunks with three
  lines of context, drawn by the same rows as the transcript's diff cards.
-->

<script lang="ts">
  import { structuredPatch } from 'diff';
  import { t } from 'svelte-i18n';
  import DiffRows from '../DiffRows.svelte';
  import type { PatchRow } from '../patch';

  let { before, after, path }: { before: string; after: string; path: string } = $props();

  const rows = $derived.by((): PatchRow[] => {
    const patch = structuredPatch('a', 'b', before, after, '', '', { context: 3 });
    const out: PatchRow[] = [];
    for (const hunk of patch.hunks) {
      out.push({ kind: 'hunk', text: '' });
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
  <p class="px-3 py-3 text-xs text-muted-foreground">{$t('codeWs.noDifferences')}</p>
{:else}
  <DiffRows {rows} {path} />
{/if}
