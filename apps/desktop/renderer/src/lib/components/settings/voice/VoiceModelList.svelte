<svelte:options runes={true} />

<!--
  Every voice model the bundled audio.cpp can run, one row each: what it is,
  whether this computer can run it, then one action — download (with
  progress), use, or the mark that it is in use — and delete for an installed
  one. Installed and featured models come first; the rest of the catalog is a
  search or a "show all" away. Settings and the setup wizard share it.
-->

<script lang="ts">
  import { t, locale } from 'svelte-i18n';
  import { Check, Download, RotateCcw, Trash2, X } from 'lucide-svelte';
  import { Badge, Button, Tooltip } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { speechEngine, type VoiceModelFit } from '$lib/stores/speech-engine.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { cancelDownloadJob } from '$lib/services/downloads';
  import type { VoiceModel } from '$shared/voice-models';
  import ModelSearchField from '../ModelSearchField.svelte';

  let { limit = 5, searchable = true }: {
    /** Rows shown before "show all" (installed models always show). */
    limit?: number;
    searchable?: boolean;
  } = $props();

  let query = $state('');
  let showAll = $state(false);
  const active = $derived(speechEngine.active);
  const hasClones = $derived((appStore.config.tts?.cloned_voices?.length ?? 0) > 0);
  const needsClone = (model: VoiceModel) => !!model.needsReference && !hasClones;

  const STATUS_RANK: Record<string, number> = { supported: 0, community: 1, testing: 2, experimental: 3 };
  const FIT_RANK: Record<VoiceModelFit, number> = { good: 0, slow: 1, unknown: 1, no: 2 };

  const sorted = $derived(
    [...speechEngine.models].sort((a, b) => {
      const installed = Number(speechEngine.state(b) === 'installed') - Number(speechEngine.state(a) === 'installed');
      if (installed) return installed;
      const featured = Number(!!b.featured) - Number(!!a.featured);
      if (featured) return featured;
      const usable = Number(!!a.needsReference) - Number(!!b.needsReference);
      if (usable) return usable;
      const fit = FIT_RANK[speechEngine.fit(a)] - FIT_RANK[speechEngine.fit(b)];
      if (fit) return fit;
      return (STATUS_RANK[a.status ?? ''] ?? 4) - (STATUS_RANK[b.status ?? ''] ?? 4) || a.title.localeCompare(b.title);
    })
  );

  const matches = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter((model) =>
      [model.title, model.description ?? '', model.id, ...model.languages].some((text) => text.toLowerCase().includes(needle))
    );
  });

  const visible = $derived(
    showAll || query.trim()
      ? matches
      : matches.filter((model, index) => index < limit || speechEngine.state(model) !== 'available')
  );

  // A finished download is only "installed" once the main process sees the
  // files: refresh once per model, and make the first one the voice in use.
  const seen = new Set<string>();
  $effect(() => {
    for (const model of speechEngine.models) {
      if (!seen.has(model.id) && speechEngine.state(model) !== 'installed' && speechEngine.downloaded(model)) {
        seen.add(model.id);
        void speechEngine.refresh().then(() => {
          if (!speechEngine.status?.installed.some((id) => id !== model.id)) void speechEngine.use(model);
        });
      }
    }
  });

  function size(model: VoiceModel): string {
    if (!model.sizeMb) return '';
    return model.sizeMb >= 1000 ? `${(model.sizeMb / 1000).toFixed(1)} GB` : `${model.sizeMb} MB`;
  }

  function languages(model: VoiceModel): string {
    if (model.languages.length > 3) return $t('voice.engine.languages', { values: { n: model.languages.length } });
    try {
      const names = new Intl.DisplayNames([$locale || 'en'], { type: 'language' });
      return model.languages.map((code) => names.of(code) ?? code).join(', ');
    } catch {
      return model.languages.join(', ');
    }
  }

  function description(model: VoiceModel): string {
    const key = `voice.engine.${model.id}`;
    const translated = $t(key);
    return translated === key ? (model.description ?? '') : translated;
  }

  async function download(model: VoiceModel) {
    try {
      await speechEngine.download(model);
    } catch (error) {
      toastStore.error((error as Error)?.message || String(error));
    }
  }

  async function cancel(model: VoiceModel) {
    for (const job of speechEngine.jobs(model)) await cancelDownloadJob(job.id).catch(() => {});
    await downloadsStore.refresh();
  }

  function remove(model: VoiceModel) {
    confirmStore.show({
      title: $t('voice.engine.deleteTitle', { values: { name: model.title } }),
      message: $t('voice.engine.deleteMessage', { values: { size: model.sizeMb } }),
      confirmLabel: $t('voice.engine.delete'),
      danger: true,
      onConfirm: () => speechEngine.remove(model)
    });
  }
</script>

