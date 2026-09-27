<svelte:options runes={true} />

<!--
  The llama.cpp engine: which build runs local models, what it is doing right
  now, and where to get another build. Installed builds come first because
  that is what people come here to check; installing is the second section.
-->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import { get } from 'svelte/store';
  import { Check, Download, LoaderCircle, RefreshCw, Square, Trash2, TriangleAlert, Zap } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { hardwareStore } from '$lib/stores/hardware.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { deleteRuntimeBinary, downloadRuntime, getInstalledRuntimes } from '$lib/services/files';
  import { getSupervisorStatus, getRuntimeTelemetry, stopLlama } from '$lib/services/runtime';
  import type { RuntimeTelemetry } from '$lib/types/bridge';
  import { listen } from '$lib/services/bridge';
  import { getRuntimeRecommendations, type RuntimeRecommendations } from '$lib/services/system-info';
  import { fetchLlamaReleaseAssets, toDownloadPayload, type ReleaseAsset, type ReleaseFetchResult } from '$lib/services/llama-releases';
  import { Badge, Button, Disclosure, Input } from '$lib/components/ui';
  import SettingsSection from './SettingsSection.svelte';

  type InstalledRuntime = { name: string; path: string; is_active?: boolean };
  type Supervisor = { state?: string; load_phase?: string; active_model?: string | null; build_info?: string; n_ctx?: number; total_slots?: number };

  let platformInfo = $state<RuntimeRecommendations>({ platform: 'linux', arch: 'x64', gpu_backend: 'cpu', has_gpu: false, recommended_variant: 'cpu' });

  const platformLabel = $derived.by(() => {
    const os = platformInfo.platform === 'macos' ? 'macOS' : platformInfo.platform === 'windows' ? 'Windows' : 'Linux';
    const gpu = platformInfo.has_gpu ? `${platformInfo.gpu_backend.toUpperCase()} GPU` : '';
    return [os, platformInfo.arch, gpu].filter(Boolean).join(' · ');
  });

  // ── Releases ─────────────────────────────────────────────────────────
  let releaseAssets = $state<ReleaseAsset[]>([]);
  let releaseExtras = $state<ReleaseAsset[]>([]);
  let loadingRelease = $state(false);
  let releaseNotice = $state<ReleaseFetchResult['notice']>('');
  let latestTag = $state('');
  let releaseTag = $state('');

  async function fetchLatestRelease() {
    loadingRelease = true;
    try {
      const result = await fetchLlamaReleaseAssets(platformInfo);
      releaseTag = result.tag;
      releaseAssets = result.assets;
      releaseExtras = result.extras;
      releaseNotice = result.notice;
      latestTag = result.latestTag ?? '';
    } finally {
      loadingRelease = false;
    }
  }

  // ── Installed builds and the running server ──────────────────────────
  let runtimes = $state<InstalledRuntime[]>([]);
  let supervisor = $state<Supervisor | null>(null);
  let telemetry = $state<RuntimeTelemetry | null>(null);

  const configuredPath = $derived(appStore.config?.llm?.local?.runtime_path || '');
  const isActive = (rt: InstalledRuntime) => rt.is_active ?? configuredPath === rt.path;
  const running = $derived(!!supervisor && !!supervisor.state && !['idle', 'unknown', 'Stopped', 'stopped'].includes(supervisor.state));

  async function refresh() {
    const out = await getInstalledRuntimes() as { runtimes?: InstalledRuntime[] };
    runtimes = Array.isArray(out?.runtimes) ? out.runtimes : [];
    supervisor = await getSupervisorStatus().catch(() => null) as Supervisor | null;
    telemetry = await getRuntimeTelemetry().catch(() => null);
  }

  async function removeRuntime(rt: InstalledRuntime) {
    const accepted = await confirmStore.ask({
      title: get(t)('runtime.deleteTitle', { values: { name: rt.name } }),
      message: get(t)('runtime.deleteMessage'),
      confirmLabel: get(t)('runtime.delete'),
      danger: true
    });
    if (!accepted) return;
    await deleteRuntimeBinary(rt.path);
    await refresh();
  }

  async function stopRuntime() {
    await stopLlama();
    await refresh();
    await modelsStore.refreshStatus();
  }

  // ── Installing ───────────────────────────────────────────────────────
  let downloading = $state<string | null>(null);
  let downloadProgress = $state(0);
  let downloadPhase = $state('');
  let downloadError = $state('');
  let customUrl = $state('');
  let customAsset = $state('');
  let customTag = $state('');

  async function install(payload: Parameters<typeof downloadRuntime>[0], name: string) {
    downloading = name;
    downloadProgress = 0;
    downloadPhase = 'downloading';
    downloadError = '';
    try {
      await downloadRuntime(payload);
      await refresh();
      // The first build someone installs is the one they mean to use.
      if (!configuredPath && runtimes.length === 1) appStore.setLocalRuntimePath(runtimes[0].path);
    } catch (e: unknown) {
      downloadError = String((e as Error)?.message || e || '');
    } finally {
      downloading = null;
    }
  }

  const installAsset = (asset: ReleaseAsset) => install(toDownloadPayload(asset), asset.name);
  const installCustom = () =>
    install({ download_url: customUrl.trim(), asset_name: customAsset.trim(), release_tag: customTag.trim() }, customAsset.trim());

  let unlisten: (() => void) | null = null;
  let telemetryTimer: ReturnType<typeof setInterval> | null = null;

  onMount(async () => {
    await refresh();
    await hardwareStore.refresh();
    try { platformInfo = await getRuntimeRecommendations(); } catch { /* use defaults */ }
    void fetchLatestRelease();
    unlisten = await listen('runtime-download-progress', (event: any) => {
      downloadProgress = Number(event?.progress ?? event?.payload?.progress ?? 0);
      downloadPhase = String(event?.phase ?? event?.payload?.phase ?? 'downloading');
    }) as (() => void);

    telemetryTimer = setInterval(() => {
      void getRuntimeTelemetry().then((next) => { telemetry = next; }).catch(() => { telemetry = null; });
    }, 2000);
  });

  onDestroy(() => {
    unlisten?.();
    if (telemetryTimer) clearInterval(telemetryTimer);
  });
