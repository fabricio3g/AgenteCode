<svelte:options runes={true} />

<!--
  A spreadsheet the way Excel shows it: column letters and row numbers,
  gridlines, the file's own widths, fills, fonts, number formats, merges and
  frozen panes; a name box and formula bar for the selected cell; drag or
  shift-select a range to see its sum, average and count; copy as TSV; find;
  zoom; sheet tabs along the bottom. Rows are virtualized, so large sheets
  stay fast.
-->

<script lang="ts">
  import { ChevronDown, ChevronUp, Minus, Plus, Search, X } from 'lucide-svelte';
  import { t, locale } from 'svelte-i18n';
  import { readArrayBuffer } from './viewer-source';
  import ViewerStatus from './ViewerStatus.svelte';
  import { columnName, rawCell, selectionToTsv, sheetToGrid, summarize, type GridCell, type GridSheet } from './xlsx-model';
  import { createFormulaEvaluator, type CellInput } from './xlsx-formula';

  interface Props {
    src: string;
    filename: string;
    /** Find text, e.g. from the reader's search box. */
    query?: string;
  }

  let { src, filename, query = '' }: Props = $props();

  const HEADER_H = 24;
  const ROWNUM_W = 46;
  const OVERSCAN = 12;

  let loading = $state(true);
  let error = $state<string | null>(null);
  let sheets = $state<GridSheet[]>([]);
  let active = $state(0);
  let zoom = $state(1);
  let find = $state('');
  let findIndex = $state(0);
  let scroller = $state<HTMLDivElement>();
  let scrollTop = $state(0);
  let viewportH = $state(600);

  // Selection: anchor is where it started, focus is the active cell.
  let anchor = $state({ row: 0, col: 0 });
  let focus = $state({ row: 0, col: 0 });
  let dragging = false;

  const sheet = $derived(sheets[active] ?? null);
  const top = $derived(Math.min(anchor.row, focus.row));
  const bottom = $derived(Math.max(anchor.row, focus.row));
  const left = $derived(Math.min(anchor.col, focus.col));
  const right = $derived(Math.max(anchor.col, focus.col));
  const focusCell = $derived(sheet?.cells[focus.row]?.[focus.col] ?? null);
  const address = $derived(
    top === bottom && left === right
      ? `${columnName(focus.col)}${focus.row + 1}`
      : `${columnName(left)}${top + 1}:${columnName(right)}${bottom + 1}`
  );

  // Row offsets for virtualization (scaled by zoom).
  const rowTops = $derived.by(() => {
    const tops = [0];
    for (const height of sheet?.rowHeights ?? []) tops.push(tops[tops.length - 1] + height);
    return tops;
  });
  const visibleRows = $derived.by(() => {
    if (!sheet) return { start: 0, end: 0 };
    const y = scrollTop / zoom - HEADER_H;
    const h = viewportH / zoom;
    let start = 0;
    while (start < sheet.rows && rowTops[start + 1] < y) start += 1;
    let end = start;
    while (end < sheet.rows && rowTops[end] < y + h) end += 1;
    return { start: Math.max(sheet.frozenRows, start - OVERSCAN), end: Math.min(sheet.rows, end + OVERSCAN) };
  });
  const colLefts = $derived.by(() => {
    const lefts = [0];
    for (const width of sheet?.colWidths ?? []) lefts.push(lefts[lefts.length - 1] + width);
    return lefts;
  });

  const selectionStats = $derived.by(() => {
    if (!sheet || (top === bottom && left === right)) return null;
    const cells: GridCell[] = [];
    for (let r = top; r <= bottom; r += 1) for (let c = left; c <= right; c += 1) cells.push(sheet.cells[r][c]);
    return summarize(cells);
  });

  const term = $derived((find || query).trim().toLowerCase());
  const matches = $derived.by(() => {
    if (!sheet || !term) return [] as Array<{ row: number; col: number }>;
    const found: Array<{ row: number; col: number }> = [];
    sheet.cells.forEach((row, r) => row.forEach((cell, c) => {
      if (!cell.covered && cell.text.toLowerCase().includes(term)) found.push({ row: r, col: c });
    }));
    return found;
  });

  function number(value: number): string {
    return new Intl.NumberFormat($locale || 'en', { maximumFractionDigits: 2 }).format(value);
  }

  async function load() {
    loading = true;
    error = null;
    sheets = [];
    try {
      const ExcelJS = await import('exceljs');
      // Not fetch(): the app's CSP blocks fetching data: URLs.
      const buffer = await readArrayBuffer(src, 'spreadsheet');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      // Formulas saved without results (common from scripts) get computed.
      const evaluator = createFormulaEvaluator((name, row, col) => rawCell(workbook.getWorksheet(name), row, col) as CellInput);
      const next: GridSheet[] = [];
      workbook.eachSheet((worksheet) => {
        if (worksheet.state === 'hidden' || worksheet.state === 'veryHidden') return;
        const resolve = (formula: string, row: number, col: number) => evaluator.evaluateCell(formula, worksheet.name, row, col);
        next.push(sheetToGrid(worksheet, $locale || 'en', { minRows: 60, minCols: 14 }, resolve));
      });
      sheets = next;
      active = 0;
      select(0, 0);
    } catch (err) {
      console.error('[XlsxViewer] Failed to read workbook:', err);
      error = $t('viewer.sheet.failed');
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (src) void load();
  });

  function select(row: number, col: number, extend = false) {
    if (!sheet) return;
    const next = { row: Math.max(0, Math.min(sheet.rows - 1, row)), col: Math.max(0, Math.min(sheet.cols - 1, col)) };
    focus = next;
    if (!extend) anchor = next;
    reveal(next.row, next.col);
  }

  function reveal(row: number, col: number) {
    if (!scroller || !sheet) return;
    const cellTop = (rowTops[row] + HEADER_H) * zoom;
    const cellBottom = (rowTops[row + 1] + HEADER_H) * zoom;
    const frozenH = (rowTops[sheet.frozenRows] + HEADER_H) * zoom;
    if (cellTop < scroller.scrollTop + frozenH && row >= sheet.frozenRows) scroller.scrollTop = cellTop - frozenH;
    else if (cellBottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = cellBottom - scroller.clientHeight;
    const cellLeft = (colLefts[col] + ROWNUM_W) * zoom;
    const cellRight = (colLefts[col + 1] + ROWNUM_W) * zoom;
    const frozenW = (colLefts[sheet.frozenCols] + ROWNUM_W) * zoom;
    if (cellLeft < scroller.scrollLeft + frozenW && col >= sheet.frozenCols) scroller.scrollLeft = cellLeft - frozenW;
    else if (cellRight > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = cellRight - scroller.clientWidth;
  }

  function onCellDown(event: MouseEvent, row: number, col: number) {
    event.preventDefault();
    scroller?.focus({ preventScroll: true });
    select(row, col, event.shiftKey);
    dragging = true;
  }

  function onCellEnter(row: number, col: number) {
    if (dragging) focus = { row, col };
  }

  function selectColumn(col: number) {
    if (!sheet) return;
    anchor = { row: 0, col };
    focus = { row: sheet.rows - 1, col };
  }

  function selectRow(row: number) {
    if (!sheet) return;
    anchor = { row, col: 0 };
    focus = { row, col: sheet.cols - 1 };
  }

  async function copySelection() {
    if (!sheet) return;
    try {
      await navigator.clipboard.writeText(selectionToTsv(sheet, top, left, bottom, right));
    } catch {
      /* clipboard unavailable: nothing to do */
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (!sheet) return;
    const mod = event.ctrlKey || event.metaKey;
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (moves[event.key]) {
      event.preventDefault();
      const [dr, dc] = moves[event.key];
      const jump = mod ? (dr ? sheet.rows : sheet.cols) : 1;
      select(focus.row + dr * jump, focus.col + dc * jump, event.shiftKey);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      select(focus.row, focus.col + (event.shiftKey ? -1 : 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      select(focus.row + (event.shiftKey ? -1 : 1), focus.col);
    } else if (event.key === 'Home') {
      event.preventDefault();
      select(mod ? 0 : focus.row, 0, event.shiftKey);
    } else if (event.key === 'End') {
      event.preventDefault();
      select(mod ? sheet.rows - 1 : focus.row, sheet.cols - 1, event.shiftKey);
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      event.preventDefault();
      select(focus.row + (event.key === 'PageDown' ? 20 : -20), focus.col, event.shiftKey);
    } else if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      anchor = { row: 0, col: 0 };
      focus = { row: sheet.rows - 1, col: sheet.cols - 1 };
    } else if (mod && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void copySelection();
    }
  }

  function step(direction: 1 | -1) {
    if (!matches.length) return;
    findIndex = (findIndex + direction + matches.length) % matches.length;
    const hit = matches[findIndex];
    select(hit.row, hit.col);
  }

  // Jump to the first hit when the search changes.
  $effect(() => {
    if (!term) return;
    findIndex = 0;
    const hit = matches[0];
    if (hit) queueMicrotask(() => select(hit.row, hit.col));
  });

  function setZoom(next: number) {
    zoom = Math.max(0.5, Math.min(2, Math.round(next * 10) / 10));
  }

  function cellStyle(cell: GridCell, row: number, col: number): string {
    const s = cell.style;
    const parts = [
      s.fill ? `background:${s.fill}` : '',
      s.color ? `color:${s.color}` : s.fill ? 'color:#1b1b1f' : '',
      s.bold ? 'font-weight:600' : '',
      s.italic ? 'font-style:italic' : '',
      s.underline || s.strike ? `text-decoration:${[s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].join(' ').trim()}` : '',
      s.align ? `text-align:${s.align}` : '',
      s.valign ? `vertical-align:${s.valign}` : '',
      s.wrap ? 'white-space:pre-wrap' : '',
      s.fontSize ? `font-size:${Math.round((s.fontSize * 4) / 3)}px` : '',
      s.borderBottom ? 'box-shadow:inset 0 -1px 0 currentColor' : ''
    ];
    if (sheet && row < sheet.frozenRows) parts.push(`position:sticky;top:${rowTops[row] + HEADER_H}px;z-index:2`);
    if (sheet && col < sheet.frozenCols) parts.push(`position:sticky;left:${colLefts[col] + ROWNUM_W}px;z-index:${row < sheet.frozenRows ? 4 : 2}`);
    return parts.filter(Boolean).join(';');
  }

  function isSelected(row: number, col: number): boolean {
    return row >= top && row <= bottom && col >= left && col <= right;
  }

  function isMatch(row: number, col: number): boolean {
    return !!term && !!sheet?.cells[row]?.[col]?.text.toLowerCase().includes(term);
  }

  const renderRows = $derived.by(() => {
    if (!sheet) return [] as number[];
    const frozen = Array.from({ length: sheet.frozenRows }, (_, index) => index);
    const body: number[] = [];
    for (let r = visibleRows.start; r < visibleRows.end; r += 1) body.push(r);
    return [...frozen, ...body];
  });
  const spacerTop = $derived(sheet ? rowTops[visibleRows.start] - rowTops[sheet.frozenRows] : 0);
  const spacerBottom = $derived(sheet ? rowTops[sheet.rows] - rowTops[visibleRows.end] : 0);
</script>

<svelte:window onmouseup={() => (dragging = false)} />

<div class="sheet-viewer">
  {#if loading || error}
    <ViewerStatus {loading} {error} label={$t('viewer.sheet.loading')} />
  {:else if sheet}
    <!-- Name box · formula bar · find -->
    <div class="sheet-bar">
      <span class="name-box" aria-label={$t('viewer.sheet.cell')}>{address}</span>
      <span class="fx" aria-hidden="true">fx</span>
      <span class="formula" title={focusCell?.input || ''}>{focusCell?.input || ''}</span>
      <label class="find">
        <Search class="size-3.5 shrink-0 opacity-60" />
        <input
          bind:value={find}
          placeholder={$t('viewer.sheet.find')}
          aria-label={$t('viewer.sheet.find')}
          onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); } }}
        />
        {#if term}
          <span class="find-count">{matches.length ? `${findIndex + 1}/${matches.length}` : '0'}</span>
          <button type="button" class="bar-btn" onclick={() => step(-1)} aria-label={$t('viewer.previous')}><ChevronUp class="size-3.5" /></button>
          <button type="button" class="bar-btn" onclick={() => step(1)} aria-label={$t('viewer.next')}><ChevronDown class="size-3.5" /></button>
          {#if find}<button type="button" class="bar-btn" onclick={() => (find = '')} aria-label={$t('artifacts.clearSearch')}><X class="size-3.5" /></button>{/if}
        {/if}
      </label>
    </div>

    <!-- The grid -->
    <div
      class="sheet-scroll"
      bind:this={scroller}
      bind:clientHeight={viewportH}
      onscroll={() => (scrollTop = scroller?.scrollTop ?? 0)}
      onwheel={(event) => { if (event.ctrlKey || event.metaKey) { event.preventDefault(); setZoom(zoom + (event.deltaY < 0 ? 0.1 : -0.1)); } }}
      tabindex="0"
      role="grid"
      aria-label={`${filename} · ${sheet.name}`}
      aria-rowcount={sheet.rows}
      aria-colcount={sheet.cols}
      onkeydown={onKeydown}
    >
      <table class="sheet-grid" style:zoom={zoom} style:width={`${ROWNUM_W + colLefts[sheet.cols]}px`}>
        <colgroup>
          <col style:width={`${ROWNUM_W}px`} />
          {#each sheet.colWidths as width, index (index)}<col style:width={`${width}px`} />{/each}
        </colgroup>
        <thead>
          <tr style:height={`${HEADER_H}px`}>
            <th class="corner" aria-label={$t('viewer.sheet.selectAll')} onmousedown={(event) => { event.preventDefault(); anchor = { row: 0, col: 0 }; focus = { row: sheet.rows - 1, col: sheet.cols - 1 }; }}></th>
            {#each sheet.colWidths as _, col (col)}
              <th class="col-head" class:on={col >= left && col <= right} onmousedown={(event) => { event.preventDefault(); selectColumn(col); }}>{columnName(col)}</th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each renderRows as row, index (row)}
            {#if index === sheet.frozenRows && spacerTop > 0}
              <tr aria-hidden="true" style:height={`${spacerTop}px`}><td colspan={sheet.cols + 1} class="spacer"></td></tr>
            {/if}
            <tr style:height={`${sheet.rowHeights[row]}px`}>
              <th
                class="row-head"
                class:on={row >= top && row <= bottom}
                style={row < sheet.frozenRows ? `top:${rowTops[row] + HEADER_H}px;z-index:5` : ''}
                onmousedown={(event) => { event.preventDefault(); selectRow(row); }}
              >{row + 1}</th>
              {#each sheet.cells[row] as cell, col (col)}
                {#if !cell.covered}
                  <td
                    rowspan={cell.span?.rows}
                    colspan={cell.span?.cols}
                    class:sel={isSelected(row, col)}
                    class:focus={row === focus.row && col === focus.col}
                    class:hit={isMatch(row, col)}
                    style={cellStyle(cell, row, col)}
                    onmousedown={(event) => onCellDown(event, row, col)}
                    onmouseenter={() => onCellEnter(row, col)}
                  >{cell.text}</td>
                {/if}
              {/each}
            </tr>
          {/each}
          {#if spacerBottom > 0}
            <tr aria-hidden="true" style:height={`${spacerBottom}px`}><td colspan={sheet.cols + 1} class="spacer"></td></tr>
          {/if}
        </tbody>
      </table>
      {#if sheet.truncatedRows}
        <p class="truncated">{$t('viewer.sheet.truncated', { values: { n: sheet.truncatedRows } })}</p>
      {/if}
    </div>

    <!-- Sheet tabs · selection stats · zoom -->
    <div class="sheet-foot">
      <div class="tabs" role="tablist" aria-label={$t('viewer.sheet.sheets')}>
        {#each sheets as item, index (item.name)}
          <button type="button" role="tab" aria-selected={index === active} class="tab" class:on={index === active} onclick={() => { active = index; select(0, 0); }}>{item.name}</button>
        {/each}
      </div>
      <div class="stats" aria-live="polite">
        {#if selectionStats}
          {#if selectionStats.numbers}
            <span>{$t('viewer.sheet.average')}: {number(selectionStats.average)}</span>
          {/if}
          <span>{$t('viewer.sheet.count')}: {selectionStats.count}</span>
          {#if selectionStats.numbers}
            <span>{$t('viewer.sheet.sum')}: {number(selectionStats.sum)}</span>
          {/if}
        {/if}
      </div>
      <div class="zoom">
        <button type="button" class="bar-btn" onclick={() => setZoom(zoom - 0.1)} aria-label={$t('viewer.zoomOut')}><Minus class="size-3.5" /></button>
        <button type="button" class="zoom-value" onclick={() => setZoom(1)} title={$t('viewer.zoomReset')}>{Math.round(zoom * 100)}%</button>
        <button type="button" class="bar-btn" onclick={() => setZoom(zoom + 0.1)} aria-label={$t('viewer.zoomIn')}><Plus class="size-3.5" /></button>
      </div>
    </div>
  {/if}
</div>

<style>
  .sheet-viewer {
    --grid-line: color-mix(in srgb, var(--foreground) 11%, transparent);
    --sheet-accent: var(--success);
    display: flex;
    height: var(--doc-viewer-height, calc(96vh - 8rem));
    min-height: 16rem;
    flex: 1 1 auto;
    flex-direction: column;
    overflow: hidden;
    border: var(--doc-viewer-border, 1px solid var(--border));
    border-radius: var(--doc-viewer-radius, 0.75rem);
    background: var(--background);
    color: var(--foreground);
  }

  .sheet-bar {
    display: flex;
    height: 2.25rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.5rem;
    padding: 0 0.5rem;
    border-bottom: 1px solid var(--border);
    font-size: 12.5px;
  }
  .name-box {
    width: 5.5rem;
    flex-shrink: 0;
    padding: 0.2rem 0.5rem;
    border-radius: 0.375rem;
    background: var(--muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fx {
    font-style: italic;
    font-family: Georgia, serif;
    color: var(--muted-foreground);
  }
  .formula {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
  }
  .find {
    display: flex;
    width: 15rem;
    max-width: 40%;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
    padding: 0 0.25rem 0 0.5rem;
    height: 1.625rem;
    border-radius: 9999px;
    background: var(--muted);
  }
  .find input {
    min-width: 0;
    flex: 1;
    border: 0;
    background: transparent;
    font-size: 12px;
    color: inherit;
    outline: none;
  }
  .find-count {
    font-size: 11px;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
  }
  .bar-btn {
    display: inline-flex;
    width: 1.5rem;
    height: 1.5rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.375rem;
    color: var(--muted-foreground);
  }
  .bar-btn:hover {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .sheet-scroll {
    position: relative;
    min-height: 0;
    flex: 1;
    overflow: auto;
    outline: none;
    user-select: none;
  }
  .sheet-grid {
    table-layout: fixed;
    border-collapse: separate;
    border-spacing: 0;
    font-size: 13px;
    line-height: 1.35;
    font-family: Calibri, Carlito, 'Segoe UI', Inter, system-ui, sans-serif;
  }
  .sheet-grid th,
  .sheet-grid td {
    padding: 0 0.3rem;
    border-right: 1px solid var(--grid-line);
    border-bottom: 1px solid var(--grid-line);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: clip;
    vertical-align: bottom;
    background-clip: padding-box;
  }
  .sheet-grid td {
    background: var(--background);
    cursor: cell;
  }
  .sheet-grid thead th {
    position: sticky;
    top: 0;
    z-index: 6;
    background: var(--muted);
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 500;
    text-align: center;
    vertical-align: middle;
    cursor: s-resize;
  }
  .sheet-grid thead th.corner {
    left: 0;
    z-index: 7;
    cursor: pointer;
  }
  .row-head {
    position: sticky;
    left: 0;
    z-index: 3;
    background: var(--muted);
    color: var(--muted-foreground);
    font-size: 11px;
    font-weight: 500;
    text-align: center !important;
    vertical-align: middle !important;
    cursor: e-resize;
  }
  .col-head.on,
  .row-head.on {
    background: color-mix(in srgb, var(--sheet-accent) 16%, var(--muted));
    color: var(--foreground);
    box-shadow: inset 0 -2px 0 var(--sheet-accent);
  }
  .row-head.on {
    box-shadow: inset -2px 0 0 var(--sheet-accent);
  }
  .sheet-grid td.sel {
    background-image: linear-gradient(color-mix(in srgb, var(--sheet-accent) 13%, transparent), color-mix(in srgb, var(--sheet-accent) 13%, transparent));
  }
  .sheet-grid td.focus {
    outline: 2px solid var(--sheet-accent);
    outline-offset: -2px;
    background-image: none;
  }
  .sheet-grid td.hit {
    background-image: linear-gradient(color-mix(in srgb, var(--warning) 28%, transparent), color-mix(in srgb, var(--warning) 28%, transparent));
  }
  .sheet-grid td.spacer {
    padding: 0;
    border: 0;
    background: transparent;
  }
  .truncated {
    padding: 0.5rem 0.75rem;
    font-size: 12px;
    color: var(--muted-foreground);
  }

  .sheet-foot {
    display: flex;
    height: 2rem;
    flex-shrink: 0;
    align-items: center;
    gap: 0.75rem;
    padding: 0 0.5rem 0 0;
    border-top: 1px solid var(--border);
    background: var(--muted);
    font-size: 12px;
  }
  .tabs {
    display: flex;
    min-width: 0;
    flex: 1;
    align-self: stretch;
    overflow-x: auto;
  }
  .tab {
    flex-shrink: 0;
    padding: 0 0.875rem;
    color: var(--muted-foreground);
    border-right: 1px solid var(--border);
  }
  .tab:hover {
    color: var(--foreground);
  }
  .tab.on {
    background: var(--background);
    color: var(--sheet-accent);
    font-weight: 600;
    box-shadow: inset 0 -2px 0 var(--sheet-accent);
  }
  .stats {
    display: flex;
    gap: 0.875rem;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .zoom {
    display: flex;
    align-items: center;
  }
  .zoom-value {
    min-width: 2.75rem;
    font-size: 11.5px;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
  }
</style>
