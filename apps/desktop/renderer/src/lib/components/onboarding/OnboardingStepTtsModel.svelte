<svelte:options runes={true} />

<!--
  Onboarding: pick a voice engine to read replies aloud (optional). The same
  picker as Settings → Voice: download an engine, choose a language and a voice.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Volume2, ArrowRight, ArrowLeft } from 'lucide-svelte';
  import SpeakVoicePicker from '$lib/components/settings/voice/SpeakVoicePicker.svelte';

  let { onNext, onBack } = $props<{
    onNext: () => void;
    onBack: () => void;
  }>();
</script>

<div class="flex flex-1 flex-col gap-4 px-6">
  <div class="flex items-center gap-2">
    <Volume2 class="size-4 text-muted-foreground" />
    <span class="text-sm font-medium text-foreground">{$t('onboarding.downloadTtsModel')}</span>
  </div>

  <p class="text-xs text-muted-foreground">{$t('onboarding.ttsModelDescription')}</p>

  <SpeakVoicePicker />

  <div class="mt-auto flex items-center justify-between pt-4">
    <button type="button" class="ui-btn ui-btn-ghost gap-1.5 px-4" onclick={onBack}>
      <ArrowLeft class="size-4" />
      {$t('onboarding.back')}
    </button>
    <button type="button" class="ui-btn ui-btn-primary gap-1.5 px-5" onclick={onNext}>
      {$t('onboarding.next')}
      <ArrowRight class="size-4" />
    </button>
  </div>
</div>
