<svelte:options runes={true} />

<script lang="ts">
  import { Paperclip, Search, Square, ArrowUp, X, Globe, Database, LoaderCircle, ArrowRight, Mic } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { modelsStore } from '$lib/stores/models.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { isTauri } from '$lib/services/tauri';
  import { sttTranscribe } from '$lib/services/stt';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

import ModeSelector from './composer/ModeSelector.svelte';
  import SearchModeSelector from './composer/SearchModeSelector.svelte';
  import ReasoningLevelSelector from './composer/ReasoningLevelSelector.svelte';
  import CodeComposerControls from './composer/CodeComposerControls.svelte';
  import VoiceModeOverlay from './composer/VoiceModeOverlay.svelte';
  import AttachmentCards from './composer/AttachmentCards.svelte';
  import ContextUsageRing from './composer/ContextUsageRing.svelte';

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
  let ocrProgress = $state<{ phase: 'rendering' | 'recognizing' | 'done'; page: number; total: number } | null>(null);
  let ocrProgressHideTimer: ReturnType<typeof setTimeout> | null = null;
  let voicePulse = $state(0);
  let pulseInterval: ReturnType<typeof setInterval> | null = null;
  let composerWidth = $state(0);
  let composerHeight = $state(0);
  let contextBudgetTimer: ReturnType<typeof setTimeout> | null = null;
  let selectedTextInsert = $state('');
  let selectedTextCardText = $state('');
  let selectedTextSourceMessageId = $state('');
  let selectedTextExpanded = $state(false);

  // Rotating placeholder with typewriter + shimmer
  let placeholderIndex = $state(0);
  let showErrorPlaceholder = $state(false);
  let errorPlaceholderTimer: ReturnType<typeof setTimeout> | null = null;
  let textareaFocused = $state(false);
  const placeholders = $derived(($t('chat.placeholders') as string || '').split('|').filter(Boolean));
  const errorPlaceholderText = $derived($t('chat.errorPlaceholder') as string || 'Something went wrong. Try again.');
  const currentPlaceholder = $derived(
    showErrorPlaceholder
      ? errorPlaceholderText
      : appStore.currentChatGenerating && appStore.composerMode === 'agent'
        ? 'Agent working…'
        : (placeholders[placeholderIndex] || 'Message...')
  );

  const isHomescreen = $derived(!appStore.currentChat?.messages?.length);
  const isCodeMode = $derived(appStore.currentContextMode === 'code');
  const staticPlaceholderText = $derived(
    showErrorPlaceholder
      ? errorPlaceholderText
      : appStore.currentChatGenerating && appStore.composerMode === 'agent'
        ? 'Agent working…'
        : 'Ask me anything…'
  );

  const placeholderVisible = $derived(!appStore.composer.trim() && !textareaFocused);
  const showAnimatedPlaceholder = $derived(placeholderVisible && isHomescreen);
  const showStaticPlaceholder = $derived(placeholderVisible && !isHomescreen);

  // Typewriter animation state
  let typedText = $state('');
  let typingTimer: ReturnType<typeof setTimeout> | null = null;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  const TYPING_SPEED_MS = 30;
  const PLACEHOLDER_DISPLAY_MS = 3500;

  function typePlaceholder(text: string) {
    if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
    if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
    typedText = '';
    let i = 0;

    function step() {
      if (i < text.length) {
        typedText = text.slice(0, i + 1);
        i++;
        typingTimer = setTimeout(step, TYPING_SPEED_MS);
      } else {
        // Done typing — schedule next rotation if still relevant
        const current = untrack(() => currentPlaceholder);
        if (current === text && placeholders.length > 1 && !showErrorPlaceholder && !appStore.currentChatGenerating) {
          pauseTimer = setTimeout(() => {
            placeholderIndex = (placeholderIndex + 1) % placeholders.length;
          }, PLACEHOLDER_DISPLAY_MS);
        }
      }
    }
    step();
  }

  function clearErrorPlaceholder() {
    showErrorPlaceholder = false;
    if (errorPlaceholderTimer) {
      clearTimeout(errorPlaceholderTimer);
      errorPlaceholderTimer = null;
    }
  }

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

  const hasMediaRecorderSupport = $derived(
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  );

  // Can use mic: either Web Speech API or Whisper (when running in Electron)
  const hasMicSupport = $derived(hasSpeechRecognition || (isTauri() && hasMediaRecorderSupport));
  const activelyListening = $derived(isListening || isWhisperListening);
  const micUiActive = $derived(activelyListening || interimTranscript.includes('Requesting microphone'));

  const voiceMode = $derived(appStore.voiceModeActive);
  const currentChatGenerating = $derived(appStore.currentChatGenerating);
  const localBusyElsewhere = $derived(appStore.currentChatBlockedByOtherLocalRun);
  const composerBusy = $derived(currentChatGenerating || localBusyElsewhere || appStore.workspaceIndexing);
  const compactComposer = $derived(composerWidth > 0 && composerWidth < 640);
  const contextBudget = $derived(appStore.contextBudget);
  const showContextUsage = $derived(contextBudget !== null);

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
  const hasApiKey = $derived(!!appStore.activeProvider?.has_api_key || !!appStore.activeProvider?.api_key);
  const modelDisplayName = $derived(
    activeModel
      ? activeModel.split(/[\\/]/).pop()?.replace(/\.gguf$/i, '') ?? activeModel
      : ''
  );

  const welcomeHeadline = $derived.by(() => {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();

    const daytime = hour < 5 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening';

    const variants: Record<string, string[]> = {
      morning: ['Good morning', 'Fresh start', 'Let’s build something great'],
      afternoon: ['Good afternoon', 'Keep the momentum', 'What are we solving today?'],
      evening: ['Good evening', 'Quiet focus mode', 'Let’s finish strong'],
      night: ['Late-night session', 'Night owl mode', 'Still curious? Let’s go']
    };

    const choices = variants[daytime];
    return choices[day % choices.length];
  });

  // True when the backend is ready to accept messages (mirrors guards in sendCurrentMessage)
  const backendReady = $derived(
    appStore.backendMode === 'local'
      ? !!(appStore.selectedLocalModelPath && appStore.localModelActive)
      : !!((appStore.activeProvider?.has_api_key || appStore.activeProvider?.api_key) && appStore.activeProvider?.model)
  );
  const sendDisabled = $derived(!currentChatGenerating && (!backendReady || localBusyElsewhere));

  function openModelHub(section?: string) {
    if (section) appStore.modelManagerOpenSection = section;
    appStore.modelManagerOpen = true;
  }

  async function submit() {
    clearOcrProgress();
    if (localBusyElsewhere) {
      toastStore.info('Local model is busy in another chat.', 2400);
      return;
    }

    if (selectedTextCardText.trim() && appStore.composer.trim()) {
      const userQuestion = appStore.composer.trim();
      const quotedSelection = selectedTextCardText
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n');
      appStore.updateComposer(`${quotedSelection}\n\n${userQuestion}`);
      selectedTextInsert = '';
      selectedTextCardText = '';
      selectedTextSourceMessageId = '';
      selectedTextExpanded = false;
      await appStore.sendCurrentMessage();
      return;
    }

    await appStore.sendCurrentMessage();
  }

  async function onFilesSelected(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files || []);
    if (!files.length) return;
    clearOcrProgress();
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

  function focusComposer(moveCursorToEnd = true) {
    if (!textarea) return;
    textarea.focus();
    if (moveCursorToEnd) {
      const length = textarea.value.length;
      textarea.setSelectionRange(length, length);
    }
  }

  function handleAskSelectedText(event: Event) {
    const detail = (event as CustomEvent<{ text?: string; sourceMessageId?: string }>).detail;
    const text = (detail?.text || '').trim();
    if (!text) return;

    selectedTextInsert = text;
    selectedTextCardText = text;
    selectedTextSourceMessageId = detail?.sourceMessageId || '';
    selectedTextExpanded = false;
    requestAnimationFrame(() => focusComposer());
  }

  function discardSelectedTextInsert() {
    if (!selectedTextInsert) return;
    selectedTextInsert = '';
    selectedTextCardText = '';
    selectedTextSourceMessageId = '';
    selectedTextExpanded = false;
    requestAnimationFrame(() => focusComposer());
  }

  function handleFocusComposer() {
    focusComposer();
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

      if (autoSend && appStore.composer.trim() && !appStore.currentChatGenerating && !appStore.currentChatBlockedByOtherLocalRun) {
        void appStore.sendCurrentMessage();
      }
    };
  }

  function microphoneAccessMessage(err: unknown): string {
    const name = err instanceof DOMException ? err.name : '';
    const platform = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      if (platform === 'win32') {
        return 'Microphone permission is blocked. Enable Windows Settings → Privacy & security → Microphone → Microphone access and Let desktop apps access your microphone.';
      }
      if (platform === 'darwin') {
        return 'Microphone permission is blocked. Enable System Settings → Privacy & Security → Microphone for Electron/Terminal, then restart the app.';
      }
      return 'Microphone permission is blocked. Please allow microphone access and try again.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No microphone was found. Connect a microphone and try again.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Microphone is already in use by another app.';
    }
    return err instanceof Error ? err.message : 'Unable to access microphone.';
  }

  function toggleSpeech() {
    if (!hasMicSupport) {
      toastStore.error('Microphone recording is not available in this environment.');
      return;
    }
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

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toastStore.error('Microphone recording is not available in this environment.');
      return;
    }

    ttsStore.stop();
    interimTranscript = 'Requesting microphone access…';
    startPulse();
    whisperChunks = [];

    const preferredMicId = appStore.config.stt?.audio_input_device_id;
    const constraints: MediaStreamConstraints = preferredMicId
      ? { audio: { deviceId: { exact: preferredMicId } } }
      : { audio: true };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      isWhisperListening = true;
      interimTranscript = '🎤 Recording…';
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
            if (autoSend && !appStore.currentChatGenerating && !appStore.currentChatBlockedByOtherLocalRun) {
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
      toastStore.error(microphoneAccessMessage(err));
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
      if (appStore.voiceModeActive && !appStore.currentChatGenerating) {
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
    if (!voiceMode || appStore.currentChatGenerating || ttsStore.playing || isListening || isWhisperListening) return;
    const ttsEnabled = appStore.config.tts?.enable_voice_output && appStore.config.tts?.auto_play_voice;
    if (ttsEnabled) return;

    const timer = setTimeout(() => {
      if (appStore.voiceModeActive && !appStore.currentChatGenerating && !ttsStore.playing && !isListening && !isWhisperListening) {
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

  function clearOcrProgress() {
    if (ocrProgressHideTimer) {
      clearTimeout(ocrProgressHideTimer);
      ocrProgressHideTimer = null;
    }
    ocrProgress = null;
  }

  function onOcrProgress(event: Event) {
    const customEvent = event as CustomEvent<{ page?: number; total?: number; phase?: 'rendering' | 'recognizing' | 'done' }>;
    const detail = customEvent.detail;
    if (!detail) return;

    if (ocrProgressHideTimer) {
      clearTimeout(ocrProgressHideTimer);
      ocrProgressHideTimer = null;
    }

    const phase = detail.phase || 'recognizing';
    const page = Number.isFinite(detail.page) ? Number(detail.page) : 0;
    const total = Number.isFinite(detail.total) ? Number(detail.total) : 0;

    if (phase === 'done') {
      ocrProgress = { phase, page, total };
      ocrProgressHideTimer = setTimeout(() => {
        ocrProgress = null;
        ocrProgressHideTimer = null;
      }, 900);
      return;
    }

    ocrProgress = { phase, page, total };
  }

  const ocrProgressLabel = $derived.by(() => {
    if (!ocrProgress) return '';
    const page = Math.max(0, ocrProgress.page || 0);
    const total = Math.max(0, ocrProgress.total || 0);
    const progressText = total > 0 ? `${Math.min(page, total)}/${total}` : '…';

    if (ocrProgress.phase === 'rendering') return `Reading document ${progressText}`;
    if (ocrProgress.phase === 'recognizing') return `Reading document ${progressText}`;
    return 'Document ready';
  });

  $effect(() => {
    void appStore.currentChatId;
    clearOcrProgress();
  });

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
    window.addEventListener('ocr-progress', onOcrProgress as EventListener);
    window.addEventListener('ask-selected-text', handleAskSelectedText as EventListener);
    window.addEventListener('focus-composer', handleFocusComposer);
    return () => {
      document.removeEventListener('dragenter', onWindowDragEnter);
      document.removeEventListener('dragleave', onWindowDragLeave);
      document.removeEventListener('drop', onWindowDrop);
      window.removeEventListener('ocr-progress', onOcrProgress as EventListener);
      window.removeEventListener('ask-selected-text', handleAskSelectedText as EventListener);
      window.removeEventListener('focus-composer', handleFocusComposer);
      if (dragLeaveTimer) clearTimeout(dragLeaveTimer);
    };
  });

  $effect(() => {
    if (appStore.currentChatGenerating) {
      clearErrorPlaceholder();
    } else {
      const messages = untrack(() => appStore.currentChat?.messages);
      const lastMsg = messages?.length ? messages[messages.length - 1] : undefined;
      if (lastMsg?.role === 'assistant' && lastMsg?.status === 'error' && !showErrorPlaceholder) {
        showErrorPlaceholder = true;
        if (errorPlaceholderTimer) clearTimeout(errorPlaceholderTimer);
        errorPlaceholderTimer = setTimeout(() => {
          showErrorPlaceholder = false;
        }, 12000);
      }
    }
  });

  // Trigger typewriter only on homescreen
  $effect(() => {
    if (!appStore.composer.trim() && isHomescreen) {
      typePlaceholder(currentPlaceholder);
    }
  });

  // Stop typewriter when user navigates away from homescreen
  $effect(() => {
    if (!isHomescreen) {
      if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
      if (pauseTimer) { clearTimeout(pauseTimer); pauseTimer = null; }
      typedText = '';
    }
  });

  onDestroy(() => {
    destroyed = true;
    exitVoiceMode();
    stopPulse();
    clearOcrProgress();
    if (typingTimer) clearTimeout(typingTimer);
    if (pauseTimer) clearTimeout(pauseTimer);
    if (errorPlaceholderTimer) clearTimeout(errorPlaceholderTimer);
  });

  $effect(() => {
    composerHeight;
    onHeightChange?.(composerHeight);
  });

  $effect(() => {
    void appStore.currentChatId;
    void appStore.composer;
    void appStore.pendingAttachments.length;
    void appStore.currentRagDocuments.length;
    void appStore.currentChat?.messages.length;
    void appStore.searchMode;
    void appStore.composerMode;
    void appStore.currentContextMode;
    void appStore.backendMode;
    void appStore.activeProviderName;
    void appStore.activeProvider?.model;
    void appStore.activeProvider?.max_tokens;
    void appStore.activeProvider?.base_url;
    void appStore.activeProvider?.has_api_key;
    void appStore.config.llm?.local?.context_length;
    void appStore.config.llm?.local?.max_tokens;
    void appStore.config.llm?.local?.system_prompt;
    void appStore.config.llm?.system_prompt;
    void appStore.userName;

    if (contextBudgetTimer) clearTimeout(contextBudgetTimer);
    contextBudgetTimer = setTimeout(() => {
      void appStore.refreshContextBudgetPreview();
    }, 140);

    return () => {
      if (contextBudgetTimer) {
        clearTimeout(contextBudgetTimer);
        contextBudgetTimer = null;
      }
    };
  });
</script>

<div class={`${windowDragActive ? 'pointer-events-auto' : 'pointer-events-none'} z-20 ${centered ? 'flex items-center justify-center absolute inset-0 px-6 md:px-12' : 'absolute inset-x-0 bottom-2 -translate-x-2 px-3 pb-2 pt-4 md:bottom-3 md:px-6'}`} role="region" aria-label="Message composer" ondrop={handleDrop} ondragover={handleDragOver} ondragleave={handleDragLeave}>
  <input bind:this={fileInput} class="hidden" type="file" multiple accept="image/*,.pdf,.docx,.doc,.txt,.md,.csv,.json,.html,.xml,.rtf,.epub" oninput={onFilesSelected} />

  {#if dragOver}
    <div class="absolute inset-0 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--border-hover)] bg-[var(--surface-hover)]">
      <div class="text-center">
        <Paperclip class="mx-auto mb-2 h-8 w-8 text-[var(--text-tertiary)]" />
        <p class="text-sm font-medium text-[var(--text-secondary)]">{$t('composer.dropFiles')}</p>
        <p class="text-xs text-[var(--text-tertiary)]">{$t('composer.dropHint')}</p>
      </div>
    </div>
  {/if}

  <div bind:clientWidth={composerWidth} bind:clientHeight={composerHeight} class="welcome-shell mx-auto w-full max-w-[55rem]">
    {#if centered}
      <div class="pointer-events-auto mb-4 text-center">
        <h1 class="welcome-headline">{welcomeHeadline}</h1>
        {#if isModelLoading}
          <p class="inline-flex items-center gap-2 text-sm text-[var(--text-muted)]">
            <LoaderCircle class="h-4 w-4 animate-spin" />
            {$t('welcome.loadingModel')}
          </p>
        {:else if appStore.backendMode === 'local' && !activeModel && !appStore.localModelActive}
          <div class="welcome-model-prompt mx-auto mt-3 flex max-w-md flex-col items-center gap-3">
            <div class="text-center">
              <p class="text-sm font-semibold text-[var(--text)]">{$t('welcome.noModelLoaded')}</p>
              <p class="mt-0.5 text-xs font-medium text-[var(--text-secondary)]">{$t('welcome.runtimeAutoSelected')}</p>
            </div>
            <div class="flex flex-wrap items-center justify-center gap-2">
              <button class="welcome-action-btn primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold" onclick={() => openModelHub('explore')}>
                {$t('welcome.browseAll')}
                <ArrowRight class="h-3 w-3" />
              </button>
              <button class="welcome-action-btn inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium" onclick={() => openModelHub('runtime')}>
                {$t('welcome.changeRuntime')}
              </button>
            </div>
          </div>
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
            {#if appStore.backendMode === 'local'}
              {#if appStore.localModelActive?.name}
                {appStore.localModelActive.name.split(/[\\/]/).pop()?.replace(/\.gguf$/i, '') || appStore.localModelActive.name}
              {:else if activeModel}
                {modelDisplayName}
              {/if}
            {:else if appStore.backendMode === 'api' && apiProviderLabel}
              {apiProviderLabel}{appStore.activeModelLabel ? ` · ${appStore.activeModelLabel}` : ''}
            {/if}
          </p>
        {/if}
      </div>
    {/if}

    <VoiceModeOverlay isListening={activelyListening} interimTranscript={interimTranscript} exitVoiceMode={exitVoiceMode} {audioLevels} />

    <div class="composer-blur-wrapper">
      <div class={`composer-shell pointer-events-auto transition ${compactComposer ? 'rounded-xl' : 'rounded-2xl'}`}>
    {#if ocrProgressLabel}
      <div class="px-3 pt-1">
        <div class="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-[var(--text-muted)]">
          <span class={`h-1.5 w-1.5 rounded-[2px] bg-[var(--text-tertiary)] ${ocrProgress?.phase === 'done' ? '' : 'animate-pulse'}`}></span>
          <span>{ocrProgressLabel}</span>
        </div>
      </div>
    {/if}

    <AttachmentCards />

    {#if localBusyElsewhere}
      <div class="px-4 pt-1 text-[11px] text-[var(--text-muted)]">
        Local model busy in another chat
      </div>
    {/if}

    {#if selectedTextInsert}
      <div class="px-4 pt-3">
        <div class="selected-text-card" class:expanded={selectedTextExpanded}>
          <button type="button" class="selected-text-card-float-close" aria-label="Discard selected text" onclick={discardSelectedTextInsert}>
            <X class="h-3 w-3" />
          </button>
          <div class="selected-text-card-body">
            {#if selectedTextExpanded}
              <textarea
                class="selected-text-card-textarea"
                bind:value={selectedTextCardText}
                rows="3"
                onblur={() => (selectedTextExpanded = false)}
              ></textarea>
            {:else}
              <button type="button" class="selected-text-card-preview" onclick={() => (selectedTextExpanded = true)}>
                {selectedTextCardText}
              </button>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    <div class={`px-4 pb-1 relative ${selectedTextInsert ? 'pt-1.5' : 'pt-3'}`}>
      {#if showAnimatedPlaceholder}
        <div class="placeholder-overlay pointer-events-none absolute left-4 right-4 top-3 z-10">
          <span class="placeholder-shimmer-text">{typedText}</span>
        </div>
      {:else if showStaticPlaceholder}
        <div class="placeholder-overlay pointer-events-none absolute left-4 right-4 top-3 z-10">
          <span class="placeholder-static-text">{staticPlaceholderText}</span>
        </div>
      {/if}
      <textarea
        bind:this={textarea}
        class="composer-textarea w-full resize-none bg-transparent text-[var(--text)] outline-none"
        placeholder=""
        rows="1"
        value={appStore.composer}
        oninput={onInput}
        onkeydown={onKeydown}
        onfocus={() => (textareaFocused = true)}
        onblur={() => (textareaFocused = false)}
      ></textarea>
    </div>

    <div class={`composer-action-row px-4 pb-3 pt-2 ${compactComposer ? 'compact' : ''}`}>
      <div class={`composer-left-actions flex items-center gap-1.5 ${compactComposer ? 'overflow-x-auto' : 'flex-wrap'}`}>
        {#if isCodeMode}
          <CodeComposerControls />
{:else}
          <ModeSelector />

          <SearchModeSelector />

          <ReasoningLevelSelector />
        {/if}
      </div>

      <div class={`composer-right-actions flex items-center gap-1.5 ${compactComposer ? '' : 'pl-2'}`}>
        {#if showContextUsage}
          <ContextUsageRing
            usedTokens={contextBudget?.usedTokens ?? 0}
            maxTokens={contextBudget?.maxContext ?? Number(appStore.config.llm?.local?.context_length || 4096)}
            reservedTokens={contextBudget?.reservedForCompletion ?? 0}
            promptCostPerMillionUsd={contextBudget?.promptCostPerMillionUsd}
            completionCostPerMillionUsd={contextBudget?.completionCostPerMillionUsd}
            estimatedInputCostUsd={contextBudget?.estimatedInputCostUsd}
          />
        {/if}
        <button class="chateaui-icon-button metal-hover-btn h-8 w-8" aria-label={$t('chat.attach')} onclick={() => fileInput?.click()}>
          <Paperclip class="h-4 w-4" />
        </button>
        {#if appStore.composer.trim() || currentChatGenerating}
          <button
            class="send-btn flex h-8 w-8 items-center justify-center rounded-full text-white transition disabled:opacity-50"
            onclick={() => (currentChatGenerating ? appStore.stopStreaming() : submit())}
            disabled={sendDisabled}
            aria-label={currentChatGenerating ? $t('chat.stop') : $t('chat.send')}
          >
            {#if currentChatGenerating}
              <Square class="h-3.5 w-3.5 fill-current stroke-[2.75]" />
            {:else}
              <span class="send-icon-wrap inline-flex">
                <ArrowUp class="h-3.5 w-3.5 stroke-[2.75]" />
              </span>
            {/if}
          </button>
        {:else}
          <button
            class={`chateaui-icon-button mic-btn metal-hover-btn h-8 w-8 ${!hasMicSupport ? 'opacity-40 cursor-not-allowed' : ''} ${micUiActive ? 'is-listening' : ''}`}
            onclick={hasMicSupport ? toggleSpeech : undefined}
            disabled={!hasMicSupport}
            aria-label={activelyListening ? 'Stop listening' : 'Voice input'}
            title={!hasMicSupport ? 'Speech recognition not available' : activelyListening ? 'Listening…' : isWhisperListening ? interimTranscript : 'Tap to speak'}
          >
            {#if activelyListening}
              <span class="mic-lines-wrap">
                {#each [0, 1, 2, 3, 4] as i}
                  <span class="mic-line" style="animation-delay: {i * 0.12}s;"></span>
                {/each}
              </span>
            {:else}
              <Mic class="h-4 w-4 mic-icon" />
            {/if}
          </button>
        {/if}
      </div>
    </div>

  </div>
  </div>

    <div class="pointer-events-auto -mt-2 flex justify-center relative z-[-1]">
      <div class="hint-card rounded-b-xl border border-t-0 border-[var(--border)] bg-[var(--surface)] px-3 pb-2 pt-3 text-center shadow-[var(--shadow-xs)]">
        <span class="hint-text text-xs">
          {$t('composer.hintText')}
        </span>
      </div>
    </div>
  </div>
</div>

<style>
  .welcome-shell {
    position: relative;
  }

  .composer-blur-wrapper {
    position: relative;
    border-radius: var(--radius-2xl);
    overflow: visible;
  }


  .composer-blur-wrapper::before {
    content: none;
  }

  .composer-shell {
    border: 1px solid transparent;
    background:
      linear-gradient(var(--surface), var(--surface)) padding-box,
      linear-gradient(180deg, rgba(245, 245, 245, 0.95) 0%, rgba(223, 223, 223, 0.94) 44%, rgba(196, 196, 196, 0.92) 52%, rgba(232, 232, 232, 0.95) 100%) border-box;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.25),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      var(--shadow-xs);
    border-radius: var(--radius-2xl);
    transition: box-shadow 0.15s ease, filter 0.15s ease;
  }

  :global(.dark) .composer-shell {
    background:
      linear-gradient(var(--surface), var(--surface)) padding-box,
      linear-gradient(180deg, rgba(255, 255, 255, 0.34) 0%, rgba(255, 255, 255, 0.18) 38%, rgba(0, 0, 0, 0.45) 52%, rgba(255, 255, 255, 0.24) 100%) border-box;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.14),
      inset 0 -1px 0 rgba(0, 0, 0, 0.35),
      var(--shadow-xs);
  }

  .composer-shell:focus-within {
    filter: brightness(1.01);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.4),
      inset 0 -1px 0 rgba(0, 0, 0, 0.04),
      var(--shadow-sm);
  }

  .composer-textarea {
    min-height: 26px;
    max-height: 180px;
    font-size: 1rem;
    line-height: 1.6;
  }

  .selected-text-card {
    position: relative;
    background: var(--background);
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    overflow: hidden;
  }

  .selected-text-card-body {
    padding: 0.65rem 0.75rem;
  }

  .selected-text-card-preview {
    width: 100%;
    text-align: left;
    font-size: 12px;
    line-height: 1.4;
    color: var(--text);
    background: transparent;
    border: 0;
    padding: 0;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .selected-text-card-textarea {
    width: 100%;
    background: transparent;
    border: 0;
    outline: none;
    resize: none;
    font-size: 12px;
    line-height: 1.4;
    color: var(--text);
    font-family: inherit;
    padding: 0;
  }

  .selected-text-card-float-close {
    position: absolute;
    top: 0.35rem;
    right: 0.35rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.35rem;
    height: 1.35rem;
    padding: 0;
    border-radius: 9999px;
    border: 0;
    background: var(--surface);
    color: var(--text-tertiary);
    cursor: pointer;
    transition: background 0.12s ease, color 0.12s ease;
  }

  .selected-text-card-float-close:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .composer-attach-btn {
    color: var(--text-secondary);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--radius-full);
    transition: all 0.12s ease;
  }

  .composer-attach-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
    border-color: var(--border);
  }

  .composer-divider {
    opacity: 0.5;
  }

  .composer-action-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .composer-left-actions {
    min-width: 0;
    flex: 1 1 auto;
  }

  .composer-right-actions {
    flex: 0 0 auto;
    justify-content: flex-end;
  }

  .metal-hover-btn {
    position: relative;
    overflow: hidden;
    border: 1px solid transparent;
  }

  .metal-hover-btn::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1px;
    pointer-events: none;
    opacity: 0;
    background: linear-gradient(180deg, rgba(245, 245, 245, 0.96) 0%, rgba(223, 223, 223, 0.94) 44%, rgba(196, 196, 196, 0.92) 52%, rgba(232, 232, 232, 0.95) 100%);
    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
    transition: opacity 0.15s ease;
  }

  .metal-hover-btn:hover:not(:disabled)::before {
    opacity: 1;
  }

  .metal-hover-btn:hover:not(:disabled) {
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.28),
      inset 0 -1px 0 rgba(0, 0, 0, 0.05),
      var(--shadow-xs);
  }

  :global(.dark) .metal-hover-btn::before {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.34) 0%, rgba(255, 255, 255, 0.18) 38%, rgba(0, 0, 0, 0.45) 52%, rgba(255, 255, 255, 0.24) 100%);
  }

  .send-btn {
    background: linear-gradient(180deg, #818af0 0%, #717CE2 52%, #626edc 100%);
    border: 1px solid color-mix(in srgb, #dbe0ff 58%, #5f69c9 42%);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.45),
      inset 0 -1px 0 rgba(0, 0, 0, 0.2),
      0 0 0 1px rgba(226, 231, 255, 0.18);
    transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1), filter 150ms ease, box-shadow 150ms ease;
  }

  .send-btn:hover:not(:disabled) {
    filter: brightness(1.03);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.5),
      inset 0 -1px 0 rgba(0, 0, 0, 0.22),
      0 0 0 1px rgba(226, 231, 255, 0.24),
      var(--shadow-xs);
  }

  .send-icon-wrap {
    transform-origin: center;
    transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .send-btn:hover:not(:disabled) .send-icon-wrap {
    transform: rotate(35deg) translate(1px, -1px);
  }

  .send-btn:active:not(:disabled) {
    transform: scale(0.96);
  }

  .hint-text {
    color: var(--text-muted);
  }

  .mic-icon {
    transition: transform 0.3s ease;
  }

  .mic-btn:hover .mic-icon {
    transform: scale(1.1);
  }

  .mic-btn.is-listening {
    background: linear-gradient(180deg, #818af0 0%, #717CE2 52%, #626edc 100%);
    border-color: color-mix(in srgb, #dbe0ff 58%, #5f69c9 42%);
    color: #ffffff;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.45),
      inset 0 -1px 0 rgba(0, 0, 0, 0.2),
      0 0 0 1px rgba(226, 231, 255, 0.18);
  }

  .mic-btn.is-listening:hover {
    opacity: 0.95;
  }

  .mic-lines-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    height: 14px;
  }

  .mic-line {
    width: 2px;
    height: 6px;
    border-radius: 1px;
    background: currentColor;
    animation: micLineBounce 0.8s ease-in-out infinite;
  }

  @keyframes micLineBounce {
    0%, 100% { height: 5px; opacity: 0.5; }
    50% { height: 14px; opacity: 1; }
  }

  .welcome-headline {
    margin: 0 0 0.55rem;
    transform: translateY(-1.9rem);
    font-size: clamp(2rem, 4.6vw, 3rem);
    line-height: 1.02;
    letter-spacing: -0.04em;
    font-weight: 720;
    color: var(--text);
    user-select: text;
    -webkit-user-select: text;
  }

  .welcome-action-btn {
    border-radius: var(--radius-full);
    border: 1px solid transparent;
    background:
      linear-gradient(var(--surface), var(--surface)) padding-box,
      linear-gradient(180deg, rgba(242, 242, 242, 0.72), rgba(218, 218, 218, 0.58), rgba(238, 238, 238, 0.68)) border-box;
    color: var(--text);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.025), var(--shadow-xs);
    transition: filter 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
  }

  .welcome-action-btn:hover {
    filter: brightness(1.02);
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -1px 0 rgba(0,0,0,0.035), var(--shadow-sm);
  }

  .welcome-action-btn:active {
    transform: scale(0.97);
  }

  :global(.dark) .welcome-action-btn {
    background:
      linear-gradient(var(--surface), var(--surface)) padding-box,
      linear-gradient(180deg, rgba(255, 255, 255, 0.18), rgba(0, 0, 0, 0.32), rgba(255, 255, 255, 0.12)) border-box;
    box-shadow: inset 0 1px 0 rgba(255,255,255,0.09), inset 0 -1px 0 rgba(0,0,0,0.18), var(--shadow-xs);
  }

  @keyframes shimmer {
    0% { background-position: 200% 50%; }
    100% { background-position: -200% 50%; }
  }

  .placeholder-overlay {
    min-height: 26px;
    font-size: 1rem;
    line-height: 1.6;
  }

  .placeholder-shimmer-text {
    color: transparent;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    -webkit-background-clip: text;
    background-image: linear-gradient(
      to right,
      var(--text-muted) 30%,
      var(--text) 50%,
      var(--text-muted) 70%
    );
    background-size: 200% auto;
    animation: shimmer 4s infinite linear;
  }

  .placeholder-static-text {
    color: var(--text-muted);
  }

  @media (max-width: 640px) {
    .composer-action-row.compact {
      align-items: center;
      flex-wrap: wrap;
      gap: 0.45rem;
    }

    .composer-action-row.compact .composer-left-actions {
      flex: 1 1 12rem;
      max-width: none;
      min-width: min(100%, 10rem);
      padding-bottom: 1px;
      scrollbar-width: none;
    }

    .composer-action-row.compact .composer-left-actions::-webkit-scrollbar {
      display: none;
    }

    .composer-action-row.compact .composer-right-actions {
      margin-left: auto;
      align-self: center;
    }

    .composer-action-row.compact .composer-left-actions :global(.mode-selector-trigger),
    .composer-action-row.compact .composer-left-actions :global(.search-selector-trigger) {
      white-space: nowrap;
    }

    .composer-textarea {
      max-height: 160px;
      min-height: 24px;
      line-height: 1.5;
    }
  }
</style>
