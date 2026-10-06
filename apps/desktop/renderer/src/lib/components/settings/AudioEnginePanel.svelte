<svelte:options runes={true} />

<!-- audio.cpp, the bundled voice engine: what it is, how it runs, where its files are. -->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { FolderOpen, RefreshCw } from 'lucide-svelte';
  import { invoke } from '$lib/services/bridge';
  import { restartSpeechEngine, speechEngineStatus, type SpeechEngineStatus } from '$lib/services/speech-engine';
  import { Badge, Button } from '$lib/components/ui';
  import SettingsSection from './SettingsSection.svelte';

  let status = $state<SpeechEngineStatus | null>(null);
  let restarting = $state(false);

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

  onMount(() => void load());

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
