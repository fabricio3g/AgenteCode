<svelte:options runes={true} />

<!--
  On this computer: the hardware, the engines that run things offline
  (versions, updates) and what the data folder holds. The full llama.cpp
  build list stays one click away for people who pick builds by hand.
-->

<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { get } from 'svelte/store';
  import { Brain, Check, FolderOpen, Mic, RefreshCw, Sparkles, Volume2 } from 'lucide-svelte';
  import { invoke, listen } from '$lib/services/bridge';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { downloadRuntime } from '$lib/services/files';
  import { getRuntimeRecommendations } from '$lib/services/system-info';
  import { fetchLlamaReleaseAssets, toDownloadPayload, type ReleaseAsset } from '$lib/services/llama-releases';
  import { formatBytes } from '$lib/utils/format';
  import { Badge, Button, Disclosure } from '$lib/components/ui';
  import SettingsPage from '../SettingsPage.svelte';
  import SettingsSection from '../SettingsSection.svelte';
  import HardwareSummary from '../HardwareSummary.svelte';
  import LocalRuntimePanel from '../LocalRuntimePanel.svelte';

  type Build = { id: string; tag: string; variant: string; path: string; selected: boolean; bytes: number; modified: number };
  type Overview = {
    llama: { builds: Build[] };
    whisper: { builds: Build[]; gpu: { source: 'built-in' | 'borrowed' | 'none'; backend: string | null }; server: boolean };
    storage: { root: string; total: number; categories: Record<'chat' | 'speech' | 'voices' | 'engines' | 'other', number> };
  };

  let overview = $state<Overview | null>(null);
  let llamaLatest = $state<ReleaseAsset | null>(null);
  let whisperLatest = $state<{ tag: string } | null>(null);
  let checking = $state(false);
  /** Update status is only claimed after a check succeeded. */
  let llamaChecked = $state(false);
  let whisperChecked = $state(false);
  let busy = $state<'llama' | 'whisper' | 'cleanup' | null>(null);
  let progress = $state(0);

  const llamaSelected = $derived(overview?.llama.builds.find((b) => b.selected) ?? null);
  const whisperSelected = $derived(overview?.whisper.builds.find((b) => b.selected) ?? null);
  const llamaUpdate = $derived(!!llamaLatest && !overview?.llama.builds.some((b) => b.tag === llamaLatest!.tag) ? llamaLatest : null);

  /** "b5130 · Vulkan GPU via llama.cpp · dictation". */
  const whisperMeta = $derived.by(() => {
    if (!whisperSelected) return $t('computer.notInstalled');
    const gpu = overview?.whisper.gpu;
    const backend = /vulkan/i.test(gpu?.backend || '') ? 'Vulkan' : /cuda/i.test(gpu?.backend || '') ? 'CUDA' : 'GPU';
    const where = gpu?.source === 'borrowed' ? $t('computer.gpuBorrowed', { values: { backend } })
      : gpu?.source === 'built-in' ? $t('computer.gpu') : $t('computer.cpuOnly');
    return [whisperSelected.tag, where, $t('computer.runsDictation')].join(' · ');
  });

  const CATEGORY_COLORS = { chat: '#7a8fd9', speech: '#5aa37c', voices: '#d9a45a', engines: '#9a9a9a', other: '#c9c9c9' } as const;
  const categories = $derived.by(() => {
    if (!overview) return [];
    const c = overview.storage.categories;
    return (Object.keys(CATEGORY_COLORS) as Array<keyof typeof CATEGORY_COLORS>)
      .map((key) => ({ key, bytes: c[key], color: CATEGORY_COLORS[key] }))
      .filter((item) => item.bytes > 0);
  });

  function variantLabel(variant: string): string {
    const known: Record<string, string> = { vulkan: 'Vulkan', cuda: 'CUDA', rocm: 'ROCm', metal: 'Metal', cpu: 'CPU' };
    return known[variant] ?? '';
  }

  async function refresh() {
    overview = await invoke<Overview>('get_engine_overview').catch(() => null);
  }

  async function checkUpdates() {
    checking = true;
    try {
      const platform = await getRuntimeRecommendations();
      const release = await fetchLlamaReleaseAssets(platform);
      llamaChecked = release.notice === '';
      llamaLatest = llamaChecked ? (release.assets.find((a) => a.variant === 'recommended') ?? release.assets[0] ?? null) : null;
      try {
        whisperLatest = await invoke<{ tag: string } | null>('check_whisper_update');
        whisperChecked = true;
      } catch {
        whisperChecked = false;
      }
    } finally {
      checking = false;
    }
  }

  async function updateLlama() {
    if (!llamaLatest) return;
    busy = 'llama';
    progress = 0;
    try {
      await downloadRuntime(toDownloadPayload(llamaLatest));
      await refresh();
      // Switch to the new build; the previous one stays for a rollback.
      const fresh = overview?.llama.builds.find((b) => b.tag === llamaLatest!.tag);
      if (fresh) await appStore.setLocalRuntimePath(fresh.path);
      await refresh();
      toastStore.success(get(t)('computer.updated', { values: { name: 'llama.cpp', tag: llamaLatest.tag } }));
    } catch (err) {
      toastStore.error((err as Error)?.message || String(err));
    } finally {
      busy = null;
    }
  }

  async function updateWhisper() {
    busy = 'whisper';
    progress = 0;
    try {
      overview = await invoke<Overview>(whisperSelected ? 'update_whisper_engine' : 'setup_voice').then(() => invoke<Overview>('get_engine_overview'));
      whisperLatest = null;
      toastStore.success(get(t)('computer.updated', { values: { name: 'whisper.cpp', tag: whisperSelected?.tag ?? '' } }));
    } catch (err) {
      toastStore.error((err as Error)?.message || String(err));
    } finally {
      busy = null;
    }
  }

  async function cleanup() {
    const accepted = await confirmStore.ask({
      title: get(t)('computer.cleanupTitle'),
      message: get(t)('computer.cleanupMessage'),
      confirmLabel: get(t)('computer.cleanup')
    });
    if (!accepted) return;
    busy = 'cleanup';
    try {
      const result = await invoke<{ freed: number; removed: string[] }>('cleanup_engines');
      toastStore.success(result.removed.length
        ? get(t)('computer.cleanedUp', { values: { size: formatBytes(result.freed) } })
        : get(t)('computer.nothingToClean'));
      await refresh();
    } finally {
      busy = null;
    }
  }

  let unlisteners: Array<() => void> = [];
  onMount(async () => {
    await refresh();
    void checkUpdates();
    unlisteners = await Promise.all([
      listen<{ progress?: number }>('runtime-download-progress', (e) => (progress = Number(e?.progress ?? 0))),
      listen<{ progress?: number }>('whisper-runtime-download-progress', (e) => (progress = Number(e?.progress ?? 0))),
      listen<{ progress?: number }>('voice-setup-progress', (e) => (progress = Number(e?.progress ?? 0)))
    ]);
  });
  onDestroy(() => unlisteners.forEach((off) => off()));
