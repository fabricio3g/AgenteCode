<svelte:options runes={true} />

<!--
  Voices cloned from a recording: a few seconds of clean speech the local
  model imitates. Record from the microphone or pick an audio file (through main's dialog); it is
  converted to a mono 24 kHz WAV here and kept in the app's voice folder.
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import { LoaderCircle, Mic, Play, Square, Trash2, Upload } from '$lib/icons';
  import type { ClonedVoice } from '$shared/voice-models';
  import { Button, Input, Tooltip } from '$lib/components/ui';
  import { invoke } from '$lib/services/bridge';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';

  const RATE = 24000;
  const MAX_SECONDS = 30;

  const clones = $derived(appStore.config.tts?.cloned_voices ?? []);

  let samples = $state<Float32Array | null>(null);
  let source = $state('');
  let name = $state('');
  let transcript = $state('');
  let recording = $state(false);
  let elapsed = $state(0);
  let saving = $state(false);
  let playing = $state<string | null>(null);
  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let audio: HTMLAudioElement | null = null;

  const seconds = $derived(samples ? samples.length / RATE : 0);

  async function toMono24k(buffer: ArrayBuffer): Promise<Float32Array> {
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(buffer);
      const length = Math.max(1, Math.ceil(Math.min(decoded.duration, MAX_SECONDS) * RATE));
      const offline = new OfflineAudioContext(1, length, RATE);
      const node = offline.createBufferSource();
      node.buffer = decoded;
      node.connect(offline.destination); // channels are down-mixed to mono
      node.start();
      return (await offline.startRendering()).getChannelData(0);
    } finally {
      void ctx.close();
    }
  }

  function encodeWav(data: Float32Array): Uint8Array {
    const out = new DataView(new ArrayBuffer(44 + data.length * 2));
    const text = (at: number, value: string) => [...value].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
    text(0, 'RIFF'); out.setUint32(4, 36 + data.length * 2, true); text(8, 'WAVEfmt ');
    out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, RATE, true); out.setUint32(28, RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
    text(36, 'data'); out.setUint32(40, data.length * 2, true);
    data.forEach((v, i) => out.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, v)) * 32767), true));
    return new Uint8Array(out.buffer);
  }

  function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  async function load(blob: Blob, label: string) {
    try {
      samples = await toMono24k(await blob.arrayBuffer());
      source = label;
      if (!name.trim()) name = label.replace(/\.[^.]+$/, '').slice(0, 60);
    } catch (error) {
      samples = null;
      toastStore.error((error as Error)?.message || $t('voice.clone.unreadable'));
    }
  }

  async function pickFile() {
    try {
      const picked = await invoke<{ name: string; base64: string } | null>('voice_clone_pick');
      if (!picked) return;
      const bytes = Uint8Array.from(atob(picked.base64), (c) => c.charCodeAt(0));
      await load(new Blob([bytes]), picked.name);
    } catch (error) {
      toastStore.error((error as Error)?.message || $t('voice.clone.unreadable'));
    }
  }

  function endRecording() {
    clearInterval(timer);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  async function record() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      toastStore.error($t('voice.clone.micDenied'));
      return;
    }
    const chunks: Blob[] = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = () => {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      recording = false;
      void load(new Blob(chunks), $t('voice.clone.recording'));
    };
    elapsed = 0;
    recording = true;
    recorder.start();
    timer = setInterval(() => {
      elapsed += 0.1;
      if (elapsed >= MAX_SECONDS) endRecording();
    }, 100);
  }

  async function save() {
    if (!samples || !name.trim()) return;
    saving = true;
    try {
      const voice = await invoke<ClonedVoice>('voice_clone_save', {
        name: name.trim(), wavBase64: toBase64(encodeWav(samples)), transcript: transcript.trim() || undefined, seconds: Math.round(seconds * 10) / 10
      });
      await appStore.updateTtsSettings({ cloned_voices: [...clones, voice], cloned_voice: voice.id });
      samples = null; source = ''; name = ''; transcript = '';
    } catch (error) {
      toastStore.error((error as Error)?.message || String(error));
    } finally {
      saving = false;
    }
  }

  async function remove(voice: ClonedVoice) {
    await invoke('voice_clone_delete', { file: voice.file }).catch(() => false);
    const left = clones.filter((item) => item.id !== voice.id);
    await appStore.updateTtsSettings({ cloned_voices: left, cloned_voice: appStore.config.tts?.cloned_voice === voice.id ? '' : appStore.config.tts?.cloned_voice });
  }

  function stopPreview() {
    audio?.pause();
    if (audio?.src.startsWith('blob:')) URL.revokeObjectURL(audio.src);
    audio = null;
  }

  async function play(voice: ClonedVoice) {
    const same = playing === voice.id;
    stopPreview();
    playing = null;
    if (same) return;
    playing = voice.id;
    const base64 = await invoke<string | null>('voice_clone_read', { file: voice.file }).catch(() => null);
    if (playing !== voice.id) return;
    if (!base64) { playing = null; toastStore.error($t('voice.clone.unreadable')); return; }
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    audio = new Audio(URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })));
    audio.onended = () => { if (playing === voice.id) playing = null; };
    audio.onerror = () => { playing = null; toastStore.error($t('voice.clone.unreadable')); };
    void audio.play().catch(() => { playing = null; });
  }

  onDestroy(() => {
    endRecording();
    stopPreview();
  });
