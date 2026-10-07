<svelte:options runes={true} />

<!--
  Files: everything that passed through your chats — what you attached, in Home
  and in Code, and the documents the Code agent created in your projects — in
  one list. Each row says where it came from and offers open, show in folder,
  go to its chat, and delete (an upload leaves its chat; a created file goes to
  the system trash).
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { locale } from 'svelte-i18n';
  import {
    Copy, ExternalLink, FileArchive, FileAudio, FileCode, FileSpreadsheet, FileText, FolderOpen,
    FolderSearch, Image as ImageIcon, MessageSquare, Pin, PinOff, Presentation, Sparkles, Trash2
  } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { revealPath, trashPath } from '$lib/features/code/code-ipc';
  import { openWorkspaceFile, pathExists, listFiles, setFilePinned, trashStoredFile } from '$lib/services/files';
  import { getEmbeddingStatus, listRagDocuments } from '$lib/services/rag';
  import { FilterChip, SearchField, Select } from '$lib/components/ui';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { formatBytes } from '$lib/utils/format';
  import {
    applyRegistry, collectFiles, filterFiles, registryIndex, unusedFiles, FILE_GROUPS, FILE_SORTS, sortFiles, totalBytes,
    type FileEntry, type FileGroup, type FileOrigin, type FileSort, type StoredFileInfo
  } from './file-library';

  let query = $state('');
  let group = $state<FileGroup | 'all'>('all');
  let origin = $state<FileOrigin | 'all'>('all');
  let sort = $state<FileSort>('recent');
  let chat = $state('all');
  /** Created files no longer on disk (trashed here, or removed outside the app). */
  let missing = $state<Set<string>>(new Set());
  /** Chunks per indexed document, keyed by RAG doc id; filled from the chat's knowledge base. */
  let ragChunks = $state<Map<string, number>>(new Map());
  let embeddingsReady = $state(true);
  /** Registry rows for this app's stored copies, keyed by name and size. */
  let registry = $state<StoredFileInfo[]>([]);

  async function refreshRegistry() {
    registry = await listFiles().catch(() => []);
  }

  $effect(() => { void refreshRegistry(); });

  const all = $derived(applyRegistry(
    collectFiles(appStore.chats, (chat) => codeStore.projectById(chat.projectId ?? null)?.rootPath ?? null),
    registryIndex(registry)
  ));
  /** Stored copies no chat carries any more; pinned ones are knowledge the user kept. */
  const unused = $derived(unusedFiles(all, registry));
  const unusedBytes = $derived(unused.reduce((sum, file) => sum + file.bytes, 0));
  const entries = $derived(all.filter((entry) => !missing.has(entry.key)));
  const visible = $derived(
    sortFiles(
      filterFiles(entries, query, group, origin).filter((entry) => chat === 'all' || entry.chatId === chat),
      sort
    )
  );
  const chats = $derived(
    [...new Map(entries.map((entry) => [entry.chatId, entry.chatTitle])).entries()]
      .map(([id, title]) => ({ id, title }))
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }))
  );
  const groups = $derived(
    FILE_GROUPS
      .map((id) => ({ id, count: entries.filter((entry) => entry.group === id && (origin === 'all' || entry.origin === origin)).length }))
      .filter((item) => item.count > 0)
  );
  const counts = $derived({
    all: entries.length,
    uploaded: entries.filter((entry) => entry.origin === 'uploaded').length,
    created: entries.filter((entry) => entry.origin === 'created').length
  });

  // What each attachment's knowledge base actually holds. The status is fetched
  // with the documents because "indexed" alone hides whether retrieval can use
  // vectors: without the embedding server the answer is keyword-only.
  $effect(() => {
    const chatIds = [...new Set(entries.filter((entry) => entry.attachment?.docId).map((entry) => entry.chatId))];
    if (!chatIds.length) { ragChunks = new Map(); return; }
    let cancelled = false;
    void (async () => {
      const [status, ...lists] = await Promise.all([
        getEmbeddingStatus().catch(() => null),
        ...chatIds.map((id) => listRagDocuments(id).catch(() => []))
      ]);
      if (cancelled) return;
      const chunks = new Map<string, number>();
      for (const doc of lists.flat()) chunks.set(doc.id, doc.chunk_count);
      ragChunks = chunks;
      embeddingsReady = !status || status.state === 'ready' || status.state === 'starting';
    })();
    return () => { cancelled = true; };
  });

  // Created files are only known from the transcript; ask the disk which still exist.
  $effect(() => {
    const created = all.filter((entry) => entry.origin === 'created' && entry.path);
    let cancelled = false;
    void Promise.all(created.map(async (entry) => [entry.key, await pathExists(entry.path!).catch(() => true)] as const))
      .then((results) => {
        if (cancelled) return;
        const gone = results.filter(([, exists]) => !exists).map(([key]) => key);
        if (gone.length) missing = new Set([...missing, ...gone]);
      });
    return () => { cancelled = true; };
  });

  const ICONS: Record<FileGroup, typeof FileText> = {
    images: ImageIcon, pdfs: FileText, documents: FileText, spreadsheets: FileSpreadsheet,
    presentations: Presentation, text: FileCode, media: FileAudio, other: FileArchive
  };

  function when(ts: number): string {
    if (!ts) return '';
    const days = Math.floor((Date.now() - ts) / 86_400_000);
    const lang = $locale || 'en';
    if (days < 7) return new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-days, 'day');
    return new Date(ts).toLocaleDateString(lang, { month: 'short', day: 'numeric' });
  }

  /** `indexed · 42 chunks`, or why the model will not get vectors for it. */
  function ragState(entry: FileEntry): string {
    const docId = entry.attachment?.docId;
    if (!docId) return '';
    if (!embeddingsReady) return $t('files.keywordOnly');
    const chunks = ragChunks.get(docId);
    return chunks ? $t('files.indexedChunks', { values: { count: chunks } }) : $t('files.indexed');
  }

  async function copyPath(entry: FileEntry) {
    if (!entry.path) return;
    const copied = await writeToClipboard(entry.path);
    if (copied) toastStore.success($t('files.copied'));
    else toastStore.error($t('files.copyFailed'));
  }

  function thumbOf(entry: FileEntry): string | null {
    if (entry.group !== 'images' || !entry.attachment) return null;
    return entry.attachment.preview || entry.attachment.base64 || null;
  }

  /** Home uploads live inline and Code uploads are app-owned copies; only files on disk can be opened. */
  function canOpen(entry: FileEntry): boolean {
    return !!entry.path;
  }

  /** Code uploads stay: the Code engine keeps its own copy of the conversation. */
  function canDelete(entry: FileEntry): boolean {
    return entry.origin === 'created' ? !!entry.projectRoot : !!entry.attachment;
  }

  async function open(entry: FileEntry) {
    if (entry.path) await openWorkspaceFile(entry.path, entry.projectRoot).catch(() => toastStore.error($t('files.openFailed')));
  }

  async function reveal(entry: FileEntry) {
    if (!entry.path || !entry.projectRoot) return;
    const result = await revealPath(entry.projectRoot, entry.path).catch(() => null);
    if (!result?.ok) toastStore.error($t('files.openFailed'));
  }

  async function togglePin(entry: FileEntry) {
    if (!entry.hash) return;
    const updated = await setFilePinned(entry.hash, !entry.pinned).catch(() => null);
    if (!updated) { toastStore.error($t('files.actionFailed')); return; }
    registry = registry.map((file) => (file.hash === updated.hash ? { ...file, pinned: updated.pinned } : file));
  }

  function confirmCleanup() {
    const count = unused.length;
    const size = formatBytes(unusedBytes);
    confirmStore.show({
      title: $t('files.cleanupTitle'),
      message: $t('files.cleanupMessage', { values: { count, size } }),
      confirmLabel: $t('files.trashConfirm'),
      danger: true,
      onConfirm: async () => {
        let moved = 0;
        for (const file of unused) {
          const result = await trashStoredFile(file.hash).catch(() => null);
          if (result?.ok) moved++;
        }
        await refreshRegistry();
        if (moved) toastStore.success($t('files.cleanupDone', { values: { count: moved } }));
        else toastStore.error($t('files.actionFailed'));
      }
    });
  }

  function confirmDelete(entry: FileEntry) {
    const created = entry.origin === 'created';
    confirmStore.show({
      title: $t(created ? 'files.trashTitle' : 'files.deleteTitle'),
      message: $t(created ? 'files.trashMessage' : 'files.deleteMessage', { values: { name: entry.name, chat: entry.chatTitle } }),
      confirmLabel: $t(created ? 'files.trashConfirm' : 'files.deleteConfirm'),
      danger: true,
      onConfirm: async () => {
        if (created) {
          const result = await trashPath(entry.projectRoot!, entry.path!).catch(() => null);
          if (!result?.ok) { toastStore.error($t('files.trashFailed', { values: { reason: result?.error ?? '' } })); return; }
          missing = new Set([...missing, entry.key]);
        } else if (entry.attachment) {
          await appStore.deleteUpload(entry.chatId, entry.messageId, entry.attachment.id);
        }
      }
    });
  }
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col bg-background" aria-label={$t('files.title')}>
  <div class="ui-top-fade flex min-h-0 min-w-0 flex-1 flex-col">
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-[1100px] px-5 pb-10 pt-8 sm:px-8">
        <header class="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h1 class="text-2xl font-semibold tracking-[-0.02em] text-foreground">{$t('files.title')}</h1>
            <p class="mt-1 text-sm text-muted-foreground">{$t('files.description')}</p>
          </div>
          {#if entries.length}
            <div class="flex items-center gap-3">
              {#if unused.length}
                <button type="button" class="cleanup" onclick={confirmCleanup}>
                  {$t('files.cleanup', { values: { count: unused.length, size: formatBytes(unusedBytes) } })}
                </button>
              {/if}
              <p class="text-[12px] tabular-nums text-muted-foreground">{$t('files.summary', { values: { count: entries.length, size: formatBytes(totalBytes(entries)) } })}</p>
            </div>
          {/if}
        </header>

        {#if !entries.length}
          <div class="mt-16 flex flex-col items-center text-center">
            <span class="flex size-14 items-center justify-center rounded-2xl bg-[var(--muted)] text-muted-foreground"><Sparkles class="size-6" /></span>
            <h2 class="mt-4 text-base font-semibold text-foreground">{$t('files.emptyTitle')}</h2>
            <p class="mt-1 max-w-sm text-sm text-muted-foreground">{$t('files.emptyHint')}</p>
          </div>
        {:else}
          <div class="mt-6 flex flex-wrap items-center gap-2">
            <SearchField bind:value={query} placeholder={$t('files.search')} clearLabel={$t('files.clearSearch')} />
            {#if chats.length > 1}
              <Select
                bind:value={chat}
                aria-label={$t('files.chat')}
                options={[{ value: 'all', label: $t('files.allChats') }, ...chats.map((item) => ({ value: item.id, label: item.title }))]}
              />
            {/if}
            {#if entries.length > 1}
              <Select
                bind:value={sort}
                aria-label={$t('files.sortLabel')}
                options={FILE_SORTS.map((id) => ({ value: id, label: $t(`files.sort.${id}`) }))}
              />
            {/if}
          </div>
          <div class="mt-3 flex flex-wrap gap-1.5" role="group" aria-label={$t('files.origin')}>
            <FilterChip on={origin === 'all'} count={counts.all} onclick={() => (origin = 'all')}>{$t('files.all')}</FilterChip>
            {#if counts.uploaded}<FilterChip on={origin === 'uploaded'} count={counts.uploaded} onclick={() => (origin = 'uploaded')}>{$t('files.uploaded')}</FilterChip>{/if}
            {#if counts.created}<FilterChip on={origin === 'created'} count={counts.created} onclick={() => (origin = 'created')}>{$t('files.created')}</FilterChip>{/if}
            {#if groups.length > 1}
              <span class="mx-1 h-8 w-px bg-[var(--border)]" aria-hidden="true"></span>
              {#each groups as item (item.id)}
                <FilterChip on={group === item.id} count={item.count} onclick={() => (group = group === item.id ? 'all' : item.id)}>{$t(`files.group.${item.id}`)}</FilterChip>
              {/each}
            {/if}
          </div>

          {#if visible.length}
            <ul class="mt-6 flex flex-col divide-y divide-[var(--border-subtle)] overflow-hidden rounded-2xl border border-border">
              {#each visible as entry (entry.key)}
                {@const Icon = ICONS[entry.group]}
                {@const thumb = thumbOf(entry)}
                <li class="row group">
                  <span class="thumb" aria-hidden="true">
                    {#if thumb}<img src={thumb} alt="" />{:else}<Icon class="size-4" />{/if}
                  </span>
                  <div class="min-w-0 flex-1">
                    <p class="flex items-center gap-2">
                      <span class="truncate text-sm font-medium text-foreground" title={entry.path ?? entry.name}>{entry.name}</span>
                      {#if entry.origin === 'created'}<span class="badge">{$t('files.createdBadge')}</span>{/if}
                      {#if entry.pinned}<span class="badge">{$t('files.pin')}</span>{/if}
                      {#if entry.attachment?.status === 'error'}<span class="badge is-error" title={entry.attachment.error}>{$t('files.failed')}</span>{/if}
                    </p>
                    <p class="mt-0.5 truncate text-[12px] text-muted-foreground">
                      {[entry.chatTitle, when(entry.createdAt), entry.size ? formatBytes(entry.size) : '', ragState(entry)].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <div class="actions">
                    {#if canOpen(entry)}
                      <button type="button" class="action" aria-label={$t('files.open')} title={$t('files.open')} onclick={() => open(entry)}><ExternalLink class="size-3.5" /></button>
                    {/if}
                    {#if entry.origin === 'created' && entry.projectRoot}
                      <button type="button" class="action" aria-label={$t('files.reveal')} title={$t('files.reveal')} onclick={() => reveal(entry)}><FolderSearch class="size-3.5" /></button>
                    {/if}
                    {#if entry.path}
                      <button type="button" class="action" aria-label={$t('files.copyPath')} title={$t('files.copyPath')} onclick={() => copyPath(entry)}><Copy class="size-3.5" /></button>
                    {/if}
                    {#if entry.hash}
                      <button
                        type="button"
                        class="action"
                        aria-label={$t(entry.pinned ? 'files.unpin' : 'files.pin')}
                        title={$t(entry.pinned ? 'files.unpin' : 'files.pin')}
                        onclick={() => togglePin(entry)}
                      >
                        {#if entry.pinned}<PinOff class="size-3.5" />{:else}<Pin class="size-3.5" />{/if}
                      </button>
                    {/if}
                    <button type="button" class="action" aria-label={$t('files.openChat')} title={$t('files.openChat')} onclick={() => appStore.selectChat(entry.chatId)}><MessageSquare class="size-3.5" /></button>
                    {#if canDelete(entry)}
                      <button type="button" class="action is-danger" aria-label={$t('files.delete')} title={$t('files.delete')} onclick={() => confirmDelete(entry)}><Trash2 class="size-3.5" /></button>
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="mt-12 flex items-center justify-center gap-2 text-center text-sm text-muted-foreground"><FolderOpen class="size-4" /> {$t('files.noMatches')}</p>
          {/if}
        {/if}
      </div>
    </div>
  </div>
</section>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem 0.875rem;
    transition: background-color var(--motion-fast) var(--motion-ease);
  }
  .row:hover,
  .row:focus-within {
    background: var(--surface-hover);
  }
  .thumb {
    display: flex;
    flex-shrink: 0;
    width: 2.25rem;
    height: 2.25rem;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: 0.625rem;
    background: var(--muted);
    color: var(--muted-foreground);
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .badge {
    flex-shrink: 0;
    border-radius: 9999px;
    padding: 0 0.5rem;
    font-size: var(--text-xs, 12px);
    line-height: 1.25rem;
    color: var(--muted-foreground);
    background: var(--muted);
  }
  .badge.is-error {
    color: var(--destructive);
  }
  .actions {
    display: flex;
    flex-shrink: 0;
    gap: 0.125rem;
    opacity: 0;
    transition: opacity var(--motion-fast) var(--motion-ease);
  }
  .row:hover .actions,
  .row:focus-within .actions {
    opacity: 1;
  }
  .action {
    display: flex;
    width: 1.875rem;
    height: 1.875rem;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    color: var(--muted-foreground);
    transition: color var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);
  }
  .action:hover,
  .action:focus-visible {
    color: var(--foreground);
    background: var(--background);
    outline: none;
  }
  .action.is-danger:hover,
  .action.is-danger:focus-visible {
    color: var(--destructive);
  }
  .cleanup {
    border-radius: 9999px;
    padding: 0.25rem 0.75rem;
    font-size: var(--text-xs, 12px);
    color: var(--muted-foreground);
    background: var(--muted);
    transition: color var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);
  }
  .cleanup:hover,
  .cleanup:focus-visible {
    color: var(--foreground);
    background: var(--surface-hover);
    outline: none;
  }
  @media (hover: none) {
    .actions { opacity: 1; }
  }
</style>
