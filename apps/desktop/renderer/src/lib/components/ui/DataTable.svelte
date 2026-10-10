<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '$lib/utils/cn';
  import { displayCell } from '$shared/work-product';
  export type TableColumn = { key: string; label: string; align?: 'left' | 'right' };
  let { columns, rows, caption, cell, class: className = '' }: { columns: TableColumn[]; rows: Array<unknown[] | Record<string, unknown>>; caption?: string; cell?: Snippet<[unknown, number, number]>; class?: string } = $props();
</script>
<div class={cn('ui-data-table', className)}>
  <table>
    {#if caption}<caption>{caption}</caption>{/if}
    <thead><tr>{#each columns as column}<th scope="col" class:right={column.align === 'right'}>{column.label}</th>{/each}</tr></thead>
    <tbody>{#each rows as row, rowIndex}<tr>{#each columns as column, colIndex}{@const value = Array.isArray(row) ? row[colIndex] : row[column.key]}<td class:right={column.align === 'right'}>{#if cell}{@render cell(value, rowIndex, colIndex)}{:else}{displayCell(value)}{/if}</td>{/each}</tr>{/each}</tbody>
  </table>
</div>
<style>
  .ui-data-table { min-width:0; max-width:100%; overflow:auto; overscroll-behavior:contain; }
  table { width:100%; border-collapse:collapse; color:var(--foreground); font-size:var(--text-sm); }
  th, td { padding:0.5rem 0.625rem; border-bottom:1px solid var(--border-subtle); text-align:left; vertical-align:top; }
  th { font-weight:500; color:var(--muted-foreground); }
  .right { text-align:right; font-variant-numeric:tabular-nums; }
  caption { padding:0.5rem; text-align:left; color:var(--muted-foreground); font-size:var(--text-xs); }
</style>
