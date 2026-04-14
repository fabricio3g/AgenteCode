<svelte:options runes={true} />

<script lang="ts">
  import { Paperclip, Search, Square, ArrowUp, X, Globe, Database, Mic, AudioLines, LoaderCircle, ArrowRight } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { isTauri } from '$lib/services/tauri';
  import { sttTranscribe } from '$lib/services/stt';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import ComposerModes from './composer/ComposerModes.svelte';
  import ModeSelector from './composer/ModeSelector.svelte';
  import SearchModeSelector from './composer/SearchModeSelector.svelte';
  import VoiceModeOverlay from './composer/VoiceModeOverlay.svelte';
  import AttachmentCards from './composer/AttachmentCards.svelte';

  interface Props {
    onHeightChange?: (height: number) => void;
    centered?: boolean;
  }

  let { onHeightChange, centered = false }: Props = $props();

  type RecognitionCtor = new () => {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string; isFinal: boolean }>> }) => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: (() => void) | null;
    start: () => void;
    stop: () => void;
  };

  let textarea: HTMLTextAreaElement | undefined;
  let fileInput: HTMLInputElement | undefined;
  let isListening = $state(false);
  let recognition: InstanceType<RecognitionCtor> | null = null;
  let dragOver = $state(false);
  let windowDragActive = $state(false);
  let interimTranscript = $state('');
  let voicePulse = $state(0);
  let pulseInterval: ReturnType<typeof setInterval> | null = null;
  let composerWidth = $state(0);
  let composerHeight = $state(0);

  // Whisper API recording state (fallback when Web Speech API unavailable)
  let whisperRecorder: MediaRecorder | null = null;
  let whisperChunks: BlobPart[] = [];
  let isWhisperListening = $state(false);

  // ── Audio analyser for voice waveform (drives VoiceModeOverlay dots) ──
  const VOICE_WAVE_HEIGHTS = [28, 36, 46, 34, 26, 38, 52, 58, 44, 32, 26, 37, 49, 35, 28];
  const VOICE_BAR_WEIGHTS = VOICE_WAVE_HEIGHTS.map(h => h / 58);
  let audioLevels = $state<number[]>(Array(15).fill(0));
  let _audioLevel = 0; // raw RMS
  let _analyserNode: AnalyserNode | null = null;
  let _analyserRaf: number | null = null;
  let _micStream: MediaStream | null = null;
  let _audioCtx: AudioContext | null = null;

  function _startAnalyser(stream: MediaStream) {
    try {
      _audioCtx = new AudioContext();
      const source = _audioCtx.createMediaStreamSource(stream);
      _analyserNode = _audioCtx.createAnalyser();
      _analyserNode.fftSize = 256;
      _analyserNode.smoothingTimeConstant = 0.6;
      source.connect(_analyserNode);
      const buf = new Uint8Array(_analyserNode.frequencyBinCount);

      const tick = () => {
        if (!_analyserNode) return;
        _analyserNode.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        _audioLevel = Math.min(1, _audioLevel * 0.75 + rms * 4);
        const now = Date.now() / 1000;
        audioLevels = VOICE_BAR_WEIGHTS.map((w, i) => {
          const idle = 0.12 + Math.sin(now * 1.8 + i * 0.7) * 0.06;
          const driven = _audioLevel * w;
          return Math.max(idle, driven);
        });
        _analyserRaf = requestAnimationFrame(tick);
      };
      _analyserRaf = requestAnimationFrame(tick);
    } catch {
      // Web Audio not available
    }
  }

  function _stopAnalyser() {
    if (_analyserRaf !== null) { cancelAnimationFrame(_analyserRaf); _analyserRaf = null; }
    if (_analyserNode) { _analyserNode.disconnect(); _analyserNode = null; }
    if (_audioCtx) { _audioCtx.close().catch(() => {}); _audioCtx = null; }
    if (_micStream) { _micStream.getTracks().forEach(t => t.stop()); _micStream = null; }
    _audioLevel = 0;
    audioLevels = Array(15).fill(0);
  }

  const hasSpeechRecognition = $derived.by(() => {
    // In Electron, force local Whisper path and avoid browser Web Speech API
    // (which can trigger Chromium network uploads and related chunked errors).
    if (isTauri()) return false;
    if (typeof window === 'undefined') return false;
    const w = window as Window & { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
  });

  // Can use mic: either Web Speech API or Whisper (when running in Electron/Tauri)
  const hasMicSupport = $derived(hasSpeechRecognition || isTauri());
  const activelyListening = $derived(isListening || isWhisperListening);

  const voiceMode = $derived(appStore.voiceModeActive);
  const visionReady = $derived(
    appStore.backendMode === 'api' ||
    !!(appStore.config?.llm?.local?.mmproj_path) ||
    !!(appStore.localModelActive?.hasMmproj)
  );
  const composerBusy = $derived(appStore.loading || appStore.workspaceIndexing);
  const compactComposer = $derived(composerWidth > 0 && composerWidth < 640);

  // Welcome hint state (shown above composer when centered / no messages)
  const PROVIDER_LABELS: Record<string, string> = {
    openai: 'OpenAI', openrouter: 'OpenRouter', anthropic: 'Anthropic',
    groq: 'Groq', mistral: 'Mistral', together: 'Together AI',
    deepseek: 'DeepSeek', cohere: 'Cohere', perplexity: 'Perplexity',
    lmstudio: 'LM Studio', ollama: 'Ollama', custom: 'Custom'
  };

  const activeModel = $derived(modelsStore.status?.active_model);
  const runtimeState = $derived(String(modelsStore.status?.state || ''));
  const isModelLoading = $derived(runtimeState === 'starting' || runtimeState === 'loading_model');
  const apiProviderLabel = $derived(
    appStore.backendMode === 'api'
      ? (PROVIDER_LABELS[appStore.activeProviderName] || appStore.activeProviderName)
      : null
  );
  const hasApiKey = $derived(!!appStore.activeProvider?.has_api_key);
  const modelDisplayName = $derived(
    activeModel
      ? activeModel.split(/[\\/]/).pop()?.replace(/\.gguf$/i, '') ?? activeModel
      : ''
  );

  // True when the backend is ready to accept messages (mirrors guards in sendCurrentMessage)
  const backendReady = $derived(
    appStore.backendMode === 'local'
      ? !!(appStore.selectedLocalModelPath && appStore.localModelActive)
      : !!(appStore.activeProvider?.has_api_key || appStore.activeProvider?.api_key)
  );

  function openModelHub(section?: string) {
    if (section) appStore.modelManagerOpenSection = section;
    appStore.modelManagerOpen = true;
  }

  function submit() {
    void appStore.sendCurrentMessage();
  }

  async function onFilesSelected(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files || []);
    if (!files.length) return;
    await appStore.addFiles(files);
    input.value = '';
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  function onInput(event: Event) {
    const el = event.currentTarget as HTMLTextAreaElement;
    appStore.updateComposer(el.value);
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }

  function getRecognitionCtor(): RecognitionCtor | null {
    const w = window as Window & { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
  }

  function startListening(autoSend = false) {
    if (isTauri()) {
      void toggleWhisperRecording(autoSend);
      return;
    }

    const Ctor = getRecognitionCtor();
    if (!Ctor) return;

    if (isListening) {
      if (recognition) recognition.stop();
      return;
    }

    ttsStore.stop();

    if (recognition) {
      try { recognition.stop(); } catch { /* noop */ }
      recognition = null;
    }

    // Prime the preferred mic device before starting speech recognition.
    // Chrome uses the last-activated audio stream's device for SpeechRecognition.
    const preferredMicId = appStore.config.stt?.audio_input_device_id;
    const audioConstraints: MediaStreamConstraints = preferredMicId
      ? { audio: { deviceId: { exact: preferredMicId } } }
      : { audio: true };

    void navigator.mediaDevices.getUserMedia(audioConstraints)
      .then(s => {
        // Keep stream alive for audio analyser visualization
        _micStream = s;
        _startAnalyser(s);
      })
      .catch(() => { /* permission denied or device unavailable — proceed anyway */ })
      .finally(() => {
        recognition = new Ctor!();
        recognition!.continuous = false;
        recognition!.interimResults = true;
        recognition!.lang = navigator.language || 'en-US';
        isListening = true;
        interimTranscript = '';
        startPulse();
        _attachRecognitionHandlers(autoSend);
        try { recognition!.start(); } catch { /* already started */ }
      });
    return; // handlers attached in finally block
  }

  function _attachRecognitionHandlers(autoSend = false) {
    if (!recognition) return;

    recognition.onresult = (event) => {
      let final = '';
      let interim = '';
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result[0]) {
          if ((result as unknown as { isFinal: boolean }).isFinal) {
            final += result[0].transcript;
          } else {
            interim += result[0].transcript;
          }
        }
      }
      interimTranscript = interim;
      if (final.trim()) {
        const current = appStore.composer.trim();
        const newText = current ? current + ' ' + final.trim() : final.trim();
        appStore.updateComposer(newText);
      }
    };

    recognition.onerror = () => {
      isListening = false;
      interimTranscript = '';
      stopPulse();
      _stopAnalyser();
    };

    recognition.onend = () => {
      isListening = false;
      interimTranscript = '';
      stopPulse();
      _stopAnalyser();

      if (autoSend && appStore.composer.trim() && !appStore.loading) {
        void appStore.sendCurrentMessage();
      }
    };
  }

  function toggleSpeech() {
    if (isTauri()) {
      void toggleWhisperRecording(false);
    } else if (hasSpeechRecognition) {
      startListening(false);
    }
  }

  async function toggleWhisperRecording(autoSend = false) {
    if (isWhisperListening) {
      // Stop recording and transcribe
      if (whisperRecorder && whisperRecorder.state !== 'inactive') {
        whisperRecorder.stop();
      }
      _stopAnalyser();
      return;
    }

    ttsStore.stop();
    isWhisperListening = true;
    interimTranscript = '🎤 Recording…';
    startPulse();
    whisperChunks = [];

    const preferredMicId = appStore.config.stt?.audio_input_device_id;
    const constraints: MediaStreamConstraints = preferredMicId
      ? { audio: { deviceId: { exact: preferredMicId } } }
      : { audio: true };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      // Start audio analyser for waveform visualization
      _micStream = stream;
      _startAnalyser(stream);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';

      whisperRecorder = new MediaRecorder(stream, { mimeType });
      const recordingStartedAt = Date.now();

      whisperRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) whisperChunks.push(e.data);
      };

      whisperRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        isWhisperListening = false;
        interimTranscript = '⏳ Transcribing…';
        stopPulse();
        _stopAnalyser();

        try {
          const blob = new Blob(whisperChunks, { type: mimeType });
          const elapsedMs = Date.now() - recordingStartedAt;
          if (!blob.size || elapsedMs < 250) {
            interimTranscript = '';
            toastStore.warning('Recording too short. Please speak a bit longer.');
            return;
          }
          const arrayBuf = await blob.arrayBuffer();
          const audioBytes = new Uint8Array(arrayBuf);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const result = await sttTranscribe(audioBytes as any, mimeType.split(';')[0]);
          interimTranscript = '';

          if (result.text?.trim()) {
            const current = appStore.composer.trim();
            appStore.updateComposer(current ? current + ' ' + result.text.trim() : result.text.trim());
            if (autoSend && !appStore.loading) {
              void appStore.sendCurrentMessage();
            }
          } else {
            toastStore.info('No speech detected. Try speaking closer to the microphone.');
          }
        } catch (err) {
          interimTranscript = '';
          const message = err instanceof Error ? err.message : 'Transcription failed. Please try again.';
          toastStore.error(message);
        }
      };

      whisperRecorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        isWhisperListening = false;
        interimTranscript = '';
        stopPulse();
        _stopAnalyser();
        toastStore.error('Microphone recording failed. Please check device permissions.');
      };

      whisperRecorder.start(200);

      // Auto-stop after 30s to keep STT payload small
      setTimeout(() => {
        if (whisperRecorder && whisperRecorder.state !== 'inactive') whisperRecorder.stop();
      }, 30_000);
    } catch (err) {
      isWhisperListening = false;
      interimTranscript = '';
      stopPulse();
      _stopAnalyser();
      const message = err instanceof Error ? err.message : 'Unable to access microphone.';
      toastStore.error(message);
    }
  }

  function toggleVoiceMode() {
    if (voiceMode) {
      exitVoiceMode();
    } else {
      enterVoiceMode();
    }
  }

  let destroyed = false;

  function enterVoiceMode() {
    appStore.voiceModeActive = true;

    ttsStore.onPlaybackEnd = () => {
      if (destroyed) return;
      if (appStore.voiceModeActive && !appStore.loading) {
        setTimeout(() => {
          if (destroyed || !appStore.voiceModeActive) return;
          if (isTauri()) {
            void toggleWhisperRecording(true);
          } else {
            startListening(true);
          }
        }, 400);
      }
    };

    if (isTauri()) {
      void toggleWhisperRecording(true);
    } else {
      startListening(true);
    }
  }

  function exitVoiceMode() {
    appStore.voiceModeActive = false;
    ttsStore.onPlaybackEnd = null;
    ttsStore.stop();

    if (isListening && recognition) {
      recognition.stop();
    }
    if (isWhisperListening && whisperRecorder && whisperRecorder.state !== 'inactive') {
      whisperRecorder.stop();
    }
    isListening = false;
    isWhisperListening = false;
    interimTranscript = '';
    stopPulse();
    _stopAnalyser();
  }

  $effect(() => {
    if (!voiceMode || appStore.loading || ttsStore.playing || isListening || isWhisperListening) return;
    const ttsEnabled = appStore.config.tts?.enable_voice_output && appStore.config.tts?.auto_play_voice;
    if (ttsEnabled) return;

    const timer = setTimeout(() => {
      if (appStore.voiceModeActive && !appStore.loading && !ttsStore.playing && !isListening && !isWhisperListening) {
        if (isTauri()) {
          void toggleWhisperRecording(true);
        } else if (hasSpeechRecognition) {
          startListening(true);
        }
      }
    }, 600);
    return () => clearTimeout(timer);
  });

  function startPulse() {
    stopPulse();
    pulseInterval = setInterval(() => {
      voicePulse = Math.sin(Date.now() / 200) * 0.5 + 0.5;
    }, 50);
  }

  function stopPulse() {
    if (pulseInterval) {
      clearInterval(pulseInterval);
      pulseInterval = null;
    }
    voicePulse = 0;
  }

  $effect(() => {
    if (!textarea) return;
    void appStore.composer;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
  });

  function handleDrop(event: DragEvent) {
    event.preventDefault();
    dragOver = false;
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length > 0) {
      void appStore.addFiles(files);
    }
  }

  function handleDragOver(event: DragEvent) {
    event.preventDefault();
    dragOver = true;
  }

  function handleDragLeave(event: DragEvent) {
    const related = event.relatedTarget as Node | null;
    const container = (event.currentTarget as HTMLElement);
    if (!related || !container.contains(related)) dragOver = false;
  }

  // Detect file drags anywhere in the window so we can enable pointer-events on the drop zone
  let dragLeaveTimer: ReturnType<typeof setTimeout> | null = null;

  function onWindowDragEnter(e: DragEvent) {
    if (e.dataTransfer?.types?.includes('Files')) {
      if (dragLeaveTimer) { clearTimeout(dragLeaveTimer); dragLeaveTimer = null; }
      windowDragActive = true;
    }
  }
  function onWindowDragLeave() {
    // Small delay to avoid flicker when moving between elements
    dragLeaveTimer = setTimeout(() => { windowDragActive = false; }, 100);
  }
  function onWindowDrop() {
    windowDragActive = false;
    if (dragLeaveTimer) { clearTimeout(dragLeaveTimer); dragLeaveTimer = null; }
  }

  $effect(() => {
    document.addEventListener('dragenter', onWindowDragEnter);
    document.addEventListener('dragleave', onWindowDragLeave);
    document.addEventListener('drop', onWindowDrop);
    return () => {
      document.removeEventListener('dragenter', onWindowDragEnter);
      document.removeEventListener('dragleave', onWindowDragLeave);
      document.removeEventListener('drop', onWindowDrop);
      if (dragLeaveTimer) clearTimeout(dragLeaveTimer);
    };
  });

  onDestroy(() => {
    destroyed = true;
    exitVoiceMode();
    stopPulse();
  });

  $effect(() => {
    composerHeight;
    onHeightChange?.(composerHeight);
  });
