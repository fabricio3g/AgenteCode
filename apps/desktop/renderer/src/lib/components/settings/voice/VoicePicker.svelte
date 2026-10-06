<svelte:options runes={true} />

<!--
  Which voice reads replies: a language, then a voice from the model in use,
  each with a play button to hear it before choosing. Settings and the setup
  wizard share it.
-->

<script lang="ts">
  import { t, locale } from 'svelte-i18n';
  import { Check, LoaderCircle, Play, Square } from 'lucide-svelte';
  import { Select } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { speechEngine } from '$lib/stores/speech-engine.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';

  const tts = $derived(appStore.config.tts ?? {});
  const model = $derived(speechEngine.active);
  const language = $derived(model && model.languages.includes(tts.language ?? '') ? tts.language! : model?.languages[0] ?? 'en');
  const voices = $derived(model ? model.voices.filter((voice) => voice.language === '*' || voice.language === language) : []);
  const chosen = $derived(voices.some((voice) => voice.id === tts.voice) ? tts.voice : voices[0]?.id);
  const needsEspeak = $derived(!!model && model.espeakLanguages.includes(language) && speechEngine.status?.espeak === false);
  const clones = $derived(model?.canClone ? tts.cloned_voices ?? [] : []);
  const chosenClone = $derived(clones.find((voice) => voice.id === tts.cloned_voice)?.id);
  let previewing = $state<string | null>(null);

  function languageName(code: string): string {
    try {
      return new Intl.DisplayNames([$locale || 'en'], { type: 'language' }).of(code) ?? code;
    } catch {
      return code;
    }
  }

  function setLanguage(code: string) {
    const voice = model?.voices.find((option) => option.language === '*' || option.language === code)?.id;
    void appStore.updateTtsSettings({ language: code, voice });
  }

  async function preview(voiceId: string, cloneId = '') {
    const same = previewing === voiceId;
    if (previewing) {
      ttsStore.stop();
      previewing = null;
      if (same) return;
    }
    if (!model) return;
    previewing = voiceId;
    try {
      const config = { ...appStore.config, tts: { ...tts, backend_mode: 'local' as const, voice_model: model.id, language, voice: voiceId, cloned_voice: cloneId } };
      await ttsStore.speak(`voice-preview-${Date.now()}`, $t('voice.previewText'), config);
    } catch (error) {
      toastStore.error((error as Error)?.message || String(error));
    } finally {
      if (previewing === voiceId) previewing = null;
    }
  }
</script>

{#if model}
  <div class="voice-picker">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="min-w-0">
        <p class="text-[length:var(--text-sm)] font-medium text-foreground">{$t('voice.language')}</p>
        <p class="text-xs text-muted-foreground">{$t('voice.engine.languageHint')}</p>
      </div>
      <Select
        class="w-56"
        aria-label={$t('voice.language')}
        value={language}
        onchange={setLanguage}
        options={model.languages.map((code) => ({ value: code, label: languageName(code) })).sort((a, b) => a.label.localeCompare(b.label))}
      />
    </div>

    {#if needsEspeak}
      <p class="note">{$t('voice.engine.needsEspeak')}</p>
    {/if}

    <div class="voices" role="radiogroup" aria-label={$t('voice.voice')}>
      {#each voices as voice (voice.id)}
        {@const selected = !chosenClone && chosen === voice.id}
        <div class="voice" class:is-selected={selected}>
          <button
            type="button"
            class="voice-pick"
            role="radio"
            aria-checked={selected}
            onclick={() => void appStore.updateTtsSettings({ voice: voice.id, voice_model: model.id, language, cloned_voice: '' })}
          >
            <span class="voice-mark">{#if selected}<Check class="size-3" />{/if}</span>
            <span class="min-w-0">
              <span class="block truncate text-[length:var(--text-sm)] text-foreground">{voice.label}</span>
              {#if voice.gender}<span class="block text-xs text-muted-foreground">{$t(`voice.engine.${voice.gender}`)}</span>{/if}
            </span>
          </button>
          <button type="button" class="voice-play" onclick={() => void preview(voice.id)} aria-label={$t('voice.preview')} title={$t('voice.preview')}>
            {#if previewing === voice.id}
              {#if ttsStore.audioStarted}<Square class="size-3" />{:else}<LoaderCircle class="size-3.5 animate-spin" />{/if}
            {:else}<Play class="size-3.5" />{/if}
          </button>
        </div>
      {/each}
    </div>

    {#if clones.length}
      <p class="text-xs text-muted-foreground">{$t('voice.clone.group')}</p>
      <div class="voices" role="radiogroup" aria-label={$t('voice.clone.group')}>
        {#each clones as clone (clone.id)}
          {@const selected = chosenClone === clone.id}
          <div class="voice" class:is-selected={selected}>
            <button type="button" class="voice-pick" role="radio" aria-checked={selected}
              onclick={() => void appStore.updateTtsSettings({ cloned_voice: clone.id, voice_model: model.id, language })}>
              <span class="voice-mark">{#if selected}<Check class="size-3" />{/if}</span>
              <span class="block min-w-0 truncate text-[length:var(--text-sm)] text-foreground">{clone.name}</span>
            </button>
            <button type="button" class="voice-play" onclick={() => void preview(`clone:${clone.id}`, clone.id)} aria-label={$t('voice.preview')} title={$t('voice.preview')}>
              {#if previewing === `clone:${clone.id}`}
                {#if ttsStore.audioStarted}<Square class="size-3" />{:else}<LoaderCircle class="size-3.5 animate-spin" />{/if}
              {:else}<Play class="size-3.5" />{/if}
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{:else}
  <p class="px-4 py-3 text-xs text-muted-foreground">{$t('voice.engine.none')}</p>
{/if}

<style>
  .voice-picker {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    padding: 0.875rem 1rem;
  }

  .note {
    border: 1px solid var(--border-subtle);
    border-radius: var(--float-row-radius);
    padding: 0.5rem 0.75rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }

  .voices {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr));
    gap: 0.375rem;
  }

  .voice {
    display: flex;
    align-items: center;
    border: 1px solid var(--border-subtle);
    border-radius: var(--float-row-radius);
    transition: border-color var(--motion-fast) var(--motion-ease), background-color var(--motion-fast) var(--motion-ease);
  }

  .voice:hover { background: var(--float-row-hover); }

  .voice.is-selected {
    border-color: var(--float-border);
    background: var(--nav-current-bg);
    box-shadow: var(--nav-current-ring);
  }

  .voice-pick {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4375rem 0.5rem;
    text-align: left;
  }

  .voice-mark {
    display: flex;
    width: 0.875rem;
    flex-shrink: 0;
    justify-content: center;
    color: var(--foreground);
  }

  .voice-play {
    display: inline-flex;
    width: 1.75rem;
    height: 1.75rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    margin-right: 0.25rem;
    border-radius: var(--float-row-radius);
    color: var(--muted-foreground);
  }

  .voice-play:hover { background: var(--float-row-hover); color: var(--foreground); }

  .voice-pick:focus-visible,
  .voice-play:focus-visible {
    outline: 2px solid var(--brand-accent);
    outline-offset: -2px;
    border-radius: var(--float-row-radius);
  }
</style>
