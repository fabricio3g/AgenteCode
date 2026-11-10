<svelte:options runes={true} />

<!-- audio.cpp, the voice engine: get it, see how it runs, find its files. -->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Download, FolderOpen, RefreshCw } from 'lucide-svelte';
  import { invoke, listen } from '$lib/services/bridge';
  import { downloadSpeechEngine, restartSpeechEngine, speechEngineStatus, type SpeechEngineStatus } from '$lib/services/speech-engine';
  import { humanizeAgentError } from '$lib/utils/errors';
  import { Badge, Button, Progress } from '$lib/components/ui';
  import SettingsSection from './SettingsSection.svelte';

  let status = $state<SpeechEngineStatus | null>(null);
  let restarting = $state(false);
  /** The backend being downloaded, its progress (0-100) and the last failure. */
  let downloading = $state<string | null>(null);
  let progress = $state(0);
  let downloadError = $state('');

  async function load() {
    status = await speechEngineStatus();
  }

  async function restart() {
    restarting = true;
    try {
      await restartSpeechEngine();
      await load();
    } finally {
      restarting = false;
    }
  }

  async function download(backend: string) {
    downloading = backend;
    progress = 0;
    downloadError = '';
    try {
      await downloadSpeechEngine(backend);
    } catch (error) {
      downloadError = humanizeAgentError(error);
    } finally {
      downloading = null;
      await load();
    }
  }

  onMount(() => {
    void load();
    const stop = listen<{ progress?: number }>('audio-runtime-download-progress', (event) => (progress = Number(event?.progress ?? 0)));
    return () => void Promise.resolve(stop).then((off) => off?.());
  });

  const rows = $derived(status ? [
    { label: $t('audioEngine.version'), value: status.version ?? '—' },
    { label: $t('audioEngine.backends'), value: status.backends.join(', ') || '—' },
    { label: $t('audioEngine.inUse'), value: `${status.backend} · ${$t('audioEngine.threads', { values: { count: status.threads } })}` },
    { label: $t('audioEngine.models'), value: String(status.specs) }
  ] : []);
</script>

<SettingsSection title="audio.cpp">
  {#snippet actions()}
    <Button variant="outline" size="sm" onclick={() => void restart()} loading={restarting} disabled={!status?.backends.length}>
      <RefreshCw /> {$t('audioEngine.restart')}
    </Button>
  {/snippet}
  {#if status}
    {#each status.downloadable as backend (backend)}
      {@const installed = status.backends.includes(backend)}
      <div class="flex items-center gap-3 px-4 py-3">
        <div class="min-w-0 flex-1">
          <p class="text-[length:var(--text-sm)] font-medium text-foreground">{$t(`audioEngine.build.${backend}`)}</p>
          {#if downloading === backend}
            <Progress value={progress} label={$t('audioEngine.downloading')} class="mt-1.5" />
          {:else}
            <p class="text-xs text-muted-foreground">{installed ? $t('audioEngine.installed') : $t('audioEngine.notInstalled')}</p>
          {/if}
        </div>
        <Button variant="outline" size="sm" onclick={() => void download(backend)} loading={downloading === backend} disabled={!!downloading}>
          <Download /> {installed ? $t('audioEngine.reinstall') : $t('audioEngine.download')}
        </Button>
      </div>
    {/each}
    {#if downloadError}
      <p class="px-4 py-2.5 text-xs text-destructive" role="alert">{downloadError}</p>
    {/if}
    {#each rows as row (row.label)}
      <div class="flex items-center justify-between gap-3 px-4 py-3">
        <p class="text-[length:var(--text-sm)] font-medium text-foreground">{row.label}</p>
        <p class="text-xs text-muted-foreground">{row.value}</p>
      </div>
    {/each}
    <div class="flex items-center justify-between gap-3 px-4 py-3">
      <p class="text-[length:var(--text-sm)] font-medium text-foreground">{$t('audioEngine.status')}</p>
      <Badge tone={status.running ? 'success' : undefined}>
        {status.running ? $t('audioEngine.runningOn', { values: { port: status.port } }) : $t('audioEngine.stopped')}
      </Badge>
    </div>
    <div class="flex items-center justify-between gap-3 px-4 py-3">
      <div class="min-w-0">
        <p class="text-[length:var(--text-sm)] font-medium text-foreground">eSpeak-ng</p>
        <p class="text-xs text-muted-foreground">{$t('audioEngine.espeakHint')}</p>
      </div>
      <Badge tone={status.espeak ? 'success' : undefined}>{status.espeak ? $t('audioEngine.present') : $t('audioEngine.missing')}</Badge>
    </div>
    <div class="px-4 py-3">
      <p class="text-[length:var(--text-sm)] font-medium text-foreground">{$t('audioEngine.binary')}</p>
      <p class="truncate text-xs text-muted-foreground" title={status.binaryPath ?? ''}>{status.binaryPath ?? $t('computer.notBundled')}</p>
    </div>
    <div class="flex items-center justify-between gap-3 px-4 py-3">
      <div class="min-w-0">
        <p class="text-[length:var(--text-sm)] font-medium text-foreground">{$t('audioEngine.modelsFolder')}</p>
        <p class="truncate text-xs text-muted-foreground" title={status.modelsDir}>{status.modelsDir}</p>
      </div>
      <Button variant="outline" size="sm" onclick={() => void invoke('open_data_folder', { sub: 'models/voices' })}>
        <FolderOpen /> {$t('computer.openFolder')}
      </Button>
    </div>
  {/if}
</SettingsSection>
