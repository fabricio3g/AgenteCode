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
  .ui-data-table { min-width:0; max-width:100%; overflow:auto; overscroll-behavior:contain; border:1px solid var(--float-border); border-radius:var(--float-radius); background:var(--card); }
  table { width:100%; border-collapse:collapse; color:var(--foreground); font-size:var(--text-sm); }
  th, td { padding:0.5rem 0.75rem; border-bottom:1px solid var(--border-subtle); text-align:left; vertical-align:top; }
  tbody tr:last-child td { border-bottom:0; }
  tbody tr { transition:background-color var(--motion-instant) var(--motion-ease); }
  tbody tr:hover { background:var(--float-row-hover); }
  th { font-weight:500; color:var(--muted-foreground); background:color-mix(in srgb, var(--foreground) 2.5%, transparent); }
  .right { text-align:right; font-variant-numeric:tabular-nums; }
  caption { padding:0.5rem 0.75rem; text-align:left; color:var(--muted-foreground); font-size:var(--text-xs); }
</style>
