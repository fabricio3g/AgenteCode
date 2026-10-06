<svelte:options runes={true} />

<!--
  Model profile panel: stats, download options, details, README.
  Pure view over detail data built by ModelWorkspace; actions
  delegate back (download, load, open web).
-->

<script lang="ts">
  import { Check, Download, ExternalLink, LoaderCircle, X } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { Badge, Button, Disclosure, Tooltip } from '$lib/components/ui';
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

<aside class="flex w-full flex-col overflow-hidden rounded-[0.875rem] border border-[var(--border)] bg-[var(--card)]" aria-label={$t('modelHub.profile')}>
  <div class="flex items-start gap-3 p-4 pb-2">
    <div class="min-w-0 flex-1">
      <h3 class="truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground">{detail.title}</h3>
      <p class="truncate text-xs text-muted-foreground">{detail.repoId}</p>
    </div>
    <Tooltip label={$t('modelHub.closeProfile')} position="bottom"><Button variant="ghost" size="icon-sm" onclick={onclose} aria-label={$t('modelHub.closeProfile')}><X /></Button></Tooltip>
  </div>

  <div class="flex flex-wrap items-center gap-1.5 px-4 pb-3 text-[length:var(--text-xs)] text-muted-foreground">
    {#if detail.params}<Badge>{detail.params}</Badge>{/if}
    {#if detail.gated}<Badge tone="warning">{$t('modelHub.gated')}</Badge>{/if}
    {#each detail.capabilities as capability (capability)}<Badge>{capability}</Badge>{/each}
    {#if detail.downloads}<span class="tabular-nums">{$t('modelHub.downloadsCount', { values: { n: detail.downloads } })}</span>{/if}
    {#if detail.updated}<span>· {detail.updated}</span>{/if}
  </div>

  {#if detail.summary}
    <p class="px-4 pb-3 text-xs leading-relaxed text-foreground">{detail.summary}</p>
  {/if}

  {#if detail.downloadedName}
    <div class="mx-3 mb-3 flex items-center gap-2 rounded-xl bg-[var(--muted)] px-3 py-2.5">
      <div class="min-w-0 flex-1">
        <p class="text-[length:var(--text-xs)] text-muted-foreground">{$t('modelHub.onThisComputer')}</p>
        <p class="truncate text-xs font-medium text-foreground">{detail.downloadedName}</p>
      </div>
      {#if detail.loaded}
        <Button variant="ghost" size="sm" onclick={onunload}>{$t('modelHub.unload')}</Button>
      {:else}
        <Button size="sm" onclick={onuseinchat}>{$t('modelHub.load')}</Button>
      {/if}
    </div>
  {/if}

  <div class="border-t border-[var(--border-subtle)] px-4 py-3">
    <h4 class="text-[length:var(--text-sm)] font-semibold text-foreground">{$t('modelHub.chooseFile')}</h4>
    <p class="text-[length:var(--text-xs)] text-muted-foreground">{$t('modelHub.chooseFileHint')}</p>
    {#if detail.error}
      <p class="mt-2 text-xs text-error">{detail.error}</p>
    {:else if detail.files.length}
      <ul class="-mx-1 mt-2 max-h-56 overflow-y-auto" role="radiogroup" aria-label={$t('modelHub.chooseFile')}>
        {#each detail.files as file (file.filename)}
          {@const chosen = selectedFile?.filename === file.filename}
          <li>
            <button
              type="button"
              role="radio"
              aria-checked={chosen}
              class="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left hover:bg-[var(--surface-hover)]"
              title={file.filename}
              onclick={() => onselectfile(file.filename)}
            >
              <span class="flex size-4 shrink-0 items-center justify-center rounded-full border {chosen ? 'border-primary bg-primary text-primary-fg' : 'border-border'}">
                {#if chosen}<Check class="size-2.5" />{/if}
              </span>
              <span class="w-16 shrink-0 text-[length:var(--text-xs)] text-foreground">{file.quantization || 'GGUF'}</span>
              <span class="flex-1 text-[length:var(--text-xs)] tabular-nums text-muted-foreground">{file.sizeHuman}</span>
              <Badge tone={file.fitTone}>{file.fitLabel}</Badge>
            </button>
          </li>
        {/each}
      </ul>
      <div class="mt-3 flex gap-1.5">
        <Button size="sm" class="flex-1" onclick={() => selectedFile && ondownload(selectedFile.filename)}>
          <Download /> {$t('modelHub.download')}{selectedFile ? ` · ${selectedFile.sizeHuman}` : ''}
        </Button>
        <Button variant="outline" size="sm" onclick={() => selectedFile && ondownloadload(selectedFile.filename)} title={$t('modelHub.downloadAndLoadHint')}>
          {$t('modelHub.downloadAndLoad')}
        </Button>
      </div>
    {:else}
      <p class="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle class="size-3.5 animate-spin" /> {$t('modelHub.loadingFiles')}</p>
    {/if}
  </div>

  <div class="border-t border-[var(--border-subtle)] px-4 py-3">
    <dl class="space-y-1.5 text-xs">
      {#if detail.architecture}
        <div class="flex gap-2"><dt class="w-24 shrink-0 text-muted-foreground">{$t('modelHub.architecture')}</dt><dd class="text-foreground">{detail.architecture}</dd></div>
      {/if}
      {#if detail.license}
        <div class="flex gap-2"><dt class="w-24 shrink-0 text-muted-foreground">{$t('modelHub.license')}</dt><dd class="text-foreground">{detail.license}</dd></div>
      {/if}
      {#if detail.formats.length}
        <div class="flex gap-2"><dt class="w-24 shrink-0 text-muted-foreground">{$t('modelHub.formats')}</dt><dd class="text-foreground">{detail.formats.join(', ')}</dd></div>
      {/if}
    </dl>
    <Button variant="ghost" size="sm" class="-ml-2 mt-2" onclick={onopenweb}><ExternalLink /> {$t('modelHub.openOnHf')}</Button>
  </div>

  <div class="border-t border-[var(--border-subtle)] p-3">
    <Disclosure title={$t('modelHub.readme')} class="border-0 bg-card">
      {#if detail.readmeLoading}
        <p class="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle class="size-3.5 animate-spin" /> {$t('modelHub.loadingReadme')}</p>
      {:else if detail.readme}
        <div class="markdown-body max-h-72 overflow-y-auto text-xs">{@html renderMarkdown(detail.readme, { cache: false })}</div>
      {:else}
        <p class="text-xs text-muted-foreground">{$t('modelHub.noReadme')}</p>
      {/if}
    </Disclosure>
  </div>
</aside>
