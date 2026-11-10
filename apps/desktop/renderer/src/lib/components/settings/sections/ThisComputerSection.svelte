<svelte:options runes={true} />

<!--
  On this computer: the hardware, the engines that run things offline and what
  the data folder holds.

  Only audio.cpp (the voice engine) ships with the app. llama.cpp and
  whisper.cpp come from their official releases when you ask for them: each
  row lists recent releases built for this machine, marks the one Agente is
  tested with (shared/engine-versions.json), and installs or switches to the
  one you pick. Older builds stay for a rollback until "Clean up".
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

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
  import { fetchLlamaReleaseList, toDownloadPayload, type ReleaseAsset } from '$lib/services/llama-releases';
  import { downloadSpeechEngine, speechEngineStatus, type SpeechEngineStatus } from '$lib/services/speech-engine';
  import { formatBytes } from '$lib/utils/format';
  import { speechEngine } from '$lib/stores/speech-engine.svelte';
  import TESTED from '$shared/engine-versions.json';
  import { Badge, Button, Disclosure, Select, Tooltip } from '$lib/components/ui';
  import SettingsPage from '../SettingsPage.svelte';
  import SettingsSection from '../SettingsSection.svelte';
  import SettingsRow from '../SettingsRow.svelte';
  import HardwareSummary from '../HardwareSummary.svelte';
  import LocalRuntimePanel from '../LocalRuntimePanel.svelte';
  import LocalServerSettings from '../LocalServerSettings.svelte';
  import WhisperRuntimePanel from '../WhisperRuntimePanel.svelte';
  import AudioEnginePanel from '../AudioEnginePanel.svelte';

  type Build = { id: string; tag: string; variant: string; path: string; selected: boolean; bytes: number; modified: number };
  type Overview = {
    llama: { builds: Build[] };
    whisper: { builds: Build[]; gpu: { source: 'built-in' | 'borrowed' | 'none'; backend: string | null }; server: boolean };
    storage: { root: string; total: number; categories: Record<'chat' | 'speech' | 'voices' | 'engines' | 'other', number> };
  };

  let overview = $state<Overview | null>(null);
  let speech = $state<SpeechEngineStatus | null>(null);
  let llamaReleases = $state<Array<{ tag: string; asset: ReleaseAsset }>>([]);
  let whisperReleases = $state<Array<{ tag: string }>>([]);
  let llamaPick = $state('');
  let whisperPick = $state('');
  let checking = $state(false);
  let listError = $state('');
  let busy = $state<'llama' | 'whisper' | 'audio' | 'cleanup' | null>(null);
  let progress = $state(0);

  const llamaSelected = $derived(overview?.llama.builds.find((b) => b.selected) ?? null);
  const whisperSelected = $derived(overview?.whisper.builds.find((b) => b.selected) ?? null);

  const llamaMeta = $derived(llamaSelected
    ? [llamaSelected.tag, variantLabel(llamaSelected.variant), $t('computer.runsChat')].filter(Boolean).join(' · ')
    : $t('computer.notInstalledChat'));

  /** "b5130 · Vulkan GPU via llama.cpp · dictation". */
  const whisperMeta = $derived.by(() => {
    if (!whisperSelected) return $t('computer.notInstalledDictation');
    const gpu = overview?.whisper.gpu;
    const backend = /vulkan/i.test(gpu?.backend || '') ? 'Vulkan' : /cuda/i.test(gpu?.backend || '') ? 'CUDA' : 'GPU';
    const where = gpu?.source === 'borrowed' ? $t('computer.gpuBorrowed', { values: { backend } })
      : gpu?.source === 'built-in' ? $t('computer.gpu') : $t('computer.cpuOnly');
    return [whisperSelected.tag, where, $t('computer.runsDictation')].join(' · ');
  });

  /** "v0.8.2 · Vulkan · Kokoro 82M · reads replies aloud". */
  const speechMeta = $derived.by(() => {
    if (!speech?.backends.length) return speech?.downloadable.length ? $t('computer.notInstalled') : $t('computer.notBundled');
    const accel = speech.backend === 'vulkan' ? 'Vulkan' : 'CPU';
    const inUse = speechEngine.active?.title ?? speech.installed[0];
    return [speech.version, accel, inUse ?? $t('computer.noVoiceModel'), $t('computer.runsVoice')].filter(Boolean).join(' · ');
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

  /** "b11146 · Recommended · Installed". */
  function versionLabel(tag: string, tested: string, installed: Build[]): string {
    return [
      tag,
      tag === tested ? $t('computer.recommended') : '',
      installed.some((b) => b.tag === tag) ? $t('computer.installed') : ''
    ].filter(Boolean).join(' · ');
  }

  /** The build in use when it is listed, else the tested release, else the newest. */
  function defaultPick(tags: string[], tested: string, current?: string | null): string {
    if (current && tags.includes(current)) return current;
    return tags.includes(tested) ? tested : tags[0] ?? '';
  }

  async function refresh() {
    [overview, speech] = await Promise.all([
      invoke<Overview>('get_engine_overview').catch(() => null),
      speechEngineStatus()
    ]);
  }

  async function loadReleases() {
    checking = true;
    listError = '';
    try {
      const platform = await getRuntimeRecommendations();
      const [llama, whisper] = await Promise.all([
        fetchLlamaReleaseList(platform).catch(() => []),
        invoke<Array<{ tag: string }>>('list_whisper_releases').catch(() => [])
      ]);
      llamaReleases = llama;
      whisperReleases = whisper;
      if (!llama.length && !whisper.length) listError = $t('computer.releasesUnavailable');
      llamaPick = defaultPick(llama.map((r) => r.tag), TESTED.llama, llamaSelected?.tag);
      whisperPick = defaultPick(whisper.map((r) => r.tag), TESTED.whisper, whisperSelected?.tag);
    } finally {
      checking = false;
    }
  }

  async function installLlama() {
    const release = llamaReleases.find((r) => r.tag === llamaPick);
    if (!release) return;
    busy = 'llama';
    progress = 0;
    try {
      const existing = overview?.llama.builds.find((b) => b.tag === release.tag);
      if (!existing) await downloadRuntime(toDownloadPayload(release.asset));
      await refresh();
      const build = overview?.llama.builds.find((b) => b.tag === release.tag);
      if (build) await appStore.setLocalRuntimePath(build.path);
      await refresh();
      toastStore.success(get(t)('computer.updated', { values: { name: 'llama.cpp', tag: release.tag } }));
    } catch (error) {
      toastStore.error((error as Error)?.message || String(error));
    } finally {
      busy = null;
    }
  }

  /** Fetch the tested audio.cpp: Vulkan where it is published (it also runs on the CPU). */
  async function installAudio() {
    const backend = speech?.downloadable.includes('vulkan') ? 'vulkan' : speech?.downloadable[0];
    if (!backend) return;
    busy = 'audio';
    progress = 0;
    try {
      await downloadSpeechEngine(backend);
      await Promise.all([refresh(), speechEngine.refresh()]);
      toastStore.success(get(t)('computer.updated', { values: { name: 'audio.cpp', tag: TESTED.audio } }));
    } catch (error) {
      toastStore.error((error as Error)?.message || String(error));
    } finally {
      busy = null;
    }
  }

  async function installWhisper() {
    busy = 'whisper';
    progress = 0;
    try {
      overview = await invoke<Overview>('update_whisper_engine', { tag: whisperPick || undefined });
      toastStore.success(get(t)('computer.updated', { values: { name: 'whisper.cpp', tag: whisperPick } }));
    } catch (error) {
      toastStore.error((error as Error)?.message || String(error));
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
    void speechEngine.refresh();
    await refresh();
    void loadReleases();
    unlisteners = await Promise.all([
      listen<{ progress?: number }>('runtime-download-progress', (e) => (progress = Number(e?.progress ?? 0))),
      listen<{ progress?: number }>('whisper-runtime-download-progress', (e) => (progress = Number(e?.progress ?? 0))),
      listen<{ progress?: number }>('audio-runtime-download-progress', (e) => (progress = Number(e?.progress ?? 0))),
      listen<{ progress?: number }>('voice-setup-progress', (e) => (progress = Number(e?.progress ?? 0)))
    ]);
  });
  onDestroy(() => unlisteners.forEach((off) => off()));
</script>

{#snippet versionControl(engine: 'llama' | 'whisper', tags: string[], tested: string, installed: Build[], current: string | null, pick: string, onpick: (tag: string) => void, oninstall: () => void)}
  {#if busy === engine}
    <span class="flex items-center gap-2 text-xs tabular-nums text-muted-foreground">
      <span class="progress"><span style:width={`${Math.max(3, progress)}%`}></span></span>{Math.round(progress)}%
    </span>
  {:else if tags.length}
    <div class="flex items-center gap-1.5">
      <Select
        class="w-48"
        aria-label={$t('computer.version')}
        value={pick}
        options={tags.map((tag) => ({ value: tag, label: versionLabel(tag, tested, installed) }))}
        onchange={onpick}
      />
      {#if pick === current}
        <Badge tone="neutral"><Check class="size-2.5" />{$t('computer.inUse')}</Badge>
      {:else}
        <Button variant="outline" size="sm" onclick={oninstall}>
          {installed.some((b) => b.tag === pick) ? $t('computer.switch') : $t('computer.install')}
        </Button>
      {/if}
    </div>
  {:else if checking}
    <span class="text-xs text-muted-foreground">{$t('computer.checking')}</span>
  {/if}
{/snippet}

<SettingsPage title={$t('computer.title')} description={$t('computer.description')}>
  <HardwareSummary />

  <LocalServerSettings />

  <SettingsSection title={$t('computer.engines')} description={$t('computer.enginesHint')}>
    {#snippet actions()}
      <Tooltip label={$t('computer.checkUpdates')} position="bottom"><IconButton label={$t('computer.checkUpdates')} variant="ghost" size="sm" onclick={() => void loadReleases()} disabled={checking} >
        <RefreshCw class={checking ? 'animate-spin' : ''} />
      </IconButton></Tooltip>
    {/snippet}

    <SettingsRow label="llama.cpp" description={`MIT · ${llamaMeta}`} control="auto" align="start">
      {#snippet tile()}<Brain class="size-4" />{/snippet}
      {@render versionControl('llama', llamaReleases.map((r) => r.tag), TESTED.llama, overview?.llama.builds ?? [], llamaSelected?.tag ?? null, llamaPick, (tag) => (llamaPick = tag), () => void installLlama())}
    </SettingsRow>

    <SettingsRow label="whisper.cpp" description={`MIT · ${whisperMeta}`} control="auto" align="start">
      {#snippet tile()}<Mic class="size-4" />{/snippet}
      {@render versionControl('whisper', whisperReleases.map((r) => r.tag), TESTED.whisper, overview?.whisper.builds ?? [], whisperSelected?.tag ?? null, whisperPick, (tag) => (whisperPick = tag), () => void installWhisper())}
    </SettingsRow>

    <!-- Reading replies aloud runs on the bundled audio.cpp server; Kokoro and
         Supertonic are voice models it loads, chosen in Settings → Voice. -->
    <SettingsRow label="audio.cpp" description={`Apache-2.0 · ${speechMeta}`} control="auto" align="start">
      {#snippet tile()}<Volume2 class="size-4" />{/snippet}
      {#if busy === 'audio'}
        <span class="text-xs tabular-nums text-muted-foreground">{progress}%</span>
      {:else if speech && !speech.backends.length && speech.downloadable.length}
        <Button variant="outline" size="sm" onclick={() => void installAudio()} disabled={!!busy}>{$t('computer.install')}</Button>
      {:else if speech?.backends.length && !speech.installed.length}
        <Button variant="outline" size="sm" onclick={() => appStore.openSettings('voice')}>{$t('computer.setUpVoice')}</Button>
      {:else if speech?.backends.length}
        <Badge>{speech.running ? $t('computer.running') : $t('computer.bundled')}</Badge>
      {/if}
    </SettingsRow>

    {#if listError}
      <p class="px-4 py-2.5 text-xs text-muted-foreground">{listError}</p>
    {/if}
  </SettingsSection>

  {#if overview}
    {@const total = overview.storage.total}
    <SettingsSection title={$t('computer.storage')}>
      {#snippet actions()}
        <span class="text-xs tabular-nums text-muted-foreground">{formatBytes(total)}</span>
      {/snippet}
      <div class="px-4 py-3.5">
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
      <div class="flex flex-wrap gap-2 px-4 py-3">
        <Button variant="outline" size="sm" onclick={() => void invoke('open_data_folder')}><FolderOpen /> {$t('computer.openFolder')}</Button>
        <Button variant="outline" size="sm" onclick={() => void cleanup()} loading={busy === 'cleanup'}><Sparkles /> {$t('computer.cleanup')}</Button>
      </div>
    </SettingsSection>
  {/if}

  <Disclosure title={$t('computer.llamaBuilds')} description={$t('computer.llamaBuildsHint')}>
    <div class="space-y-4">
      <LocalRuntimePanel />
    </div>
  </Disclosure>

  <Disclosure title={$t('computer.whisperBuilds')} description={$t('computer.whisperBuildsHint')}>
    <WhisperRuntimePanel />
  </Disclosure>

  <Disclosure title="audio.cpp" description={$t('computer.audioEngineHint')}>
    <AudioEnginePanel />
  </Disclosure>
</SettingsPage>

<style>
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

  .progress {
    display: inline-block;
    width: 6rem;
    height: 0.25rem;
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
</style>
