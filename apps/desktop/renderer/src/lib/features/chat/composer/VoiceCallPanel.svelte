<svelte:options runes={true} />
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Mic, MicOff, PhoneOff, Volume2, VolumeX, Settings2 } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { VoiceCall } from './voice-call.svelte';
  import { voiceText } from './voice-text.svelte';
  import { SpokenReply } from './voice-activity';
  let { onend }: { onend: () => void } = $props();
  const chatId = appStore.currentChatId;
  let outputMuted = $state(false);
  let interruptedReply = $state<string | undefined>();
  const cursors = new Map<string, SpokenReply>();
  const audioIds: string[] = [];
  let part = 0;
  const playbackText = new Map<string, { messageId: string; text: string }>();
  const chat = $derived(appStore.currentChat);
  const reply = $derived(chat?.messages.slice().reverse().find(message => message.role === 'assistant' && !message.metadata?.codeCompaction));
  const latestUserId = $derived(chat?.messages.slice().reverse().find(message => message.role === 'user')?.id);
  let observedUserId: string | undefined;
  $effect(() => { if (latestUserId !== observedUserId) { observedUserId = latestUserId; interruptedReply = undefined; } });
  const tool = $derived(reply?.agentSteps?.slice().reverse().find(step => step.status === 'running' && step.type !== 'thinking'));
  const call = new VoiceCall({
    onSpeech: () => { interruptedReply = reply?.id; ttsStore.stop(); },
    onText: text => {
      if (!chatId || appStore.currentChatId !== chatId) return;
      // Existing per-chat queue preserves a running search; speaking does not
      // cancel the tools or another conversation's turn.
      void appStore.sendVoicePrompt(chatId, text);
    }
  });
  const title = $derived(call.phase === 'permission' ? $t('voice.call.permission') : call.phase === 'error' ? $t('voice.call.unavailable')
    : call.muted ? $t('voice.call.muted') : call.speech ? $t('voice.call.hearing') : ttsStore.audioStarted ? $t('voice.call.speaking') : ttsStore.isGenerating ? $t('voice.call.preparingAudio')
    : $t('voice.call.listening'));
  const inputRoute = $derived(appStore.config.stt?.provider === 'api' ? appStore.config.stt.api_provider || $t('voice.call.cloud') : appStore.config.stt?.provider === 'local' ? $t('voice.call.local') : $t('voice.call.automatic'));
  const outputRoute = $derived(appStore.config.tts?.backend_mode === 'api' ? appStore.config.tts.api_provider || $t('voice.call.cloud') : appStore.config.tts?.backend_mode === 'browser' ? $t('voice.call.system') : $t('voice.call.local'));
  const model = $derived(appStore.backendMode === 'local' ? chat?.modelSelection?.localModel || $t('voice.call.local') : chat?.modelSelection?.model || appStore.config.llm?.providers?.[appStore.config.llm?.provider || '']?.model || '');

  onMount(() => { if (appStore.config.tts?.backend_mode !== 'api' && appStore.config.tts?.backend_mode !== 'browser') void ttsStore.preloadEngine(); voiceText.start(chatId); if (reply) { const cursor = new SpokenReply(); cursor.skip(reply.content || ''); cursors.set(reply.id, cursor); voiceText.buffer(reply.id, reply.content || ''); } void call.start(appStore.config.stt?.audio_input_device_id); });
  onDestroy(() => { voiceText.finish(); call.stop(); ttsStore.stop(); ttsStore.forgetAudio(audioIds); });
  $effect(() => { if (appStore.currentChatId !== chatId || appStore.activeSpace !== 'home') onend(); });
  $effect(() => {
    if (!reply || !reply.content || call.phase !== 'listening') return;
    let cursor = cursors.get(reply.id);
    if (!cursor) { cursor = new SpokenReply(); cursors.set(reply.id, cursor); voiceText.buffer(reply.id); }
    if (outputMuted || interruptedReply === reply.id) { cursor.skip(reply.content); if (outputMuted) voiceText.reveal(reply.id, reply.content); return; }
    const text = cursor.take(reply.content, reply.status !== 'streaming' && !!reply.done);
    if (!text) return;
    const id = `voice-call-${chatId}-${part++}`;
    audioIds.push(id);
    playbackText.set(id, { messageId: reply.id, text: reply.content.slice(0, cursor.position) });
    ttsStore.enqueueSpeech([{ id, text, config: appStore.config }]);
  });
  $effect(() => { if (ttsStore.lastError && reply?.done) voiceText.reveal(reply.id, reply.content); });
  $effect(() => {
    if (!ttsStore.audioStarted || !ttsStore.currentMessageId) return;
    const part = playbackText.get(ttsStore.currentMessageId);
    if (part) voiceText.reveal(part.messageId, part.text);
  });