</script>

<div class={`${windowDragActive ? 'pointer-events-auto' : 'pointer-events-none'} z-20 ${centered ? 'flex items-center justify-center absolute inset-0 px-6 md:px-12' : 'absolute inset-x-0 bottom-2 px-3 pb-2 pt-4 md:bottom-3 md:px-6'}`} role="region" aria-label="Message composer" ondrop={handleDrop} ondragover={handleDragOver} ondragleave={handleDragLeave}>
  <input bind:this={fileInput} class="hidden" type="file" multiple accept={visionReady ? "image/*,.pdf,.docx,.doc,.txt,.md,.csv,.json,.html,.xml,.rtf,.epub" : ".pdf,.docx,.doc,.txt,.md,.csv,.json,.html,.xml,.rtf,.epub"} oninput={onFilesSelected} />

  {#if dragOver}
    <div class="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--border-strong)] bg-[var(--surface-highlight)]">
      <div class="text-center">
        <Paperclip class="mx-auto mb-2 h-8 w-8 text-[var(--text-tertiary)]" />
        <p class="text-sm font-medium text-[var(--text-secondary)]">{$t('composer.dropFiles')}</p>
        <p class="text-xs text-[var(--text-tertiary)]">{$t('composer.dropHint')}</p>
      </div>
    </div>
  {/if}

  <div bind:clientWidth={composerWidth} bind:clientHeight={composerHeight} class="mx-auto w-full max-w-[55rem]">
    {#if centered}
      <div class="pointer-events-auto mb-4 text-center">
        {#if isModelLoading}
          <p class="inline-flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <LoaderCircle class="h-4 w-4 animate-spin" />
            {$t('welcome.loadingModel')}
          </p>
        {:else if appStore.backendMode === 'local' && !activeModel}
          <p class="text-sm text-[var(--text-muted)]">
            {$t('welcome.noModelLoaded')}
            <button class="inline-flex items-center gap-1 text-[var(--text-secondary)] underline decoration-[var(--border)] underline-offset-2 transition hover:text-[var(--text)] hover:decoration-[var(--text-secondary)]" onclick={() => openModelHub('explore')}>
              {$t('welcome.browseAll')}
              <ArrowRight class="h-3 w-3" />
            </button>
          </p>
          <p class="mt-1.5 text-xs text-[var(--text-muted)]">
            {$t('welcome.runtimeAutoSelected')}
            <button class="text-[var(--text-secondary)] underline decoration-[var(--border)] underline-offset-2 transition hover:text-[var(--text)] hover:decoration-[var(--text-secondary)]" onclick={() => openModelHub('runtime')}>
              {$t('welcome.changeRuntime')}
            </button>
          </p>
        {:else if appStore.backendMode === 'api' && !(apiProviderLabel && hasApiKey)}
          <p class="text-sm text-[var(--text-muted)]">
            {$t('welcome.noModel')}
            <button class="inline-flex items-center gap-1 text-[var(--text-secondary)] underline decoration-[var(--border)] underline-offset-2 transition hover:text-[var(--text)] hover:decoration-[var(--text-secondary)]" onclick={() => openModelHub('providers')}>
              {$t('welcome.configureProvider')}
              <ArrowRight class="h-3 w-3" />
            </button>
          </p>
        {:else}
          <p class="text-sm text-[var(--text-secondary)]">
            {#if activeModel}
              {modelDisplayName}
            {:else if apiProviderLabel}
              {apiProviderLabel}{appStore.activeModelLabel ? ` · ${appStore.activeModelLabel}` : ''}
            {/if}
          </p>
        {/if}
      </div>
    {/if}

    <VoiceModeOverlay isListening={activelyListening} interimTranscript={interimTranscript} exitVoiceMode={exitVoiceMode} {audioLevels} />

    <div class="composer-blur-wrapper">
      <div class={`composer-shell pointer-events-auto transition ${compactComposer ? 'rounded-xl' : 'rounded-2xl'}`}>
    <ComposerModes />

    <AttachmentCards />

    <div class="px-3 pb-0.5 pt-2">
      <textarea
        bind:this={textarea}
        class="composer-textarea w-full resize-none bg-transparent text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
        placeholder={$t('chat.placeholder')}
        rows="1"
        value={appStore.composer}
        oninput={onInput}
        onkeydown={onKeydown}
      ></textarea>
    </div>

    <div class={`px-3 pb-2 pt-1 ${compactComposer ? 'space-y-1.5' : 'flex items-center justify-between'}`}>
      <div class={`flex items-center gap-1.5 ${compactComposer ? 'overflow-x-auto' : 'flex-wrap'}`}>
        <ModeSelector />

        <button class="composer-attach-btn flex items-center gap-1 rounded-md px-2 py-1 text-[13px] font-medium text-[var(--text-secondary)] transition" aria-label={$t('chat.attach')} onclick={() => fileInput?.click()}>
          <Paperclip class="h-4 w-4" />
          <span class={compactComposer ? '' : 'hidden sm:inline'}>{$t('composer.attach')}</span>
        </button>

        <div class="composer-divider h-4 w-[1px] bg-[var(--border)]"></div>

        {#if appStore.composerMode !== 'agent'}
          <SearchModeSelector />
        {/if}
      </div>

      <div class={`flex items-center gap-1.5 ${compactComposer ? 'justify-end' : 'pl-2'}`}>
        <button
          class={`voice-btn flex items-center justify-center rounded-full transition h-8 w-8 ${!hasMicSupport ? 'opacity-40 cursor-not-allowed' : ''} ${activelyListening ? 'is-listening' : ''}`}
          onclick={hasMicSupport ? toggleSpeech : undefined}
          disabled={!hasMicSupport}
          aria-label={activelyListening ? 'Stop listening' : 'Voice input'}
          title={!hasMicSupport ? 'Speech recognition not available' : activelyListening ? 'Listening…' : isWhisperListening ? interimTranscript : 'Tap to speak'}
        >
          {#if activelyListening}
            <AudioLines class="h-3.5 w-3.5" />
          {:else}
            <Mic class="h-3.5 w-3.5" />
          {/if}
        </button>
        <button
          class={`send-btn flex items-center justify-center rounded-full transition ${compactComposer ? 'h-8 min-w-[2rem] px-2.5' : 'h-8 w-8'}`}
          onclick={() => (appStore.loading ? appStore.stopStreaming() : submit())}
          disabled={!appStore.loading && (!appStore.composer.trim() || !backendReady)}
          aria-label={appStore.loading ? $t('chat.stop') : $t('chat.send')}
        >
          {#if appStore.loading}
            <Square class="h-3.5 w-3.5 fill-current" />
          {:else}
            <ArrowUp class="h-3.5 w-3.5" />
          {/if}
        </button>
      </div>
    </div>

  </div>
  </div>

    <div class="pointer-events-auto mt-1.5 text-center">
      <span class="hint-text inline-flex max-w-full px-2 py-0.5 text-xs">
        {$t('composer.hintText')}
      </span>
    </div>
  </div>
</div>

<style>
  .composer-blur-wrapper {
    position: relative;
    border-radius: var(--radius-xl);
    overflow: visible;
  }

  .composer-blur-wrapper::before {
    content: none;
  }

  .composer-shell {
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow-l);
    border-radius: var(--radius-xl);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }

  .composer-shell:focus-within {
    border-color: var(--border-strong);
    box-shadow: var(--shadow-xl);
  }

  .composer-textarea {
    min-height: 26px;
    max-height: 180px;
    font-size: 1rem;
    line-height: 1.6;
  }

  .composer-attach-btn {
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-s);
    transition: all 0.12s ease;
  }

  .composer-attach-btn:hover {
    background: var(--surface-highlight);
    color: var(--text);
    border-color: var(--border-light);
  }

  .composer-divider {
    opacity: 0.5;
  }

  .voice-btn {
    color: var(--text-secondary);
    background: var(--surface-highlight);
    border: 1px solid var(--border-light);
    border-radius: var(--radius-s);
    transition: all 0.12s ease;
  }

  .voice-btn:hover {
    color: var(--text);
    background: var(--surface-secondary);
    border-color: var(--border);
  }

  .voice-btn.is-listening {
    color: var(--primary-fg);
    background: var(--primary);
    border-color: var(--primary);
  }

  .voice-btn.is-listening:hover {
    opacity: 0.9;
  }

  .send-btn {
    color: var(--primary-fg);
    background: var(--primary);
    border: none;
    border-radius: var(--radius-s);
    transition: transform 0.1s ease, opacity 0.12s ease;
  }

  .send-btn:hover {
    opacity: 0.88;
  }

  .send-btn:active {
    transform: scale(0.96);
  }

  .send-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .send-btn:disabled:active {
    transform: none;
  }

  .hint-text {
    color: var(--text-muted);
  }

  @media (max-width: 640px) {
    .composer-textarea {
      max-height: 160px;
      min-height: 24px;
      line-height: 1.5;
    }
  }
</style>