</script>

{#snippet progress(name: string)}
  {#if downloading === name}
    <div class="mt-2 flex items-center gap-2">
      <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-active)]">
        <div class="h-full rounded-full bg-primary transition-[width]" style="width:{Math.max(4, downloadProgress)}%"></div>
      </div>
      <span class="w-24 text-right text-[11px] tabular-nums text-muted-foreground">
        {downloadPhase === 'extracting' ? $t('runtime.extracting') : `${downloadProgress.toFixed(0)}%`}
      </span>
    </div>
  {/if}
{/snippet}

<!-- Installed builds + the running server -->
<SettingsSection title={$t('runtime.installed')} description={$t('runtime.installedHint')}>
  {#snippet actions()}
    <Button variant="ghost" size="icon-sm" onclick={() => void refresh()} aria-label={$t('runtime.refresh')} title={$t('runtime.refresh')}><RefreshCw /></Button>
  {/snippet}

  {#if !runtimes.length}
    <div class="flex items-start gap-2.5 py-3 text-sm">
      <TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" />
      <div>
        <p class="font-medium text-foreground">{$t('runtime.noneInstalled')}</p>
        <p class="text-xs text-muted-foreground">{$t('runtime.noneInstalledHint')}</p>
      </div>
    </div>
  {:else}
    {#each runtimes as rt (rt.path)}
      {@const active = isActive(rt)}
      <div class="flex items-center gap-3 py-2.5">
        <span class="flex size-4 shrink-0 items-center justify-center rounded-full border {active ? 'border-primary bg-primary text-primary-fg' : 'border-border'}">
          {#if active}<Check class="size-2.5" />{/if}
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-medium text-foreground">{rt.name}</p>
          <p class="truncate text-[11px] text-muted-foreground" title={rt.path}>{rt.path}</p>
        </div>
        {#if active}
          <Badge tone="success">{$t('runtime.active')}</Badge>
        {:else}
          <Button variant="outline" size="sm" onclick={() => appStore.setLocalRuntimePath(rt.path)}>{$t('runtime.use')}</Button>
        {/if}
        <Button variant="ghost" size="icon-sm" class="text-muted-foreground hover:text-error" onclick={() => void removeRuntime(rt)} aria-label={$t('runtime.deleteTitle', { values: { name: rt.name } })}>
          <Trash2 />
        </Button>
      </div>
    {/each}
  {/if}

  {#if supervisor}
    <div class="py-3">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <p class="flex items-center gap-2 text-sm font-medium text-foreground">
            <span class="size-2 shrink-0 rounded-full {running ? 'bg-success' : 'bg-[var(--text-muted)] opacity-50'}"></span>
            {running ? $t('runtime.running') : $t('runtime.stopped')}
          </p>
          <p class="truncate text-xs text-muted-foreground">
            {#if running && supervisor.active_model}{[supervisor.active_model.split(/[\\/]/).pop(), supervisor.load_phase].filter(Boolean).join(' · ')}
            {:else}{$t('runtime.stoppedHint')}{/if}
          </p>
        </div>
        {#if running}
          <Button variant="outline" size="sm" onclick={() => void stopRuntime()}><Square /> {$t('runtime.stop')}</Button>
        {/if}
      </div>

      <!-- Measured from the server's own /props and /slots, not estimated. -->
      {#if running && (supervisor.n_ctx || telemetry)}
        <dl class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {#each [
            [$t('runtime.context'), (telemetry?.context_size ?? supervisor.n_ctx)?.toLocaleString() ?? '—'],
            [$t('runtime.peakContext'), telemetry?.context_percent != null ? `${telemetry.context_percent}%` : '—'],
            [$t('runtime.slots'), telemetry ? `${telemetry.slots_busy}/${telemetry.slots_total}` : String(supervisor.total_slots ?? '—')],
            [$t('runtime.speed'), telemetry?.tokens_per_second != null ? `${telemetry.tokens_per_second.toFixed(1)} tok/s` : '—']
          ] as [label, value] (label)}
            <div class="rounded-lg bg-[var(--muted)] px-3 py-2">
              <dt class="text-[10px] text-muted-foreground">{label}</dt>
              <dd class="mt-0.5 text-xs font-medium tabular-nums text-foreground">{value}</dd>
            </div>
          {/each}
        </dl>
      {/if}
      {#if supervisor.build_info}<p class="mt-2 text-[11px] text-muted-foreground">{supervisor.build_info}</p>{/if}
    </div>
  {/if}
</SettingsSection>

<!-- Install another build -->
<SettingsSection title={$t('runtime.install')} description={$t('runtime.installHint', { values: { platform: platformLabel } })}>
  {#snippet actions()}
    {#if releaseTag}<span class="text-xs tabular-nums text-muted-foreground">{releaseTag}</span>{/if}
    <Button variant="ghost" size="icon-sm" onclick={() => void fetchLatestRelease()} disabled={loadingRelease} aria-label={$t('runtime.checkReleases')} title={$t('runtime.checkReleases')}>
      <RefreshCw class={loadingRelease ? 'animate-spin' : ''} />
    </Button>
  {/snippet}

  {#if releaseNotice}
    <p class="py-2.5 text-xs text-muted-foreground">{$t(`runtime.notice.${releaseNotice}`, { values: { latest: latestTag, tag: releaseTag } })}</p>
  {/if}

  {#if loadingRelease && !releaseAssets.length}
    <p class="flex items-center gap-2 py-3 text-sm text-muted-foreground"><LoaderCircle class="size-4 animate-spin" /> {$t('runtime.checking')}</p>
  {:else if !releaseAssets.length}
    <p class="py-3 text-sm text-muted-foreground">{$t('runtime.noBuilds')}</p>
  {:else}
    {#each releaseAssets as asset (asset.name)}
      {@const recommended = asset.variant === 'recommended'}
      <div class="py-3">
        <div class="flex items-center gap-3">
          <div class="min-w-0 flex-1">
            <p class="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
              {asset.label}
              {#if recommended}<Badge tone="success" class="gap-1"><Zap class="size-2.5" />{$t('runtime.recommended')}</Badge>{/if}
            </p>
            <p class="text-xs text-muted-foreground">
              {[$t(`runtime.backend.${asset.backend}`), asset.companions.length ? $t('runtime.includesCuda') : ''].filter(Boolean).join(' · ')}
            </p>
          </div>
          <Button
            variant={recommended ? 'default' : 'outline'}
            size="sm"
            onclick={() => void installAsset(asset)}
            disabled={!!downloading}
            loading={downloading === asset.name}
          >
            <Download /> {$t('runtime.installAction')}
          </Button>
        </div>
        {@render progress(asset.name)}
      </div>
    {/each}
  {/if}

  {#if downloadError}
    <p class="py-2.5 text-xs text-error">{$t('runtime.installFailed', { values: { reason: downloadError } })}</p>
  {/if}

  <div class="py-3">
    <Disclosure title={$t('runtime.otherBuilds')} description={$t('runtime.otherBuildsHint')} class="border-0 bg-card">
      <div class="space-y-4">
        {#if releaseExtras.length}
          <div class="space-y-1">
            {#each releaseExtras as extra (extra.name)}
              <div class="flex items-center justify-between gap-3 py-1">
                <span class="min-w-0 truncate text-xs text-foreground">{extra.label}</span>
                <Button variant="ghost" size="xs" onclick={() => void installAsset(extra)} disabled={!!downloading}>{$t('runtime.installAction')}</Button>
              </div>
              {@render progress(extra.name)}
            {/each}
          </div>
        {/if}
        <div class="space-y-2">
          <p class="text-xs font-medium text-muted-foreground">{$t('runtime.fromUrl')}</p>
          <Input bind:value={customTag} placeholder={$t('runtime.tagPlaceholder')} />
          <Input bind:value={customAsset} placeholder={$t('runtime.assetPlaceholder')} />
          <Input bind:value={customUrl} placeholder={$t('runtime.urlPlaceholder')} spellcheck="false" />
          <div class="flex justify-end">
            <Button size="sm" onclick={() => void installCustom()} disabled={!!downloading || !customUrl.trim() || !customAsset.trim() || !customTag.trim()}>
              <Download /> {$t('runtime.installFromUrl')}
            </Button>
          </div>
          {@render progress(customAsset.trim())}
        </div>
      </div>
    </Disclosure>
  </div>
</SettingsSection>
