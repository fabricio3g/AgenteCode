<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Volume2, ArrowRight, ArrowLeft, Download, LoaderCircle, CheckCircle2, AlertTriangle, Check, ChevronDown } from 'lucide-svelte';
  import { startDownloadHf, cancelDownloadJob } from '$lib/services/downloads';
  import { listen } from '$lib/services/tauri';
  import { KOKORO_LANGUAGES, getVoiceInfo } from '$lib/services/kokoro-tts';
  import { appStore } from '$lib/stores/app.svelte';
  import { loadAppConfig, saveAppConfig } from '$lib/utils/storage';

  let { onNext, onBack } = $props<{
    onNext: () => void;
    onBack: () => void;
  }>();

  type DownloadFile = {
    file: string;
    label: string;
    repoId: string;
    branch: string;
    dir: string;
    size_mb: number;
    required: boolean;
  };

  const TTS_FILES: DownloadFile[] = [
    { file: 'model.int8.onnx', label: 'Kokoro Model', repoId: 'csukuangfj/kokoro-int8-multi-lang-v1_1', branch: 'main', dir: 'kokoro-multi-lang-v1_1', size_mb: 170, required: true },
    { file: 'voices.bin', label: 'Voice Embeddings', repoId: 'csukuangfj/kokoro-int8-multi-lang-v1_1', branch: 'main', dir: 'kokoro-multi-lang-v1_1', size_mb: 1, required: true },
    { file: 'tokens.txt', label: 'Tokenizer', repoId: 'csukuangfj/kokoro-int8-multi-lang-v1_1', branch: 'main', dir: 'kokoro-multi-lang-v1_1', size_mb: 0.1, required: true },
    { file: 'lexicon-us-en.txt', label: 'US English Lexicon', repoId: 'csukuangfj/kokoro-int8-multi-lang-v1_1', branch: 'main', dir: 'kokoro-multi-lang-v1_1', size_mb: 0.5, required: true },
    { file: 'lexicon-gb-en.txt', label: 'GB English Lexicon', repoId: 'csukuangfj/kokoro-int8-multi-lang-v1_1', branch: 'main', dir: 'kokoro-multi-lang-v1_1', size_mb: 0.5, required: false },
  ];

  let fileStatuses = $state<Record<string, 'pending' | 'downloading' | 'done' | 'error'>>({});
  let fileProgress = $state<Record<string, number>>({});
  let fileErrors = $state<Record<string, string>>({});
  let currentJobId = $state<string | null>(null);

  // Voice selection state
  let selectedVoice = $state(appStore.config.tts?.voice || 'af_heart');
  let voiceOpen = $state(false);
  let langOpen = $state(false);

  let selectedLang = $derived.by(() => {
    const info = getVoiceInfo(selectedVoice);
    return info?.langCode ?? 'en-US';
  });
  let currentLangVoices = $derived(
    KOKORO_LANGUAGES.find(l => l.code === selectedLang)?.voices ?? []
  );
  let femaleVoices = $derived(currentLangVoices.filter(v => v.gender === 'female'));
  let maleVoices = $derived(currentLangVoices.filter(v => v.gender === 'male'));

  const totalSize = TTS_FILES.reduce((sum, f) => sum + f.size_mb, 0);
  const downloadedSize = $derived(
    TTS_FILES.reduce((sum, f) => sum + (fileStatuses[f.file] === 'done' ? f.size_mb : 0), 0)
  );
  const allRequiredDone = $derived(
    TTS_FILES.filter(f => f.required).every(f => fileStatuses[f.file] === 'done')
  );
  const anyDownloading = $derived(
    Object.values(fileStatuses).some(s => s === 'downloading')
  );
  const voiceCount = KOKORO_LANGUAGES.reduce((n, l) => n + l.voices.length, 0);

  onMount(() => {
    for (const f of TTS_FILES) {
      fileStatuses[f.file] = 'pending';
      fileProgress[f.file] = 0;
    }
  });

  async function selectVoice(voiceId: string) {
    selectedVoice = voiceId;
    voiceOpen = false;
    try {
      const current = await loadAppConfig();
      await saveAppConfig({ ...current, tts: { ...current.tts, voice: voiceId } });
    } catch { /* ignore — saved on finish */ }
  }

  async function selectLang(code: string) {
    const lang = KOKORO_LANGUAGES.find(l => l.code === code);
    if (!lang?.voices.length) return;
    const currentInLang = lang.voices.some(v => v.id === selectedVoice);
    if (!currentInLang) {
      await selectVoice(lang.voices[0].id);
    }
    langOpen = false;
  }

  async function downloadFile(df: DownloadFile) {
    if (fileStatuses[df.file] === 'done' || fileStatuses[df.file] === 'downloading') return;

    fileStatuses[df.file] = 'downloading';
    fileErrors[df.file] = '';

    try {
      const downloadDone = new Promise<{ status: string; error?: string }>((resolve, reject) => {
        const unlisten = listen<{ status: string; progress: number; error?: string; dest_path?: string; job_id?: string }>('download-progress', (evt) => {
          if (evt.job_id === currentJobId || evt.dest_path?.includes(df.file)) {
            fileProgress[df.file] = evt.progress ?? 0;
            if (evt.status === 'completed') {
              void unlisten.then((fn) => fn());
              resolve(evt);
            } else if (evt.status === 'error') {
              void unlisten.then((fn) => fn());
              resolve(evt);
            } else if (evt.status === 'cancelled') {
              void unlisten.then((fn) => fn());
              reject(new Error('Download cancelled'));
            }
          }
        });
      });

      const jobId = await startDownloadHf({
        repo_id: df.repoId,
        file: df.file,
        branch: df.branch,
        dest_rel: df.dir,
      });
      currentJobId = jobId;

      const result = await downloadDone;
      if (result.status === 'error') {
        throw new Error(result.error || 'Download failed');
      }
      fileStatuses[df.file] = 'done';
    } catch (err) {
      fileStatuses[df.file] = 'error';
      fileErrors[df.file] = String((err as Error)?.message || err || 'Download failed');
    } finally {
      currentJobId = null;
    }
  }

  async function downloadAll() {
    for (const df of TTS_FILES) {
      if (fileStatuses[df.file] !== 'done') {
        await downloadFile(df);
      }
    }
  }

  async function cancelCurrent() {
    if (currentJobId) {
      try {
        await cancelDownloadJob(currentJobId);
      } catch { /* ignore */ }
      currentJobId = null;
    }
    for (const f of TTS_FILES) {
      if (fileStatuses[f.file] === 'downloading') {
        fileStatuses[f.file] = 'pending';
      }
    }
  }

  function getVoiceLabel(voice: string): string {
    const info = getVoiceInfo(voice);
    return info?.name ?? voice;
  }