</script>

<section class="call-panel" aria-label={$t('voice.call.title')}>
  <div class="call-heading">
    <div><strong>{$t('voice.call.title')}</strong><span class="route">{model}</span></div>
    <button type="button" class="ui-icon-button" aria-label={$t('voice.call.settings')} onclick={() => { onend(); appStore.openSettings('voice'); }}><Settings2 class="size-4" /></button>
  </div>
  <div class="call-live">
    <div class="input-mark" class:hearing={call.speech} class:muted={call.muted} aria-hidden="true">
      {#if call.muted}<MicOff class="size-5" />{:else}<Mic class="size-5" />{/if}
    </div>
    <div class="call-status"><span role="status">{title}</span>
      <span class="activity">{tool?.label || (call.transcribing ? $t('voice.call.transcribing') : appStore.currentChatGenerating ? $t('voice.call.replying') : $t('voice.call.interruptHint'))}</span>
    </div>
    <div class="input-meter" role="meter" aria-label={$t('voice.call.inputLevel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(call.level * 100)}>
      {#each [0,1,2,3,4,5,6,7] as index}<i class:lit={call.level * 8 > index}></i>{/each}
    </div>
  </div>
  {#if ttsStore.lastError}<p class="call-error" role="alert">{ttsStore.lastError}</p>{/if}
  {#if call.lastTranscript}<p class="transcript">{call.lastTranscript}</p>{/if}
  {#if call.error}<p class="call-error" role="alert">{call.error}</p>{/if}
  <div class="call-footer">
    <span class="route">{$t('voice.call.input')}: {call.deviceLabel || inputRoute} · {$t('voice.call.output')}: {outputRoute}</span>
    <div class="call-controls">
      <button type="button" class="ui-icon-button" aria-label={call.muted ? $t('voice.call.unmute') : $t('voice.call.mute')} aria-pressed={call.muted} onclick={() => call.toggleMute()}>{#if call.muted}<MicOff class="size-4" />{:else}<Mic class="size-4" />{/if}</button>
      <button type="button" class="ui-icon-button" aria-label={outputMuted ? $t('voice.call.enableOutput') : $t('voice.call.silenceOutput')} aria-pressed={outputMuted} onclick={() => { outputMuted = !outputMuted; if (outputMuted) ttsStore.stop(); }}>{#if outputMuted}<VolumeX class="size-4" />{:else}<Volume2 class="size-4" />{/if}</button>
      <button type="button" class="end-call" onclick={onend}><PhoneOff class="size-4" />{$t('voice.call.end')}</button>
    </div>
  </div>
</section>

<style>
  .call-panel { background: var(--surface); border-radius: var(--radius-xl); box-shadow: var(--shadow-md); padding: 1rem; margin-bottom: .75rem; font-size: var(--text-sm); }
  .call-heading, .call-live, .call-footer, .call-controls { display: flex; align-items: center; gap: .75rem; }
  .call-heading, .call-footer { justify-content: space-between; }
  .call-heading > div { display: grid; gap: .2rem; min-width: 0; }
  strong { font-size: var(--text-base); font-weight: 600; }
  .route, .activity { color: var(--muted-foreground); font-size: var(--text-xs); overflow-wrap: anywhere; }
  .call-live { margin: 1rem 0; }
  .input-mark { display: grid; place-items: center; width: 2.75rem; height: 2.75rem; border-radius: 50%; background: var(--muted); color: var(--foreground); transition: background 100ms; flex-shrink: 0; }
  .input-mark.hearing { background: var(--accent-soft); color: var(--accent-strong); }
  .input-mark.muted { color: var(--muted-foreground); }
  .call-status { display: grid; gap: .25rem; flex: 1; min-width: 0; }
  .input-meter { display: flex; gap: 3px; align-items: center; }
  .input-meter i { width: 3px; height: 16px; border-radius: 2px; background: var(--muted); }
  .input-meter i.lit { background: var(--accent-strong); }
  .transcript { margin: .5rem 0 1rem; line-height: 1.6; overflow-wrap: anywhere; max-height: 5rem; overflow-y: auto; }
  .call-error { color: var(--warning); line-height: 1.5; }
  .call-controls { gap: .25rem; }
  .end-call { display: inline-flex; align-items: center; gap: .4rem; border: 0; border-radius: var(--radius-md); padding: .5rem .65rem; background: var(--muted); color: var(--foreground); cursor: pointer; font-size: var(--text-sm); }
  .end-call:hover { background: var(--surface-hover); }
  @media (max-width: 480px) { .call-footer { flex-wrap: wrap; } }
  @media (prefers-reduced-motion: reduce) { .input-mark { transition: none; } }
</style>
