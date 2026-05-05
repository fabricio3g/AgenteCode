<script lang="ts">
  import { Volume2, VolumeX, Check, ChevronDown, LoaderCircle } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { KOKORO_QUALITY_VOICES, getAvailableLanguages } from '$lib/services/kokoro-tts';

  interface Props {
    selectedVoice: string;
    onSelect: (voice: string) => void;
  }

  let { selectedVoice, onSelect }: Props = $props();

  const LANGUAGES = getAvailableLanguages().map(code => ({
    code,
    label: KOKORO_QUALITY_VOICES[code].label,
    voices: KOKORO_QUALITY_VOICES[code].voices,
  }));

  let allVoices = $state<string[]>([]);
  let loaded = $state(false);
  let loading = $state(false);

  let selectedLang = $derived.by(() => {
    for (const lang of LANGUAGES) {
      if (lang.voices.some(v => v === selectedVoice)) return lang.code;
    }
    // Fallback: check by prefix
    for (const lang of LANGUAGES) {
      if (lang.voices.some(v => selectedVoice.startsWith(v.split('_')[0] + '_'))) return lang.code;
    }
    return LANGUAGES[0].code;
  });

  let voices = $derived.by(() => {
    return KOKORO_QUALITY_VOICES[selectedLang]?.voices ?? [];
  });

  let voiceOpen = $state(false);
  let langOpen = $state(false);

  $effect(() => {
    if (loaded || loading) return;
    loading = true;
    // Load all voices from the main process for validation
    import('$lib/services/tauri').then(({ invoke }) => {
      invoke<string[]>('list_tts_voices')
        .then(v => {
          allVoices = v;
          loaded = true;
        })
        .catch(() => { loaded = true; });
    });
  });

  function selectLang(code: string) {
    const langVoices = KOKORO_QUALITY_VOICES[code]?.voices;
    if (!langVoices?.length) return;
    // Keep current voice if it's in this language, otherwise pick first
    const currentInLang = langVoices.includes(selectedVoice);
    onSelect(currentInLang ? selectedVoice : langVoices[0]);
    langOpen = false;
  }

  function getVoiceLabel(voice: string): string {
    const name = voice.split('_').slice(1).join('_');
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  function getVoiceGender(voice: string): string {
    return voice.charAt(1) === 'f' ? 'Female' : 'Male';
  }

</script>

<div class="flex items-center gap-2">
  <!-- Language dropdown -->
  <div class="relative">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--text)] hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)] transition"
      onclick={() => { langOpen = !langOpen; voiceOpen = false; }}
    >
      <span>{LANGUAGES.find(l => l.code === selectedLang)?.label ?? 'Language'}</span>
      <ChevronDown class="h-3 w-3 text-[var(--text-muted)]" />
    </button>
    {#if langOpen}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="fixed inset-0 z-40" onclick={() => langOpen = false} onkeydown={() => {}}></div>
      <div class="absolute left-0 top-full z-50 mt-1 min-w-[140px] rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg py-1">
        {#each LANGUAGES as lang}
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-[var(--text)] hover:bg-[var(--surface-hover)] transition"
            onclick={() => selectLang(lang.code)}
          >
            <span>{lang.label}</span>
            {#if lang.code === selectedLang}
              <Check class="ml-auto h-3 w-3 text-[var(--primary)]" />
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Voice dropdown -->
  <div class="relative">
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-xs font-medium text-[var(--text)] hover:border-[var(--border-hover)] hover:bg-[var(--surface-hover)] transition"
      onclick={() => { voiceOpen = !voiceOpen; langOpen = false; }}
    >
      <Volume2 class="h-3 w-3 text-[var(--text-muted)]" />
      <span>{getVoiceLabel(selectedVoice)}</span>
      <span class="text-[10px] text-[var(--text-muted)]">{getVoiceGender(selectedVoice)}</span>
      <ChevronDown class="h-3 w-3 text-[var(--text-muted)]" />
    </button>
    {#if voiceOpen}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="fixed inset-0 z-40" onclick={() => voiceOpen = false} onkeydown={() => {}}></div>
      <div class="absolute left-0 top-full z-50 mt-1 min-w-[180px] max-h-[260px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg py-1">
        {#if !loaded}
          <p class="flex items-center gap-2 px-3 py-3 text-xs text-[var(--text-muted)]">
            <LoaderCircle class="h-3 w-3 animate-spin" />
            Loading voices...
          </p>
        {:else if voices.length > 0}
          {#each voices as voice}
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--surface-hover)] transition {voice === selectedVoice ? 'text-[var(--primary)] bg-[var(--primary)]/5' : 'text-[var(--text)]'}"
              onclick={() => { onSelect(voice); voiceOpen = false; }}
            >
              <Volume2 class="h-3 w-3 shrink-0 {voice === selectedVoice ? 'text-[var(--primary)]' : 'text-[var(--text-muted)]'}" />
              <span class="truncate">{getVoiceLabel(voice)}</span>
              <span class="text-[10px] text-[var(--text-muted)]">{getVoiceGender(voice)}</span>
              {#if voice === selectedVoice}
                <Check class="ml-auto h-3 w-3 shrink-0" />
              {/if}
            </button>
          {/each}
        {:else}
          <p class="px-3 py-2 text-xs text-[var(--text-muted)]">No voices for this language</p>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Volume slider -->
  <div class="flex items-center gap-1.5">
    <VolumeX class="h-3 w-3 text-[var(--text-muted)]" />
    <input
      type="range"
      min="0"
      max="200"
      value={(appStore.config.tts?.volume ?? 1) * 100}
      oninput={(e) => {
        const vol = Number(e.currentTarget.value) / 100;
        appStore.updateTtsSettings?.({ volume: vol } as any);
      }}
      class="h-1 w-20 cursor-pointer accent-[var(--primary)]"
    />
    <Volume2 class="h-3 w-3 text-[var(--text-muted)]" />
  </div>
</div>
