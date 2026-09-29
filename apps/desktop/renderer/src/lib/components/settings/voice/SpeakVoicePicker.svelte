<svelte:options runes={true} />

<!--
  Read aloud: choose a voice engine (download it once, right here), then a
  language and a voice, each with a play button to hear it first. Engines run
  on this computer through the bundled audio.cpp server.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t, locale } from 'svelte-i18n';
  import { Check, Download, LoaderCircle, Play, Square, Trash2 } from 'lucide-svelte';
  import { Button, Select } from '$lib/components/ui';
  import { appStore } from '$lib/stores/app.svelte';
  import { downloadsStore } from '$lib/stores/downloads.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { invoke } from '$lib/services/bridge';
  import { VOICE_MODELS, voiceModel, type VoiceModel } from '$shared/voice-models';

  let installed = $state<string[]>([]);
  let espeak = $state(true);
  let previewing = $state<string | null>(null);

  const tts = $derived(appStore.config.tts ?? {});
  const active = $derived(voiceModel(tts.voice_model) && installed.includes(tts.voice_model ?? '') ? voiceModel(tts.voice_model)! : VOICE_MODELS.find((model) => installed.includes(model.id)) ?? null);
  const language = $derived(active && active.languages.includes(tts.language ?? '') ? tts.language! : active?.languages[0] ?? 'en');
  const voices = $derived(active ? active.voices.filter((voice) => voice.language === '*' || voice.language === language) : []);

  async function refresh() {
    const status = await invoke<{ installed: string[]; espeak: boolean }>('voice_models_status').catch(() => ({ installed: [], espeak: true }));
    installed = status.installed;
    espeak = status.espeak;
  }

  onMount(() => {
    void refresh();
  });

  function jobFor(model: VoiceModel) {
    return downloadsStore.jobFor(model.repo, model.file);
  }

  // A finished download shows up as installed.
  $effect(() => {
    for (const model of VOICE_MODELS) {
      if (jobFor(model)?.status === 'completed' && !installed.includes(model.id)) void refresh();
    }
  });

  function languageName(code: string): string {
    try {
      return new Intl.DisplayNames([$locale || 'en'], { type: 'language' }).of(code) ?? code;
    } catch {
      return code;
    }
  }

  async function download(model: VoiceModel) {
    try {
      await invoke('voice_model_download', { id: model.id });
      void downloadsStore.refresh();
    } catch (err) {
      toastStore.error((err as Error)?.message || String(err));
    }
  }

  function use(model: VoiceModel) {
    const keep = model.languages.includes(tts.language ?? '') ? tts.language : model.languages[0];
    void appStore.updateTtsSettings({ voice_model: model.id, language: keep, voice: model.voices.find((voice) => voice.language === '*' || voice.language === keep)?.id });
  }

  function remove(model: VoiceModel) {
    confirmStore.show({
      title: $t('voice.engine.deleteTitle', { values: { name: model.title } }),
      message: $t('voice.engine.deleteMessage', { values: { size: model.sizeMb } }),
      confirmLabel: $t('voice.engine.delete'),
      danger: true,
      onConfirm: async () => {
        await invoke('voice_model_delete', { id: model.id });
        await refresh();
      }
    });
  }

  function setLanguage(code: string) {
    const voice = active?.voices.find((option) => option.language === '*' || option.language === code)?.id;
    void appStore.updateTtsSettings({ language: code, voice });
  }

  async function preview(voiceId: string) {
    if (previewing) {
      ttsStore.stop();
      const same = previewing === voiceId;
      previewing = null;
      if (same) return;
    }
    if (!active) return;
    previewing = voiceId;
    try {
      const config = { ...appStore.config, tts: { ...tts, voice_model: active.id, language, voice: voiceId } };
      await ttsStore.speak(`voice-preview-${Date.now()}`, $t('voice.previewText'), config);
    } catch (err) {
      toastStore.error((err as Error)?.message || String(err));
    } finally {
      previewing = null;
    }
  }
</script>