</script>

{#snippet engineRow(Icon: typeof Brain, name: string, license: string, meta: string)}
  <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--muted)] text-muted-foreground">
    <Icon class="size-4" />
  </span>
  <div class="min-w-0 flex-1">
    <p class="flex items-center gap-1.5 text-sm font-medium text-foreground">{name}<span class="license">{license}</span></p>
    <p class="truncate text-xs text-muted-foreground">{meta}</p>
  </div>
{/snippet}

{#snippet status(isBusy: boolean, update: string | null, onupdate: () => void, installed: boolean, oninstall: () => void, checked: boolean)}
  {#if isBusy}
    <span class="w-20 text-right text-xs tabular-nums text-muted-foreground">{Math.round(progress)}%</span>
  {:else if !installed}
    <Button size="sm" onclick={oninstall}>{$t('computer.install')}</Button>
  {:else if update}
    <Button size="sm" onclick={onupdate}>{$t('computer.updateTo', { values: { tag: update } })}</Button>
  {:else if checked}
    <Badge tone="success" class="gap-1"><Check class="size-2.5" />{$t('computer.upToDate')}</Badge>
  {/if}
{/snippet}

<SettingsPage title={$t('computer.title')} description={$t('computer.description')}>
  <HardwareSummary />

  <SettingsSection title={$t('computer.engines')} description={$t('computer.enginesHint')}>
    {#snippet actions()}
      <Button variant="ghost" size="icon-sm" onclick={() => void checkUpdates()} disabled={checking} aria-label={$t('computer.checkUpdates')} title={$t('computer.checkUpdates')}>
        <RefreshCw class={checking ? 'animate-spin' : ''} />
      </Button>
    {/snippet}

    <div class="flex items-center gap-3 py-3">
      {@render engineRow(Brain, 'llama.cpp', 'MIT', llamaSelected
        ? [llamaSelected.tag, variantLabel(llamaSelected.variant), $t('computer.runsChat')].filter(Boolean).join(' · ')
        : $t('computer.notInstalled'))}
      {@render status(busy === 'llama', llamaUpdate?.tag ?? null, () => void updateLlama(), !!llamaSelected, () => void updateLlama(), llamaChecked)}
    </div>

    <div class="flex items-center gap-3 py-3">
      {@render engineRow(Mic, 'whisper.cpp', 'MIT', whisperMeta)}
      {@render status(busy === 'whisper', whisperLatest?.tag ?? null, () => void updateWhisper(), !!whisperSelected, () => void updateWhisper(), whisperChecked)}
    </div>

    <div class="flex items-center gap-3 py-3">
      {@render engineRow(Volume2, 'Kokoro', 'Apache-2.0', $t('computer.runsVoice'))}
      <Badge tone="neutral">{$t('computer.builtIn')}</Badge>
    </div>
  </SettingsSection>

  {#if overview}
    {@const total = overview.storage.total}
    <SettingsSection title={$t('computer.storage')}>
      {#snippet actions()}
        <span class="text-xs tabular-nums text-muted-foreground">{formatBytes(total)}</span>
      {/snippet}
      <div class="py-3">
        <p class="truncate text-xs text-muted-foreground" title={overview.storage.root}>{overview.storage.root}</p>
        <div class="storage-bar mt-2.5" aria-hidden="true">
          {#each categories as item (item.key)}
            <span style:width={`${(item.bytes / Math.max(1, overview.storage.total)) * 100}%`} style:background={item.color}></span>
          {/each}
        </div>
        <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {#each categories as item (item.key)}
            <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
              <i class="size-2 rounded-sm" style:background={item.color}></i>
              {$t(`computer.category.${item.key}`)} · {formatBytes(item.bytes)}
            </span>
          {/each}
        </div>
      </div>
      <div class="flex flex-wrap gap-2 py-3">
        <Button variant="outline" size="sm" onclick={() => void invoke('open_data_folder')}><FolderOpen /> {$t('computer.openFolder')}</Button>
        <Button variant="outline" size="sm" onclick={() => void cleanup()} loading={busy === 'cleanup'}><Sparkles /> {$t('computer.cleanup')}</Button>
      </div>
    </SettingsSection>
  {/if}

  <Disclosure title={$t('computer.manageBuilds')} description={$t('computer.manageBuildsHint')} class="border border-[var(--border)] bg-[var(--card)]">
    <div class="space-y-4">
      <LocalRuntimePanel />
    </div>
  </Disclosure>
</SettingsPage>

<style>
  .license {
    padding: 0 0.4rem;
    border-radius: var(--radius-full);
    background: var(--muted);
    font-size: 0.65rem;
    font-weight: 500;
    color: var(--muted-foreground);
  }

  .storage-bar {
    display: flex;
    height: 0.5rem;
    overflow: hidden;
    border-radius: var(--radius-full);
    background: var(--muted);
  }

  .storage-bar span {
    height: 100%;
    transition: width 300ms var(--motion-ease);
  }
</style>
