<svelte:options runes={true} />

<!--
  How chats think: a cloud provider (paste a key, test it, pick a model) or a
  model on this computer (llama.cpp at the tested version, plus a model sized
  for this hardware). Either can be skipped and set up later in Settings.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Check, Cloud, Download, HardDrive, LoaderCircle, TriangleAlert } from 'lucide-svelte';
  import { Badge, Button, Input, Select } from '$lib/components/ui';
  import { invoke, listen } from '$lib/services/bridge';
  import { appStore } from '$lib/stores/app.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { cloudProviders, isProviderConfigured, providerMeta } from '$lib/utils/providers';
  import { DEFAULT_PROVIDER_ID } from '$shared/providers';
  import TESTED from '$shared/engine-versions.json';
  import { gatherOnboardingHardware, getRecommendedModels, type OnboardingModel } from '$lib/services/onboarding';
  import { getInstalledRuntimes, downloadRuntime } from '$lib/services/files';
  import { getLocalModels } from '$lib/services/models';
  import { startDownloadHf } from '$lib/services/downloads';
  import { getRuntimeRecommendations } from '$lib/services/system-info';
  import { fetchLlamaReleaseList, toDownloadPayload } from '$lib/services/llama-releases';
  import type { HardwareInfo, LocalModel } from '$lib/types/bridge';
  import SetupFooter from './SetupFooter.svelte';

  let { onback, onnext }: { onback: () => void; onnext: () => void } = $props();

  type View = 'choose' | 'cloud' | 'local';
  let view = $state<View>('choose');
  let choice = $state<'cloud' | 'local'>(appStore.backendMode === 'local' ? 'local' : 'cloud');

  // ── Cloud ────────────────────────────────────────────────────────────
  type Connection = { ok: true; models: string[] } | { ok: false; reason: string; status?: number };
  const providers = $derived(cloudProviders().filter((p) => p.group === 'cloud'));
  let providerId = $state(appStore.backendMode === 'api' && appStore.activeProviderName ? appStore.activeProviderName : DEFAULT_PROVIDER_ID);
  let apiKey = $state('');
  let testing = $state(false);
  let connection = $state<Connection | null>(null);
  let model = $state('');
  let saving = $state(false);
  const hasSavedKey = $derived(isProviderConfigured(appStore.config, providerId));
  const meta = $derived(providerMeta(providerId));

  function pickProvider(id: string) {
    providerId = id;
    apiKey = '';
    connection = null;
    model = '';
  }

  async function connect() {
    testing = true;
    try {
      connection = await invoke<Connection>('test_provider_connection', {
        baseUrl: meta?.defaultBaseUrl,
        apiKey: apiKey.trim() || undefined,
        providerName: providerId
      });
      if (connection.ok) {
        const saved = appStore.config.llm?.providers?.[providerId]?.model;
        model = saved && connection.models.includes(saved) ? saved : connection.models[0] ?? '';
      }
    } catch (error) {
      connection = { ok: false, reason: 'unreachable' };
      console.warn('[setup] connection test failed', error);
    } finally {
      testing = false;
    }
  }

  async function saveCloud() {
    saving = true;
    try {
      await appStore.updateProvider({ provider: providerId, ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}), model }, { activate: true });
      await appStore.setBackendMode('api');
      onnext();
    } finally {
      saving = false;
    }
  }

  // ── On this computer ─────────────────────────────────────────────────
  let hardware = $state<HardwareInfo | null>(null);
  let runtimes = $state<Array<{ path: string }>>([]);
  let localFiles = $state<LocalModel[]>([]);
  let models = $state<OnboardingModel[]>([]);
  let chosen = $state('');
  let engineBusy = $state(false);
  let engineProgress = $state(0);
  let engineError = $state('');
  let localSaving = $state(false);
  const hasEngine = $derived(runtimes.length > 0);

  function fileOf(entry: OnboardingModel): LocalModel | undefined {
    return localFiles.find((file) => file.path.endsWith(entry.filename) || file.name === entry.filename);
  }

  function jobOf(entry: OnboardingModel) {
    return downloadsStore.jobFor(entry.repoId, entry.filename);
  }

  async function refreshLocal() {
    const [installed, files] = await Promise.all([
      getInstalledRuntimes().catch(() => ({ runtimes: [] })),
      getLocalModels().catch(() => [])
    ]);
    runtimes = installed.runtimes ?? [];
    localFiles = files;
  }

  async function installEngine() {
    engineBusy = true;
    engineError = '';
    engineProgress = 0;
    const off = await listen<{ progress?: number }>('runtime-download-progress', (event) => (engineProgress = Number(event?.progress ?? 0)));
    try {
      const releases = await fetchLlamaReleaseList(await getRuntimeRecommendations());
      const release = releases.find((r) => r.tag === TESTED.llama) ?? releases[0];
      if (!release) throw new Error($t('onboarding.noEngineBuild'));
      await downloadRuntime(toDownloadPayload(release.asset));
      await refreshLocal();
      const fresh = runtimes.find((runtime) => runtime.path.includes(release.tag)) ?? runtimes[0];
      if (fresh) await appStore.setLocalRuntimePath(fresh.path);
    } catch (error) {
      engineError = (error as Error)?.message || String(error);
    } finally {
      off();
      engineBusy = false;
    }
  }

  async function downloadModel(entry: OnboardingModel) {
    chosen = entry.id;
    await startDownloadHf({ repo_id: entry.repoId, file: entry.filename });
    downloadsStore.startPolling();
    await downloadsStore.refresh();
  }

  // A finished download shows up in the library once; check once per job.
  const seenJobs = new Set<string>();
  $effect(() => {
    for (const entry of models) {
      const job = jobOf(entry);
      if (job?.status === 'completed' && !seenJobs.has(job.id)) {
        seenJobs.add(job.id);
        void refreshLocal();
      }
    }
  });

  const chosenEntry = $derived(models.find((entry) => entry.id === chosen));
  const chosenFile = $derived(chosenEntry ? fileOf(chosenEntry) : undefined);

  async function saveLocal() {
    if (!chosenFile) return;
    localSaving = true;
    try {
      await appStore.setBackendMode('local');
      await appStore.updateLocalModel({ id: chosenFile.id, name: chosenFile.name, source: 'local', path: chosenFile.path, details: chosenFile.size_label });
      onnext();
    } finally {
      localSaving = false;
    }
  }

  onMount(async () => {
    const result = await gatherOnboardingHardware();
    hardware = result.hardware;
    models = getRecommendedModels(hardware);
    await refreshLocal();
    chosen = models.find((entry) => fileOf(entry))?.id ?? models[0]?.id ?? '';
  });

  function sizeOf(entry: OnboardingModel): string {
    return entry.sizeLabel.replace(/^~/, '');
  }