<div class="space-y-3 py-3.5">
  <div>
    <p class="text-sm font-medium text-foreground">{$t('voice.engine.title')}</p>
    <p class="text-xs text-muted-foreground">{$t('voice.engine.hint')}</p>
  </div>

  <div class="grid gap-2 sm:grid-cols-2">
    {#each VOICE_MODELS as model (model.id)}
      {@const job = jobFor(model)}
      {@const downloading = job && ['queued', 'running'].includes(job.status)}
      {@const isInstalled = installed.includes(model.id)}
      {@const isActive = active?.id === model.id}
      <div class="engine" class:active={isActive}>
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="text-[13px] font-medium text-foreground">{model.title}</p>
            <p class="text-[11.5px] text-muted-foreground">{$t(`voice.engine.${model.id}`)}</p>
          </div>
          {#if isActive}<span class="in-use"><Check class="size-3" /> {$t('voice.inUse')}</span>{/if}
        </div>
        <p class="meta">
          {$t('voice.engine.languages', { values: { n: model.languages.length } })} · {model.voices.length} {$t('voice.engine.voices')} · {model.sizeMb} MB · {model.license}
        </p>
        {#if downloading}
          <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(job.progress ?? 0)}>
            <span style:width={`${Math.max(2, job.progress ?? 0)}%`}></span>
          </div>
          <p class="meta">{$t('voice.engine.downloading', { values: { n: Math.round(job.progress ?? 0) } })}</p>
        {:else if isInstalled}
          <div class="flex items-center gap-1.5">
            {#if !isActive}<Button size="sm" onclick={() => use(model)}>{$t('voice.engine.use')}</Button>{/if}
            <Button variant="ghost" size="sm" onclick={() => remove(model)} aria-label={$t('voice.engine.delete')}><Trash2 /></Button>
          </div>
        {:else}
          <Button variant="outline" size="sm" onclick={() => void download(model)}><Download /> {$t('voice.engine.download', { values: { size: model.sizeMb } })}</Button>
        {/if}
      </div>
    {/each}
  </div>

  {#if active}
    {#if active.espeakLanguages.includes(language) && !espeak}
      <p class="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-xs text-muted-foreground">{$t('voice.engine.needsEspeak')}</p>
    {/if}

    <div class="flex items-center justify-between gap-3 pt-2">
      <div>
        <p class="text-sm font-medium text-foreground">{$t('voice.language')}</p>
        <p class="text-xs text-muted-foreground">{$t('voice.engine.languageHint')}</p>
      </div>
      <Select
        class="w-56"
        aria-label={$t('voice.language')}
        value={language}
        onchange={setLanguage}
        options={active.languages.map((code) => ({ value: code, label: languageName(code) })).sort((a, b) => a.label.localeCompare(b.label))}
      />
    </div>

    <div>
      <p class="pb-2 text-sm font-medium text-foreground">{$t('voice.voice')}</p>
      <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {#each voices as voice (voice.id)}
          {@const selected = tts.voice === voice.id}
          <div class="voice" class:selected>
            <button type="button" class="pick" onclick={() => void appStore.updateTtsSettings({ voice: voice.id, voice_model: active.id, language })} aria-pressed={selected}>
              <span class="truncate text-[13px] text-foreground">{voice.label}</span>
              <span class="text-[11px] text-muted-foreground">{$t(`voice.engine.${voice.gender}`)}</span>
            </button>
            <button type="button" class="play" onclick={() => void preview(voice.id)} aria-label={$t('voice.preview')} title={$t('voice.preview')}>
              {#if previewing === voice.id}<LoaderCircle class="size-3.5 animate-spin" />{:else}<Play class="size-3.5" />{/if}
            </button>
          </div>
        {/each}
      </div>
      {#if previewing}
        <button type="button" class="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground" onclick={() => { ttsStore.stop(); previewing = null; }}>
          <Square class="size-3" /> {$t('voice.stopPreview')}
        </button>
      {/if}
    </div>
  {:else}
    <p class="text-xs text-muted-foreground">{$t('voice.engine.none')}</p>
  {/if}
</div>

<style>
  .engine {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    border-radius: 0.8rem;
    border: 1px solid var(--border-subtle);
    padding: 0.8rem;
  }
  .engine.active { border-color: var(--border); background: var(--surface-hover); }
  .in-use {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    flex-shrink: 0;
    font-size: 11px;
    color: var(--muted-foreground);
  }
  .meta { font-size: 11px; color: var(--muted-foreground); }
  .progress { height: 4px; overflow: hidden; border-radius: 9999px; background: var(--surface-active); }
  .progress span { display: block; height: 100%; background: var(--foreground); transition: width 0.3s; }
  .voice {
    display: flex;
    align-items: center;
    border-radius: 0.6rem;
    border: 1px solid var(--border-subtle);
  }
  .voice.selected { border-color: var(--foreground); }
  .pick {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    align-items: flex-start;
    padding: 0.4rem 0.6rem;
    text-align: left;
  }
  .play {
    display: inline-flex;
    height: 1.9rem;
    width: 1.9rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    margin-right: 0.2rem;
    border-radius: 9999px;
    color: var(--muted-foreground);
  }
  .play:hover { background: var(--surface-hover); color: var(--foreground); }
</style>