</script>

<div class="clones">
  {#each clones as voice (voice.id)}
    <div class="clone">
      <div class="min-w-0 flex-1">
        <p class="truncate text-[length:var(--text-sm)] text-foreground">{voice.name}</p>
        {#if voice.seconds}<p class="text-xs text-muted-foreground">{voice.seconds.toFixed(1)} s</p>{/if}
      </div>
      <Tooltip label={$t('voice.preview')} position="bottom"><Button variant="ghost" size="icon-sm" onclick={() => void play(voice)} aria-label={$t('voice.preview')}>
        {#if playing === voice.id}<Square />{:else}<Play />{/if}
      </Button></Tooltip>
      <Tooltip label={$t('voice.clone.delete')} position="bottom"><IconButton label={$t('voice.clone.delete')} variant="ghost" size="sm" onclick={() => void remove(voice)} ><Trash2 /></IconButton></Tooltip>
    </div>
  {/each}

  <p class="text-[length:var(--text-sm)] font-medium text-foreground" title={$t('voice.clone.addHint')}>{$t('voice.clone.add')}</p>

  <div class="flex flex-wrap items-center gap-2">
    {#if recording}
      <Button variant="outline" size="sm" onclick={endRecording}><Square /> {$t('voice.clone.stop')} · {elapsed.toFixed(1)} / {MAX_SECONDS} s</Button>
    {:else}
      <Button variant="outline" size="sm" onclick={() => void record()}><Mic /> {$t('voice.clone.record')}</Button>
      <Button variant="outline" size="sm" onclick={() => void pickFile()}><Upload /> {$t('voice.clone.choose')}</Button>
    {/if}
    {#if samples}<span class="text-xs text-muted-foreground">{source} · {seconds.toFixed(1)} s</span>{/if}
  </div>

  {#if samples}
    <Input value={name} oninput={(event) => (name = (event.currentTarget as HTMLInputElement).value)} placeholder={$t('voice.clone.name')} aria-label={$t('voice.clone.name')} />
    <Input value={transcript} oninput={(event) => (transcript = (event.currentTarget as HTMLInputElement).value)} placeholder={$t('voice.clone.transcript')} aria-label={$t('voice.clone.transcript')} />
    <div>
      <Button size="sm" disabled={saving || !name.trim()} onclick={() => void save()}>
        {#if saving}<LoaderCircle class="animate-spin" />{/if} {$t('voice.clone.save')}
      </Button>
    </div>
  {/if}
</div>

<style>
  .clones { display: flex; flex-direction: column; gap: 0.625rem; padding: 0.875rem 1rem; }
  .clone {
    display: flex; align-items: center; gap: 0.25rem; padding: 0.375rem 0.5rem 0.375rem 0.75rem;
    border: 1px solid var(--border-subtle); border-radius: var(--float-row-radius);
  }
</style>
