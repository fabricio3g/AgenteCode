<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Volume2, ArrowRight, ArrowLeft, Download, LoaderCircle, CheckCircle2, AlertTriangle, Check, ChevronDown } from 'lucide-svelte';
  import { startDownloadHf, getDownloadJobs, cancelDownloadJob } from '$lib/services/downloads';
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
  let overallProgress = $state(0);

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
    <Volume2 class="h-4 w-4 text-[var(--text-secondary)]" />
    <span class="text-sm font-medium text-[var(--text)]">{$t('onboarding.downloadTtsModel')}</span>
  </div>

  <p class="text-xs text-[var(--text-muted)]">
    {$t('onboarding.ttsModelDescription')}
  </p>

  <div class="space-y-1.5">
    {#each TTS_FILES as df}
      {@const status = fileStatuses[df.file] ?? 'pending'}
      {@const progress = fileProgress[df.file] ?? 0}
      {@const error = fileErrors[df.file] ?? ''}
      <div
        class="flex w-full items-center gap-3 rounded-lg border px-4 py-2.5 text-left transition
          {status === 'done' ? 'border-[var(--success)] bg-[var(--surface)]' : 'border-[var(--border)] bg-[var(--surface)]'}"
      >
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-[var(--text)] truncate">{df.label}</span>
            {#if status === 'done'}
              <CheckCircle2 class="h-3.5 w-3.5 shrink-0 text-[var(--success)]" />
            {:else if status === 'downloading'}
              <LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin" />
            {:else if status === 'error'}
              <AlertTriangle class="h-3.5 w-3.5 shrink-0 text-[var(--error)]" />
            {/if}
          </div>
          <div class="mt-0.5 flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <span>{df.size_mb} MB</span>
            {#if !df.required}
              <span class="rounded bg-[var(--surface-hover)] px-1.5 py-0.5">{$t('onboarding.optional')}</span>
            {/if}
          </div>
          {#if status === 'downloading'}
            <div class="mt-1 h-1 overflow-hidden rounded-full bg-[var(--surface-hover)]">
              <div class="h-full bg-[var(--text)] transition-all" style="width: {progress}%"></div>
            </div>
          {/if}
          {#if error}
            <p class="mt-0.5 text-xs text-[var(--error)]">{error}</p>
          {/if}
        </div>
        {#if status === 'pending'}
          <button
            class="rounded-full border border-[var(--border)] p-1.5 text-[var(--text-muted)] transition hover:border-[var(--text)] hover:text-[var(--text)]"
            onclick={() => downloadFile(df)}
            disabled={anyDownloading}
          >
            <Download class="h-3.5 w-3.5" />
          </button>
        {/if}
      </div>
    {/each}
  </div>

  {#if anyDownloading}
    <div class="space-y-1">
      <div class="h-1 overflow-hidden rounded-full bg-[var(--surface-hover)]">
        <div class="h-full bg-[var(--text)] transition-all" style="width: {(downloadedSize / totalSize) * 100}%"></div>
      </div>
      <p class="text-xs text-[var(--text-muted)]">{Math.round((downloadedSize / totalSize) * 100)}% — {downloadedSize.toFixed(0)} / {totalSize.toFixed(0)} MB</p>
    </div>
  {/if}

  <!-- Voice selection -->
  <div class="space-y-2">
    <div class="flex items-center gap-2">
      <Volume2 class="h-3.5 w-3.5 text-[var(--text-secondary)]" />
      <span class="text-xs font-medium text-[var(--text)]">Choose your voice</span>
      <span class="text-[10px] text-[var(--text-muted)]">{KOKORO_LANGUAGES.length} languages · {KOKORO_LANGUAGES.reduce((n, l) => n + l.voices.length, 0)} voices</span>
    </div>

    <div class="flex items-center gap-2">
      <!-- Language picker -->
      <div class="relative">
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--text)] hover:border-[var(--border-hover)] transition"
          onclick={() => { langOpen = !langOpen; voiceOpen = false; }}
        >
          <span>{KOKORO_LANGUAGES.find(l => l.code === selectedLang)?.label ?? 'Language'}</span>
          <ChevronDown class="h-3 w-3 text-[var(--text-muted)]" />
        </button>
        {#if langOpen}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="fixed inset-0 z-40" onclick={() => langOpen = false} onkeydown={() => {}}></div>
          <div class="absolute left-0 top-full z-50 mt-1 min-w-[160px] max-h-[240px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg py-1">
            {#each KOKORO_LANGUAGES as lang}
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--text)] hover:bg-[var(--surface-hover)] transition"
                onclick={() => selectLang(lang.code)}
              >
                <span>{lang.label}</span>
                <span class="ml-auto text-[10px] text-[var(--text-muted)]">{lang.voices.length}</span>
                {#if lang.code === selectedLang}
                  <Check class="h-3 w-3 text-[var(--primary)]" />
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
          class="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--text)] hover:border-[var(--border-hover)] transition"
          onclick={() => { voiceOpen = !voiceOpen; langOpen = false; }}
        >
          <Volume2 class="h-3 w-3 text-[var(--text-muted)]" />
          <span>{getVoiceLabel(selectedVoice)}</span>
          <span class="text-[10px] text-[var(--text-muted)]">{selectedVoice.charAt(1) === 'f' ? 'F' : 'M'}</span>
          <ChevronDown class="h-3 w-3 text-[var(--text-muted)]" />
        </button>
        {#if voiceOpen}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="fixed inset-0 z-40" onclick={() => voiceOpen = false} onkeydown={() => {}}></div>
          <div class="absolute left-0 top-full z-50 mt-1 min-w-[180px] max-h-[300px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg py-1">
            {#if femaleVoices.length > 0}
              <div class="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Female</div>
              {#each femaleVoices as voice (voice.id)}
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--surface-hover)] transition {voice.id === selectedVoice ? 'text-[var(--primary)] bg-[var(--primary)]/5' : 'text-[var(--text)]'}"
                  onclick={() => selectVoice(voice.id)}
                >
                  <Volume2 class="h-3 w-3 shrink-0 {voice.id === selectedVoice ? 'text-[var(--primary)]' : 'text-[var(--text-muted)]'}" />
                  <span class="truncate">{voice.name}</span>
                  {#if voice.id === selectedVoice}
                    <Check class="ml-auto h-3 w-3 shrink-0" />
                  {/if}
                </button>
              {/each}
            {/if}
            {#if maleVoices.length > 0}
              <div class="px-3 py-1 mt-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Male</div>
              {#each maleVoices as voice (voice.id)}
                <button
                  type="button"
                  class="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--surface-hover)] transition {voice.id === selectedVoice ? 'text-[var(--primary)] bg-[var(--primary)]/5' : 'text-[var(--text)]'}"
                  onclick={() => selectVoice(voice.id)}
                >
                  <Volume2 class="h-3 w-3 shrink-0 {voice.id === selectedVoice ? 'text-[var(--primary)]' : 'text-[var(--text-muted)]'}" />
                  <span class="truncate">{voice.name}</span>
                  {#if voice.id === selectedVoice}
                    <Check class="ml-auto h-3 w-3 shrink-0" />
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
    <button
      class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-4 py-2 text-sm font-medium transition hover:bg-[var(--surface-hover)]"
      onclick={onBack}
    >
      <ArrowLeft class="h-4 w-4" />
      {$t('onboarding.back')}
    </button>

    <div class="flex items-center gap-2">
      {#if anyDownloading}
        <button
          class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-4 py-2 text-sm font-medium transition hover:bg-[var(--surface-hover)]"
          onclick={cancelCurrent}
        >
          {$t('onboarding.cancel')}
        </button>
      {:else if !allRequiredDone}
        <button
          class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-hover)] bg-[var(--primary)] px-5 py-2 text-sm font-medium text-[var(--primary-fg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition hover:opacity-90"
          onclick={downloadAll}
        >
          <Download class="h-4 w-4" />
          {$t('onboarding.downloadAll')}
        </button>
      {/if}

      <button
        class="inline-flex items-center gap-1.5 rounded-full border border-[var(--border-hover)] bg-[var(--primary)] px-5 py-2 text-sm font-medium text-[var(--primary-fg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_1px_2px_rgba(0,0,0,0.04)] transition hover:opacity-90 disabled:opacity-50"
        onclick={onNext}
        disabled={anyDownloading}
      >
        {allRequiredDone ? $t('onboarding.next') : $t('onboarding.skip')}
        <ArrowRight class="h-4 w-4" />
      </button>
    </div>
  </div>
</div>