</script>

<div class="flex flex-1 flex-col gap-5 px-6">
  <div class="flex items-center gap-2">
    <Volume2 class="size-4 text-muted-foreground" />
    <span class="text-sm font-medium text-foreground">{$t('onboarding.downloadTtsModel')}</span>
  </div>

  <p class="text-xs text-muted-foreground">
    {$t('onboarding.ttsModelDescription')}
  </p>

  <div class="space-y-1">
    {#each TTS_FILES as df}
      {@const status = fileStatuses[df.file] ?? 'pending'}
      {@const progress = fileProgress[df.file] ?? 0}
      {@const error = fileErrors[df.file] ?? ''}
      <div
        class="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors
          {status === 'done' ? 'bg-muted/60' : 'hover:bg-muted/40'}"
      >
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="truncate text-sm font-medium text-foreground">{df.label}</span>
            {#if status === 'done'}
              <CheckCircle2 class="size-3.5 shrink-0 text-success" />
            {:else if status === 'downloading'}
              <LoaderCircle class="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            {:else if status === 'error'}
              <AlertTriangle class="size-3.5 shrink-0 text-error" />
            {/if}
          </div>
          <div class="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span>{df.size_mb} MB</span>
            {#if !df.required}
              <span class="rounded-md bg-muted px-1.5 py-0.5">{$t('onboarding.optional')}</span>
            {/if}
          </div>
          {#if status === 'downloading'}
            <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
              <div class="h-full bg-foreground transition-all" style="width: {progress}%"></div>
            </div>
          {/if}
          {#if error}
            <p class="mt-0.5 text-xs text-error">{error}</p>
          {/if}
        </div>
        {#if status === 'pending'}
          <button
            type="button"
            class="aui-icon-button size-8 shrink-0"
            onclick={() => downloadFile(df)}
            disabled={anyDownloading}
            aria-label="Download {df.label}"
            title="Download"
          >
            <Download class="size-3.5" />
          </button>
        {/if}
      </div>
    {/each}
  </div>

  {#if anyDownloading}
    <div class="space-y-1">
      <div class="h-1 overflow-hidden rounded-full bg-muted">
        <div class="h-full bg-foreground transition-all" style="width: {(downloadedSize / totalSize) * 100}%"></div>
      </div>
      <p class="text-xs text-muted-foreground">{Math.round((downloadedSize / totalSize) * 100)}% — {downloadedSize.toFixed(0)} / {totalSize.toFixed(0)} MB</p>
    </div>
  {/if}

  <!-- Voice selection -->
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <Volume2 class="size-3.5 text-muted-foreground" />
      <span class="text-xs font-medium text-foreground">Choose your voice</span>
      <span class="text-[10px] text-muted-foreground">{KOKORO_LANGUAGES.length} languages · {voiceCount} voices</span>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <!-- Language picker -->
      <div class="relative">
        <button
          type="button"
          class="aui-select-trigger h-8 gap-1.5 px-3 text-xs"
          onclick={() => { langOpen = !langOpen; voiceOpen = false; }}
          aria-haspopup="listbox"
          aria-expanded={langOpen}
        >
          <span>{KOKORO_LANGUAGES.find(l => l.code === selectedLang)?.label ?? 'Language'}</span>
          <ChevronDown class="size-3 text-muted-foreground" />
        </button>
        {#if langOpen}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="fixed inset-0 z-40" onclick={() => langOpen = false} onkeydown={() => {}}></div>
          <div class="aui-menu absolute left-0 top-full z-50 mt-1 min-w-[10rem] max-h-[240px] overflow-y-auto py-1" role="listbox">
            {#each KOKORO_LANGUAGES as lang}
              <button
                type="button"
                class="aui-menu-item text-xs {lang.code === selectedLang ? 'is-active' : ''}"
                onclick={() => selectLang(lang.code)}
                role="option"
                aria-selected={lang.code === selectedLang}
              >
                <span class="min-w-0 flex-1 truncate">{lang.label}</span>
                <span class="text-[10px] opacity-70">{lang.voices.length}</span>
                {#if lang.code === selectedLang}
                  <Check class="size-3 shrink-0" />
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Voice picker -->
      <div class="relative">
        <button
          type="button"
          class="aui-select-trigger h-8 gap-1.5 px-3 text-xs"
          onclick={() => { voiceOpen = !voiceOpen; langOpen = false; }}
          aria-haspopup="listbox"
          aria-expanded={voiceOpen}
        >
          <Volume2 class="size-3 text-muted-foreground" />
          <span>{getVoiceLabel(selectedVoice)}</span>
          <span class="text-[10px] text-muted-foreground">{selectedVoice.charAt(1) === 'f' ? 'F' : 'M'}</span>
          <ChevronDown class="size-3 text-muted-foreground" />
        </button>
        {#if voiceOpen}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="fixed inset-0 z-40" onclick={() => voiceOpen = false} onkeydown={() => {}}></div>
          <div class="aui-menu absolute left-0 top-full z-50 mt-1 min-w-[11rem] max-h-[300px] overflow-y-auto py-1" role="listbox">
            {#if femaleVoices.length > 0}
              <div class="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Female</div>
              {#each femaleVoices as voice (voice.id)}
                <button
                  type="button"
                  class="aui-menu-item text-xs {voice.id === selectedVoice ? 'is-active' : ''}"
                  onclick={() => selectVoice(voice.id)}
                  role="option"
                  aria-selected={voice.id === selectedVoice}
                >
                  <Volume2 class="size-3 shrink-0 opacity-70" />
                  <span class="min-w-0 flex-1 truncate">{voice.name}</span>
                  {#if voice.id === selectedVoice}
                    <Check class="size-3 shrink-0" />
                  {/if}
                </button>
              {/each}
            {/if}
            {#if maleVoices.length > 0}
              <div class="mt-1 px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Male</div>
              {#each maleVoices as voice (voice.id)}
                <button
                  type="button"
                  class="aui-menu-item text-xs {voice.id === selectedVoice ? 'is-active' : ''}"
                  onclick={() => selectVoice(voice.id)}
                  role="option"
                  aria-selected={voice.id === selectedVoice}
                >
                  <Volume2 class="size-3 shrink-0 opacity-70" />
                  <span class="min-w-0 flex-1 truncate">{voice.name}</span>
                  {#if voice.id === selectedVoice}
                    <Check class="size-3 shrink-0" />
                  {/if}
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>

  <div class="mt-auto flex items-center justify-between pt-4">
    <button type="button" class="aui-btn aui-btn-ghost gap-1.5 px-4" onclick={onBack}>
      <ArrowLeft class="size-4" />
      {$t('onboarding.back')}
    </button>

    <div class="flex items-center gap-2">
      {#if anyDownloading}
        <button type="button" class="aui-btn aui-btn-ghost gap-1.5 px-4" onclick={cancelCurrent}>
          {$t('onboarding.cancel')}
        </button>
      {:else if !allRequiredDone}
        <button type="button" class="aui-btn aui-btn-primary gap-1.5 px-5" onclick={downloadAll}>
          <Download class="size-4" />
          {$t('onboarding.downloadAll')}
        </button>
      {/if}

      <button
        type="button"
        class="aui-btn aui-btn-primary gap-1.5 px-5 disabled:opacity-50"
        onclick={onNext}
        disabled={anyDownloading}
      >
        {allRequiredDone ? $t('onboarding.next') : $t('onboarding.skip')}
        <ArrowRight class="size-4" />
      </button>
    </div>
  </div>
</div>
