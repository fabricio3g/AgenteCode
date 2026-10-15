<svelte:options runes={true} />

<!--
  Every voice model the bundled audio.cpp can run, one row each: what it is,
  whether this computer can run it, then one action — download (with
  progress), use, or the mark that it is in use — and delete for an installed
  one. Installed and featured models come first; the rest of the catalog is a
  search or a "show all" away. Settings and the setup wizard share it.
  A model's other packages (Q4/Q8/F16, smaller sizes) share its row through a
  variant menu; a machine short on memory starts on the lightest that fits.
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import Progress from '$lib/components/ui/Progress.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t, locale } from 'svelte-i18n';
  import { Check, Download, RotateCcw, Trash2, X } from 'lucide-svelte';
  import { Badge, Button, Select, Tooltip } from '$lib/components/ui';
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

  /** Each model with its other packages, the recommended one first. */
  const groups = $derived.by(() => {
    const map = new Map<string, VoiceModel[]>();
    for (const model of speechEngine.models) {
      const key = model.variantOf ?? model.id;
      map.set(key, [...(map.get(key) ?? []), model]);
    }
    return map;
  });

  /** Variants picked in the menu, by group. */
  let picked = $state<Record<string, string>>({});

  /**
   * The package a row stands for: the one picked, else the one in use or on
   * disk or downloading, else the recommended one — or, where that one would
   * not run well here, the smallest that does.
   */
  function shown(members: VoiceModel[]): VoiceModel {
    const key = members[0].variantOf ?? members[0].id;
    const chosen = members.find((model) => model.id === picked[key])
      ?? members.find((model) => model.id === active?.id)
      ?? members.find((model) => speechEngine.state(model) !== 'available');
    if (chosen) return chosen;
    const primary = members[0];
    if (FIT_RANK[speechEngine.fit(primary)] === 0) return primary;
    const lighter = members.filter((model) => model.sizeMb && speechEngine.fit(model) === 'good').sort((a, b) => a.sizeMb - b.sizeMb);
    return lighter[0] ?? primary;
  }

  const rows = $derived([...groups.values()].map((members) => ({ members, model: shown(members) })));

  function variantOptions(members: VoiceModel[]) {
    return members.map((model) => ({
      value: model.id,
      label: [model.variant ?? model.id, size(model), speechEngine.state(model) === 'installed' ? $t('voice.catalog.onDisk') : ''].filter(Boolean).join(' · ')
    }));
  }

  const sorted = $derived(
    [...rows].sort(({ model: a }, { model: b }) => {
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
    return sorted.filter(({ members }) => members.some((model) =>
      [model.title, model.description ?? '', model.id, model.variant ?? '', ...model.languages].some((text) => text.toLowerCase().includes(needle))
    ));
  });

  const visible = $derived(
    showAll || query.trim()
      ? matches
      : matches.filter(({ model }, index) => index < limit || speechEngine.state(model) !== 'available')
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
    <ModelSearchField bind:value={query} placeholder={$t('voice.catalog.search', { values: { n: groups.size } })} label={$t('voice.catalog.searchLabel')} clearLabel={$t('modelHub.clearSearch')} />
  </div>
{/if}

{#each visible as { members, model } (members[0].id)}
  {@const state = speechEngine.state(model)}
  {@const fit = speechEngine.fit(model)}
  {@const inUse = active?.id === model.id}
  <div class="voice-model">
    <div class="min-w-0 flex-1">
      <p class="flex flex-wrap items-center gap-1.5 text-[length:var(--text-sm)] font-medium text-foreground">
        {model.title}
        {#if inUse}<Badge tone="neutral"><Check class="size-2.5" />{$t('voice.inUse')}</Badge>
        {:else if model.featured}<Badge>{$t('voice.catalog.featured')}</Badge>{/if}
        {#if model.status && model.status !== 'supported' && model.status !== 'community'}<Badge tone="warning">{$t(`voice.catalog.status.${model.status}`, { default: model.status })}</Badge>{/if}
      </p>
      {#if description(model)}<p class="line-clamp-2 text-xs text-muted-foreground">{description(model)}</p>{/if}
      {#if members.length > 1}
        <div class="mt-1.5 max-w-xs">
          <Select size="sm" aria-label={$t('voice.catalog.variant', { values: { name: model.title } })} options={variantOptions(members)} value={model.id}
            onchange={(id) => (picked = { ...picked, [members[0].variantOf ?? members[0].id]: id })} />
        </div>
      {/if}
      <p class="mt-0.5 text-xs text-muted-foreground">
        {[languages(model), model.voices.length ? `${model.voices.length} ${$t('voice.engine.voices')}` : '', size(model), model.license].filter(Boolean).join(' · ')}
      </p>
      <p class="fit" data-fit={needsClone(model) ? 'no' : fit}>
        <span class="fit-dot" aria-hidden="true"></span>
        {needsClone(model) ? $t('voice.catalog.needsReference') : $t(`voice.catalog.fit.${fit}`)}
      </p>
      {#if state === 'downloading'}
        <div class="mt-2 flex items-center gap-2">
          <Progress label={model.title} value={speechEngine.progress(model)} />
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
        <Tooltip label={$t('voice.engine.delete')} position="bottom"><IconButton label={$t('voice.engine.deleteTitle', { values: { name: model.title } })} variant="ghost" size="sm" onclick={() => remove(model)} >
          <Trash2 />
        </IconButton></Tooltip>
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
  <Button variant="plain" type="button" class={uiClass("show-all", "ui-local-06938eeb")} onclick={() => (showAll = true)}>
    {$t('voice.catalog.showAll', { values: { n: matches.length } })}
  </Button>
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
    border-radius: var(--radius-full);
    background: var(--muted-foreground);
  }

  .fit[data-fit='good'] .fit-dot { background: var(--success); }
  .fit[data-fit='slow'] .fit-dot { background: var(--warning); }
  .fit[data-fit='no'] { color: var(--error); }
  .fit[data-fit='no'] .fit-dot { background: var(--error); }





  :global(.show-all.ui-local-06938eeb) {
    display: block;
    width: 100%;
    padding: 0.625rem 1rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    text-align: center;
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }

  :global(.show-all:hover.ui-local-06938eeb) { background: var(--float-row-hover); color: var(--foreground); }
</style>