</script>

{#if view === 'choose'}
  <div class="setup-step">
    <div>
      <h3 class="setup-title">{$t('onboarding.models.title')}</h3>
      <p class="setup-lead">{$t('onboarding.models.lead')}</p>
    </div>
    <div class="setup-choices" role="radiogroup" aria-label={$t('onboarding.models.title')}>
      <button type="button" class="setup-choice" class:is-selected={choice === 'cloud'} role="radio" aria-checked={choice === 'cloud'} onclick={() => (choice = 'cloud')}>
        <Cloud class="size-5" />
        <span class="setup-choice-title">{$t('onboarding.models.cloud')}</span>
        <span class="setup-choice-text">{$t('onboarding.models.cloudHint')}</span>
      </button>
      <button type="button" class="setup-choice" class:is-selected={choice === 'local'} role="radio" aria-checked={choice === 'local'} onclick={() => (choice = 'local')}>
        <HardDrive class="size-5" />
        <span class="setup-choice-title">{$t('onboarding.models.local')}</span>
        <span class="setup-choice-text">{$t('onboarding.models.localHint')}</span>
      </button>
    </div>
  </div>
  <SetupFooter {onback} skipLabel={$t('onboarding.later')} onskip={onnext} primaryLabel={$t('onboarding.continue')} onprimary={() => (view = choice)} />

{:else if view === 'cloud'}
  <div class="setup-step">
    <div>
      <h3 class="setup-title">{$t('onboarding.cloud.title')}</h3>
      <p class="setup-lead">{$t('onboarding.cloud.lead')}</p>
    </div>
    <div class="setup-fields">
      <label class="setup-field">
        <span>{$t('onboarding.cloud.provider')}</span>
        <Select class="w-full" value={providerId} options={providers.map((p) => ({ value: p.id, label: p.label }))} onchange={pickProvider} />
      </label>
      <label class="setup-field">
        <span class="flex items-center justify-between gap-2">
          {$t('providers.apiKey')}
          {#if meta?.keyUrl}<a href={meta.keyUrl} target="_blank" rel="noreferrer" class="font-normal text-muted-foreground hover:text-foreground hover:underline">{$t('providers.getKey')} ↗</a>{/if}
        </span>
        <Input type="password" autocomplete="off" bind:value={apiKey} placeholder={hasSavedKey ? $t('onboarding.cloud.keySaved') : 'sk-…'} oninput={() => (connection = null)} />
      </label>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" loading={testing} disabled={!apiKey.trim() && !hasSavedKey} onclick={() => void connect()}>{$t('onboarding.cloud.connect')}</Button>
        {#if connection?.ok}
          <span class="flex items-center gap-1 text-xs text-success"><Check class="size-3.5" /> {$t('providers.testOk', { values: { n: connection.models.length } })}</span>
        {:else if connection}
          <span class="flex items-center gap-1 text-xs text-error"><TriangleAlert class="size-3.5" /> {$t(`providers.fail.${connection.reason}`, { values: { host: meta?.label ?? providerId, status: connection.status ?? '' } })}</span>
        {/if}
      </div>
      {#if connection?.ok && connection.models.length}
        <label class="setup-field">
          <span>{$t('onboarding.cloud.model')}</span>
          <Select class="w-full" value={model} options={connection.models.map((id) => ({ value: id, label: id }))} onchange={(id) => (model = id)} />
        </label>
      {/if}
    </div>
  </div>
  <SetupFooter onback={() => (view = 'choose')} primaryLabel={$t('onboarding.continue')} primaryDisabled={!connection?.ok || !model} primaryLoading={saving} onprimary={() => void saveCloud()} />

{:else}
  <div class="setup-step">
    <div>
      <h3 class="setup-title">{$t('onboarding.local.title')}</h3>
      <p class="setup-lead">
        {hardware
          ? $t('onboarding.local.lead', { values: { ram: Math.round(hardware.total_ram_gb), gpu: hardware.gpu_name || $t('runtime.noGpu') } })
          : $t('onboarding.local.leadUnknown')}
      </p>
    </div>

    <div class="setup-card">
      <div class="setup-row">
        <div class="min-w-0 flex-1">
          <p class="text-[length:var(--text-sm)] font-medium text-foreground">llama.cpp</p>
          <p class="text-xs text-muted-foreground">{hasEngine ? $t('onboarding.local.engineReady') : $t('onboarding.local.engineHint', { values: { tag: TESTED.llama } })}</p>
          {#if engineError}<p class="mt-1 text-xs text-error">{engineError}</p>{/if}
        </div>
        {#if hasEngine}
          <Badge tone="success"><Check class="size-2.5" />{$t('onboarding.installed')}</Badge>
        {:else if engineBusy}
          <span class="text-xs tabular-nums text-muted-foreground"><LoaderCircle class="mr-1 inline size-3.5 animate-spin" />{Math.round(engineProgress)}%</span>
        {:else}
          <Button variant="outline" size="sm" onclick={() => void installEngine()}><Download /> {$t('onboarding.install')}</Button>
        {/if}
      </div>
    </div>

    <div class="setup-card" role="radiogroup" aria-label={$t('onboarding.local.models')}>
      {#each models as entry (entry.id)}
        {@const file = fileOf(entry)}
        {@const job = jobOf(entry)}
        {@const downloading = !file && job && ['queued', 'running'].includes(job.status)}
        <div class="setup-row">
          <button type="button" class="setup-radio" role="radio" aria-checked={chosen === entry.id} aria-label={entry.label} onclick={() => (chosen = entry.id)}>
            {#if chosen === entry.id}<span></span>{/if}
          </button>
          <div class="min-w-0 flex-1">
            <p class="flex items-center gap-1.5 text-[length:var(--text-sm)] font-medium text-foreground">
              {entry.label}
              {#if entry.recommended}<Badge>{$t('voice.catalog.featured')}</Badge>{/if}
            </p>
            <p class="text-xs text-muted-foreground">{sizeOf(entry)} · {$t('onboarding.local.minRam', { values: { n: entry.minRamGb } })}</p>
            {#if downloading}
              <div class="setup-progressbar"><span style:width={`${Math.max(3, Number(job.progress ?? 0))}%`}></span></div>
            {/if}
          </div>
          {#if file}
            <Badge tone="success"><Check class="size-2.5" />{$t('onboarding.installed')}</Badge>
          {:else if downloading}
            <span class="text-xs tabular-nums text-muted-foreground">{Math.round(Number(job.progress ?? 0))}%</span>
          {:else}
            <Button variant="outline" size="sm" onclick={() => void downloadModel(entry)}><Download /> {$t('onboarding.download')}</Button>
          {/if}
        </div>
      {/each}
    </div>
  </div>
  <SetupFooter onback={() => (view = 'choose')} primaryLabel={$t('onboarding.continue')} primaryDisabled={!hasEngine || !chosenFile} primaryLoading={localSaving} onprimary={() => void saveLocal()} />
{/if}
