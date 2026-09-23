<script lang="ts">
  import { Volume2, VolumeX, Check, ChevronDown, LoaderCircle } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { copy, say } from '$lib/copy';
  import { KOKORO_LANGUAGES, getVoiceInfo, type KokoroVoice } from '$lib/services/kokoro-tts';

  interface Props {
    selectedVoice: string;
    onSelect: (voice: string) => void;
    /** Onboarding picks a voice before any playback exists; hide the slider there. */
    showVolume?: boolean;
  }

  let { selectedVoice, onSelect, showVolume = true }: Props = $props();

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
    import('$lib/services/bridge').then(({ invoke }) => {
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
  <Menu bind:open={langOpen} label="Language" minWidth="10rem" class="max-h-[320px] overflow-y-auto">
    {#snippet trigger(props)}
      <button type="button" class="aui-select-trigger" {...props}>
        <span>{KOKORO_LANGUAGES.find(l => l.code === selectedLang)?.label ?? 'Language'}</span>
        <ChevronDown class="h-3 w-3 text-[var(--text-muted)]" />
      </button>
    {/snippet}
    {#each KOKORO_LANGUAGES as lang (lang.code)}
      <MenuItem active={lang.code === selectedLang} onselect={() => selectLang(lang.code)}>
        <span>{lang.label}</span>
        <span class="ml-auto text-[10px] text-[var(--text-muted)]">{lang.voices.length}</span>
        {#if lang.code === selectedLang}<Check class="h-3 w-3 text-[var(--primary)]" />{/if}
      </MenuItem>
    {/each}
  </Menu>

  <!-- Voice dropdown -->
  <Menu bind:open={voiceOpen} label="Voice" minWidth="12.5rem" class="max-h-[360px] overflow-y-auto">
    {#snippet trigger(props)}
      <button type="button" class="aui-select-trigger" {...props}>
        <Volume2 class="h-3 w-3 text-[var(--text-muted)]" />
        <span>{getVoiceLabel(selectedVoice)}</span>
        <span class="text-[10px] text-[var(--text-muted)]">{getVoiceGender(selectedVoice)}</span>
        <ChevronDown class="h-3 w-3 text-[var(--text-muted)]" />
      </button>
    {/snippet}
    {#if !loaded}
      <p class="flex items-center gap-2 px-3 py-3 text-xs text-[var(--text-muted)]">
        <LoaderCircle class="h-3 w-3 animate-spin" />
        {say.inProgress(copy.status.loading)}
      </p>
    {:else}
      {#each [{ label: 'Female', voices: femaleVoices }, { label: 'Male', voices: maleVoices }] as group (group.label)}
        {#if group.voices.length > 0}
          <div class="px-3 pb-1 pt-1.5 text-[10px] font-semibold text-[var(--text-muted)]">{group.label}</div>
          {#each group.voices as voice (voice.id)}
            <MenuItem
              active={voice.id === selectedVoice}
              disabled={!voiceAvailable(voice.id)}
              onselect={() => { onSelect(voice.id); voiceOpen = false; }}
            >
              <Volume2 class="h-3 w-3 shrink-0 {voice.id === selectedVoice ? 'text-[var(--primary)]' : 'text-[var(--text-muted)]'}" />
              <span class="truncate">{voice.name}</span>
              {#if voice.id === selectedVoice}<Check class="ml-auto h-3 w-3 shrink-0" />{/if}
            </MenuItem>
          {/each}
        {/if}
      {/each}
    {/if}
  </Menu>

  {#if showVolume}
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
  {/if}
</div>
