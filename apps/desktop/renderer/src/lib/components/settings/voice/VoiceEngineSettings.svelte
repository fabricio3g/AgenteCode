<svelte:options runes={true} />

<!--
  The local voice engine: the bundled audio.cpp server. It starts on the first
  reply read aloud and keeps the chosen model warm; acceleration and threads
  restart it so a change applies at once rather than on some later reply.
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import { t } from 'svelte-i18n';
  import { RotateCcw, Volume2 } from 'lucide-svelte';
  import { Badge, Button, Select, Tooltip } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { speechEngine } from '$lib/stores/speech-engine.svelte';
  import { restartSpeechEngine } from '$lib/services/speech-engine';
  import SettingsRow from '../SettingsRow.svelte';

  const status = $derived(speechEngine.status);
  // What the engine actually runs with (the setting falls back to the bundled build).
  const backend = $derived(status?.backend ?? 'vulkan');
  /** 0 = automatic: up to 8 of this machine's cores. */
  const threads = $derived(Number(appStore.config.tts?.num_threads) || 0);
  const threadChoices = $derived.by(() => {
    const cores = status?.cores || 8;
    return [1, 2, 4, 6, 8, 12, 16].filter((n) => n <= cores);
  });
  let restarting = $state(false);

  async function restart() {
    restarting = true;
    try {
      await restartSpeechEngine();
      await speechEngine.refresh();
    } finally {
      restarting = false;
    }
  }
</script>

<SettingsRow
  label="audio.cpp"
  description={status?.backends.length
    ? [status.version, $t('voice.engine.runsHere')].filter(Boolean).join(' · ')
    : $t('computer.notBundled')}
  control="auto"
>
  {#snippet tile()}<Volume2 class="size-4" />{/snippet}
  {#if status?.backends.length}
    <div class="flex items-center gap-1.5">
      <Badge>{status.running ? $t('computer.running') : $t('voice.engine.idle')}</Badge>
      <Tooltip label={$t('voice.engine.restart')} position="bottom"><IconButton label={$t('voice.engine.restart')} variant="ghost" size="sm" onclick={() => void restart()} loading={restarting} >
        <RotateCcw />
      </IconButton></Tooltip>
    </div>
  {/if}
</SettingsRow>

{#if status?.backends.length}
  {#if status.backends.length > 1}
  <SettingsRow label={$t('voice.engine.acceleration')} description={$t('voice.engine.accelerationHint')}>
    <Select
      class="w-full"
      aria-label={$t('voice.engine.acceleration')}
      value={backend}
      options={[
        { value: 'cpu', label: $t('voice.engine.cpu') },
        { value: 'vulkan', label: $t('voice.engine.vulkan'), disabled: !status.backends.includes('vulkan') }
      ]}
      onchange={(value) => void speechEngine.configure({ local_backend: value as 'cpu' | 'vulkan' })}
    />
  </SettingsRow>
  {/if}

  <SettingsRow label={$t('voice.engine.threads')} description={$t('voice.engine.threadsHint')}>
    <Select
      class="w-full"
      aria-label={$t('voice.engine.threads')}
      value={String(threads)}
      options={[
        { value: '0', label: $t('voice.engine.threadsAuto', { values: { n: Math.min(8, status.cores || 8) } }) },
        ...threadChoices.map((n) => ({ value: String(n), label: String(n) }))
      ]}
      onchange={(value) => void speechEngine.configure({ num_threads: Number(value) })}
    />
  </SettingsRow>
{/if}
