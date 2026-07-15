<script lang="ts">
  import { Volume2, VolumeX, Check, ChevronDown, LoaderCircle } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { KOKORO_LANGUAGES, getVoiceInfo, type KokoroVoice } from '$lib/services/kokoro-tts';

  interface Props {
    selectedVoice: string;
    onSelect: (voice: string) => void;
  }

  let { selectedVoice, onSelect }: Props = $props();

  let allVoices = $state<string[]>([]);
  let loaded = $state(false);
  let loading = $state(false);

  let selectedLang = $derived.by(() => {
    const info = getVoiceInfo(selectedVoice);
    if (info) return info.langCode;
    return KOKORO_LANGUAGES[0]?.code ?? 'en-US';
  });

  let currentLangVoices = $derived.by(() => {
    const lang = KOKORO_LANGUAGES.find(l => l.code === selectedLang);
    return lang?.voices ?? [];
  });

  let femaleVoices = $derived(currentLangVoices.filter(v => v.gender === 'female'));
  let maleVoices = $derived(currentLangVoices.filter(v => v.gender === 'male'));

  let voiceOpen = $state(false);
  let langOpen = $state(false);

  $effect(() => {
    if (loaded || loading) return;
    loading = true;
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
    const lang = KOKORO_LANGUAGES.find(l => l.code === code);
    if (!lang?.voices.length) return;
    const currentInLang = lang.voices.some(v => v.id === selectedVoice);
    onSelect(currentInLang ? selectedVoice : lang.voices[0].id);
    langOpen = false;
  }

  function getVoiceLabel(voice: string): string {
    const info = getVoiceInfo(voice);
    if (info) return info.name;
    const name = voice.split('_').slice(1).join('_');
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  function getVoiceGender(voice: string): string {
    return voice.charAt(1) === 'f' ? 'Female' : 'Male';
  }

  function voiceAvailable(voice: string): boolean {
    if (!loaded || allVoices.length === 0) return true;
    return allVoices.includes(voice);
  }
</script>

<div class="flex items-center gap-2">
  <!-- Language dropdown -->
  <div class="relative">
    <button
      type="button"
      class="aui-select-trigger"
      onclick={() => { langOpen = !langOpen; voiceOpen = false; }}
    >
      <span>{KOKORO_LANGUAGES.find(l => l.code === selectedLang)?.label ?? 'Language'}</span>
      <ChevronDown class="h-3 w-3 text-[var(--text-muted)]" />
    </button>
    {#if langOpen}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="fixed inset-0 z-40" onclick={() => langOpen = false} onkeydown={() => {}}></div>
      <div class="absolute left-0 top-full z-50 mt-1 min-w-[160px] max-h-[320px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg py-1">
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

  <!-- Voice dropdown -->
  <div class="relative">
    <button
      type="button"
      class="aui-select-trigger"
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
      <div class="absolute left-0 top-full z-50 mt-1 min-w-[200px] max-h-[360px] overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-lg py-1">
        {#if !loaded}
          <p class="flex items-center gap-2 px-3 py-3 text-xs text-[var(--text-muted)]">
            <LoaderCircle class="h-3 w-3 animate-spin" />
            Loading voices...
          </p>
        {:else}
          {#if femaleVoices.length > 0}
            <div class="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">Female</div>
            {#each femaleVoices as voice (voice.id)}
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--surface-hover)] transition {voice.id === selectedVoice ? 'text-[var(--primary)] bg-[var(--primary)]/5' : 'text-[var(--text)]'}"
                onclick={() => { onSelect(voice.id); voiceOpen = false; }}
                disabled={!voiceAvailable(voice.id)}
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
                onclick={() => { onSelect(voice.id); voiceOpen = false; }}
                disabled={!voiceAvailable(voice.id)}
              >
                <Volume2 class="h-3 w-3 shrink-0 {voice.id === selectedVoice ? 'text-[var(--primary)]' : 'text-[var(--text-muted)]'}" />
                <span class="truncate">{voice.name}</span>
                {#if voice.id === selectedVoice}
                  <Check class="ml-auto h-3 w-3 shrink-0" />
                {/if}
              </button>
            {/each}
          {/if}
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
