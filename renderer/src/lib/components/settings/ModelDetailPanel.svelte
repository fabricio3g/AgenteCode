<svelte:options runes={true} />

<!--
  Model profile panel: stats, download options, details, README.
  Pure view over detail data built by ModelWorkspace; actions
  delegate back (download, load, open web).
-->

<script lang="ts">
  import { Download, ExternalLink, LoaderCircle, X } from 'lucide-svelte';
  import { Badge, Button, Select } from '$lib/components/ui';
  import { renderMarkdown } from '$lib/utils/markdown';

  export interface DetailFile {
    filename: string;
    sizeHuman: string;
    quantization: string;
    fitLabel: string;
    fitTone: 'success' | 'warning' | 'error' | 'neutral';
    warn: boolean;
  }

  export interface ModelDetail {
    title: string;
    repoId: string;
    author: string;
    downloads: string;
    likes: string;
    updated: string;
    staffPick: boolean;
    gated: boolean;
    license: string;
    params: string;
    architecture: string;
    formats: string[];
    capabilities: string[];
    summary: string;
    files: DetailFile[];
    readme: string;
    readmeLoading: boolean;
    error: string;
    downloadedName: string | null;
    loaded: boolean;
  }

  let {
    detail,
    selectedFilename,
    onselectfile,
    ondownload,
    ondownloadload,
    onuseinchat,
    onunload,
    onopenweb,
    onclose
  }: {
    detail: ModelDetail;
    selectedFilename: string;
    onselectfile: (filename: string) => void;
    ondownload: (filename: string) => void;
    ondownloadload: (filename: string) => void;
    onuseinchat: () => void;
    onunload: () => void;
    onopenweb: () => void;
    onclose: () => void;
  } = $props();

  const selectedFile = $derived(detail.files.find((f) => f.filename === selectedFilename) ?? detail.files[0]);
</script>

