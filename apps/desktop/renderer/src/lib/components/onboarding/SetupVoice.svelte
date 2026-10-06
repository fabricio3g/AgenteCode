<svelte:options runes={true} />

<!--
  Voice, both directions and both optional: a model to read replies aloud
  (the same catalog and voice picker as Settings → Voice, on the bundled
  audio.cpp) and dictation (whisper.cpp with its balanced model).
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Check, Download, LoaderCircle } from 'lucide-svelte';
  import { Badge, Button } from '$lib/components/ui';
  import { listen } from '$lib/services/bridge';
  import { speechEngine } from '$lib/stores/speech-engine.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { listSpeechModels, setupSpeech, type SpeechModel } from '$lib/features/chat/composer/speech-models';
  import VoiceModelList from '$lib/components/settings/voice/VoiceModelList.svelte';
  import VoicePicker from '$lib/components/settings/voice/VoicePicker.svelte';
  import SetupFooter from './SetupFooter.svelte';

  let { onback, onnext }: { onback: () => void; onnext: () => void } = $props();

  let speech = $state<SpeechModel[]>([]);
  let dictationBusy = $state(false);
  let dictationProgress = $state(0);
  const dictation = $derived(speech.find((model) => model.inUse) ?? speech.find((model) => model.installed) ?? null);
  const recommended = $derived(speech.find((model) => model.recommended) ?? speech[0] ?? null);

  async function setUpDictation() {
    if (!recommended) return;
    dictationBusy = true;
    dictationProgress = 0;
    const off = await listen<{ phase: string; progress: number }>('voice-setup-progress', (event) => {
      dictationProgress = event.phase === 'model' ? event.progress : event.phase === 'done' ? 100 : 0;
    });
    try {
      await setupSpeech(recommended.quality);
      speech = await listSpeechModels().catch(() => speech);
    } catch (error) {
      toastStore.error((error as Error)?.message || String(error));
    } finally {
      off();
      dictationBusy = false;
    }
  }

  onMount(() => {
    void speechEngine.refresh();
    void listSpeechModels().then((list) => (speech = list)).catch(() => {});
  });
</script>

<div class="setup-step">
  <div>
    <h3 class="setup-title">{$t('onboarding.voice.title')}</h3>
    <p class="setup-lead">{$t('onboarding.voice.lead')}</p>
  </div>

  <div>
    <p class="setup-label">{$t('onboarding.voice.readAloud')}</p>
    <div class="setup-card">
      <VoiceModelList limit={3} searchable={false} />
    </div>
  </div>

  {#if speechEngine.active}
    <div class="setup-card">
      <VoicePicker />
    </div>
  {/if}

  <div>
    <p class="setup-label">{$t('onboarding.voice.dictation')}</p>
    <div class="setup-card">
      <div class="setup-row">
        <div class="min-w-0 flex-1">
          <p class="text-[length:var(--text-sm)] font-medium text-foreground">whisper.cpp</p>
          <p class="text-xs text-muted-foreground">{dictation ? $t('onboarding.voice.dictationReady') : $t('onboarding.voice.dictationHint')}</p>
        </div>
        {#if dictation}
          <Badge tone="success"><Check class="size-2.5" />{$t('onboarding.installed')}</Badge>
        {:else if dictationBusy}
          <span class="text-xs tabular-nums text-muted-foreground"><LoaderCircle class="mr-1 inline size-3.5 animate-spin" />{Math.round(dictationProgress)}%</span>
        {:else}
          <Button variant="outline" size="sm" disabled={!recommended} onclick={() => void setUpDictation()}>
            <Download /> {recommended ? $t('onboarding.voice.dictationDownload', { values: { size: Math.round(recommended.bytes / 1e6) } }) : $t('onboarding.download')}
          </Button>
        {/if}
      </div>
    </div>
  </div>
</div>

<SetupFooter {onback} skipLabel={$t('onboarding.later')} onskip={onnext} primaryLabel={$t('onboarding.continue')} onprimary={onnext} />
