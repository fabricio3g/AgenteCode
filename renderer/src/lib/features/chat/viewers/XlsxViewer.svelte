<svelte:options runes={true} />

<script lang="ts">
  import { copy } from '$lib/copy';
  import ViewerStatus from './ViewerStatus.svelte';
  import { highlightTerm } from './viewer-text';

  interface Props {
    src: string;
    filename: string;
    query?: string;
  }

  type SheetPreview = {
    name: string;
    rows: string[][];
  };

  let { src, filename, query = '' }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let sheets = $state<SheetPreview[]>([]);
  let activeSheet = $state('');

  const currentSheet = $derived(sheets.find((sheet) => sheet.name === activeSheet) || sheets[0] || null);
  const header = $derived(currentSheet?.rows[0] || []);
  const searchTerm = $derived(query.trim().toLowerCase());
  const bodyRows = $derived.by(() => {
    const rows = currentSheet?.rows.slice(1) || [];
    const filtered = searchTerm
      ? rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(searchTerm)))
      : rows;
    return filtered.slice(0, 500);
  });

  function highlightedCell(value: string) {
    return highlightTerm(value, query);
  }

  async function convertXlsx() {
    loading = true;
    error = null;
    sheets = [];
    try {
      const ExcelJS = await import('exceljs');
      const response = await fetch(src);
      const arrayBuffer = await response.arrayBuffer();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(arrayBuffer);

      const nextSheets: SheetPreview[] = [];
      workbook.eachSheet((sheet: any) => {
        const rows: string[][] = [];
        const colCount = Math.max(sheet.columnCount || 1, 1);
        sheet.eachRow({ includeEmpty: true }, (row: any) => {
          const cells: string[] = [];
          for (let c = 1; c <= colCount; c += 1) {
            const cell = row.getCell(c);
            cells.push(String(cell.text ?? cell.result ?? cell.value ?? ''));
          }
          rows.push(cells);
        });
        nextSheets.push({ name: sheet.name, rows });
      });
      sheets = nextSheets;
      activeSheet = nextSheets[0]?.name || '';
    } catch (err) {
      console.error('[XlsxViewer] Failed to convert XLSX:', err);
      error = 'Failed to preview spreadsheet';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (src) convertXlsx();
  });
</script>

<div class="xlsx-viewer">
  {#if loading || error}
    <ViewerStatus {loading} {error} label={copy.viewer.convertingSpreadsheet} />
  {:else if currentSheet}
    <div class="sheet-tabs" aria-label="{filename} sheets">
      {#each sheets as sheet (sheet.name)}
        <button type="button" class="sheet-tab" class:active={sheet.name === activeSheet} onclick={() => (activeSheet = sheet.name)}>
          {sheet.name}
        </button>
      {/each}
    </div>
    <div class="sheet-frame">
      <table>
        {#if header.length}
          <thead>
            <tr>{#each header as cell}<th>{cell}</th>{/each}</tr>
          </thead>
        {/if}
        <tbody>
          {#each bodyRows as row}
            <tr>{#each row as cell}<td>{@html highlightedCell(cell)}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>

<style>
  .xlsx-viewer {
    display: flex;
    min-height: 0;
    flex-direction: column;
    gap: 0.55rem;
  }



  .sheet-tabs {
    display: flex;
    gap: 0.25rem;
    overflow-x: auto;
  }

  .sheet-tab {
    flex-shrink: 0;
    border-radius: var(--radius-sm);
    padding: 0.35rem 0.65rem;
    color: var(--text-muted);
    font-size: 0.72rem;
    font-weight: 600;
  }

  .sheet-tab:hover,
  .sheet-tab.active {
    background: var(--surface-hover);
    color: var(--text);
  }

  .sheet-frame {
    max-height: calc(96vh - 10rem);
    overflow: auto;
    border: 1px solid var(--border);
    background: var(--surface);
  }

  table {
    min-width: 100%;
    border-collapse: collapse;
    font-size: 0.76rem;
  }

  th,
  td {
    border-bottom: 1px solid var(--border);
    border-right: 1px solid var(--border);
    padding: 0.45rem 0.55rem;
    text-align: left;
    vertical-align: top;
    white-space: pre-wrap;
  }

  th {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--surface-hover);
    color: var(--text);
    font-weight: 700;
  }

  td {
    max-width: 26rem;
    color: var(--text-secondary);
  }

  td :global(mark) {
    border-radius: 2px;
    background: color-mix(in srgb, var(--primary) 30%, transparent);
    color: inherit;
    padding: 0 0.08rem;
  }
</style>