<aside class="flex w-full flex-col overflow-hidden rounded-xl bg-card shadow-[inset_0_0_0_1px_var(--border)] lg:w-[360px] lg:shrink-0" aria-label="Model profile">
  <div class="flex items-start gap-3 p-4 pb-3">
    <div class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-lg font-bold text-fg-secondary" aria-hidden="true">
      {(detail.author || detail.title || '?').trim().charAt(0).toUpperCase()}
    </div>
    <div class="min-w-0 flex-1">
      <h3 class="truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">{detail.title}</h3>
      <p class="truncate text-xs text-muted-foreground">{detail.repoId}</p>
    </div>
    <button
      type="button"
      class="rounded-md p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
      onclick={onclose}
      aria-label="Close profile"
    >
      <X class="size-4" />
    </button>
  </div>

  <div class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-3 text-[11px] text-muted-foreground">
    <span class="tabular-nums">{detail.downloads} downloads</span>
    <span class="tabular-nums">{detail.likes} likes</span>
    {#if detail.staffPick}<Badge tone="neutral">Staff pick</Badge>{/if}
    {#if detail.gated}<Badge tone="warning">Gated</Badge>{/if}
    {#if detail.updated}<span>Updated {detail.updated}</span>{/if}
  </div>

  <div class="px-4 pb-3">
    <Button variant="ghost" size="sm" class="text-xs" onclick={onopenweb}>
      <ExternalLink class="size-3.5" />Open on Web
    </Button>
  </div>

  <div class="border-t border-[var(--border-subtle)] p-4">
    <h4 class="text-[13px] font-semibold text-foreground">Download Options</h4>
    {#if detail.error}
      <p class="mt-2 text-xs text-error">{detail.error}</p>
    {:else if detail.files.length}
      <div class="mt-2">
        <Select
          value={selectedFile?.filename ?? ''}
          options={detail.files.map((f) => ({
            value: f.filename,
            label: `${f.quantization || 'GGUF'} · ${f.sizeHuman}`
          }))}
          aria-label="Quantization"
          onchange={(next) => onselectfile(next)}
        />
      </div>
      {#if selectedFile?.warn}
        <div class="mt-2">
          <Badge tone="warning">Likely too large for this device</Badge>
        </div>
      {/if}
      <div class="mt-2 flex gap-1.5">
        <Button size="sm" class="flex-1 text-xs" onclick={() => selectedFile && ondownload(selectedFile.filename)}>
          <Download class="size-3.5" />Download{#if selectedFile} · {selectedFile.sizeHuman}{/if}
        </Button>
      </div>
      <button
        type="button"
        class="mt-1.5 w-full text-center text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
        onclick={() => selectedFile && ondownloadload(selectedFile.filename)}
      >
        Download &amp; use in chat
      </button>
    {:else}
      <p class="mt-2 text-xs text-muted-foreground">Loading artifacts…</p>
    {/if}
  </div>

  {#if detail.downloadedName}
    <div class="border-t border-[var(--border-subtle)] p-4">
      <h4 class="text-[13px] font-semibold text-foreground">On this device</h4>
      <div class="mt-2 flex items-center gap-2">
        <p class="min-w-0 flex-1 truncate text-xs text-foreground">{detail.downloadedName}</p>
        {#if detail.loaded}
          <Badge tone="success">In chat</Badge>
          <Button variant="ghost" size="sm" class="shrink-0 text-xs" onclick={onunload}>Unload</Button>
        {:else}
          <Button size="sm" class="shrink-0 text-xs" onclick={onuseinchat}>Use in chat</Button>
        {/if}
      </div>
    </div>
  {/if}

  <div class="border-t border-[var(--border-subtle)] p-4">
    <h4 class="text-[13px] font-semibold text-foreground">Details</h4>
    {#if detail.summary}
      <p class="mt-1.5 text-xs leading-relaxed text-foreground">{detail.summary}</p>
    {/if}
    <dl class="mt-2 space-y-1.5 text-xs">
      {#if detail.params}
        <div class="flex items-center gap-2">
          <dt class="w-20 shrink-0 text-muted-foreground">Parameters</dt>
          <dd><Badge tone="neutral">{detail.params}</Badge></dd>
        </div>
      {/if}
      {#if detail.architecture}
        <div class="flex items-center gap-2">
          <dt class="w-20 shrink-0 text-muted-foreground">Architecture</dt>
          <dd><Badge tone="neutral">{detail.architecture}</Badge></dd>
        </div>
      {/if}
      {#if detail.formats.length}
        <div class="flex items-center gap-2">
          <dt class="w-20 shrink-0 text-muted-foreground">Formats</dt>
          <dd class="flex flex-wrap gap-1">{#each detail.formats as format (format)}<Badge tone="neutral">{format}</Badge>{/each}</dd>
        </div>
      {/if}
      {#if detail.license}
        <div class="flex items-center gap-2">
          <dt class="w-20 shrink-0 text-muted-foreground">License</dt>
          <dd class="text-foreground">{detail.license}</dd>
        </div>
      {/if}
      {#if detail.capabilities.length}
        <div class="flex items-center gap-2">
          <dt class="w-20 shrink-0 text-muted-foreground">Capabilities</dt>
          <dd class="flex flex-wrap gap-1">{#each detail.capabilities as capability (capability)}<Badge tone="neutral">{capability}</Badge>{/each}</dd>
        </div>
      {/if}
    </dl>
  </div>

  <div class="border-t border-[var(--border-subtle)] p-4">
    <h4 class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Readme</h4>
    {#if detail.readmeLoading}
      <div class="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <LoaderCircle class="size-3.5 animate-spin" />Loading readme…
      </div>
    {:else if detail.readme}
      <div class="markdown-body mt-1.5 max-h-64 overflow-y-auto text-xs">{@html renderMarkdown(detail.readme, { cache: false })}</div>
    {:else}
      <p class="mt-1.5 text-xs text-muted-foreground">No readme available.</p>
    {/if}
  </div>
</aside>