{#if searchable}
  <div class="px-4 pb-1 pt-3">
    <ModelSearchField bind:value={query} placeholder={$t('voice.catalog.search', { values: { n: speechEngine.models.length } })} label={$t('voice.catalog.searchLabel')} clearLabel={$t('modelHub.clearSearch')} />
  </div>
{/if}

{#each visible as model (model.id)}
  {@const state = speechEngine.state(model)}
  {@const fit = speechEngine.fit(model)}
  {@const inUse = active?.id === model.id}
  <div class="voice-model">
    <div class="min-w-0 flex-1">
      <p class="flex flex-wrap items-center gap-1.5 text-[length:var(--text-sm)] font-medium text-foreground">
        {model.title}
        {#if inUse}<Badge tone="success"><Check class="size-2.5" />{$t('voice.inUse')}</Badge>
        {:else if model.featured}<Badge>{$t('voice.catalog.featured')}</Badge>{/if}
        {#if model.status && model.status !== 'supported' && model.status !== 'community'}<Badge tone="warning">{$t(`voice.catalog.status.${model.status}`, { default: model.status })}</Badge>{/if}
      </p>
      {#if description(model)}<p class="line-clamp-2 text-xs text-muted-foreground">{description(model)}</p>{/if}
      <p class="mt-0.5 text-xs text-muted-foreground">
        {[languages(model), model.voices.length ? `${model.voices.length} ${$t('voice.engine.voices')}` : '', size(model), model.license].filter(Boolean).join(' · ')}
      </p>
      <p class="fit" data-fit={needsClone(model) ? 'no' : fit}>
        <span class="fit-dot" aria-hidden="true"></span>
        {needsClone(model) ? $t('voice.catalog.needsReference') : $t(`voice.catalog.fit.${fit}`)}
      </p>
      {#if state === 'downloading'}
        <div class="mt-2 flex items-center gap-2">
          <div class="progress" role="progressbar" aria-label={model.title} aria-valuemin="0" aria-valuemax="100" aria-valuenow={speechEngine.progress(model)}>
            <span style:width={`${Math.max(3, speechEngine.progress(model))}%`}></span>
          </div>
          <span class="w-9 text-right text-xs tabular-nums text-muted-foreground">{speechEngine.progress(model)}%</span>
        </div>
      {:else if state === 'failed'}
        <p class="mt-1 text-xs text-error">{$t('voice.downloadError')}</p>
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-1">
      {#if state === 'downloading'}
        <Button variant="ghost" size="sm" onclick={() => void cancel(model)}><X /> {$t('voice.cancel')}</Button>
      {:else if state === 'failed'}
        <Button variant="outline" size="sm" onclick={() => void download(model)}><RotateCcw /> {$t('voice.retry')}</Button>
      {:else if state === 'installed'}
        {#if !inUse && (!model.needsReference || hasClones)}<Button variant="outline" size="sm" onclick={() => void speechEngine.use(model)}>{$t('voice.engine.use')}</Button>{/if}
        <Tooltip label={$t('voice.engine.delete')} position="bottom"><Button variant="ghost" size="icon-sm" onclick={() => remove(model)} aria-label={$t('voice.engine.deleteTitle', { values: { name: model.title } })}>
          <Trash2 />
        </Button></Tooltip>
      {:else}
        <Button variant="outline" size="sm" disabled={!speechEngine.bundled || fit === 'no'} onclick={() => void download(model)}>
          <Download /> {size(model) ? $t('voice.engine.download', { values: { size: size(model) } }) : $t('voice.download')}
        </Button>
      {/if}
    </div>
  </div>
{:else}
  <p class="px-4 py-3 text-xs text-muted-foreground">{$t('voice.catalog.noMatches')}</p>
{/each}

{#if !showAll && !query.trim() && matches.length > visible.length}
  <button type="button" class="show-all" onclick={() => (showAll = true)}>
    {$t('voice.catalog.showAll', { values: { n: matches.length } })}
  </button>
{/if}

<style>
  .voice-model {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    padding: 0.75rem 1rem;
  }

  .fit {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.25rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }

  .fit-dot {
    width: 0.375rem;
    height: 0.375rem;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--muted-foreground);
  }

  .fit[data-fit='good'] .fit-dot { background: var(--success); }
  .fit[data-fit='slow'] .fit-dot { background: var(--warning); }
  .fit[data-fit='no'] { color: var(--error); }
  .fit[data-fit='no'] .fit-dot { background: var(--error); }

  .progress {
    height: 0.25rem;
    flex: 1;
    overflow: hidden;
    border-radius: var(--radius-full);
    background: var(--surface-active);
  }

  .progress span {
    display: block;
    height: 100%;
    background: var(--foreground);
    transition: width 300ms var(--motion-ease);
  }

  .show-all {
    display: block;
    width: 100%;
    padding: 0.625rem 1rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    text-align: center;
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }

  .show-all:hover { background: var(--float-row-hover); color: var(--foreground); }
</style>
