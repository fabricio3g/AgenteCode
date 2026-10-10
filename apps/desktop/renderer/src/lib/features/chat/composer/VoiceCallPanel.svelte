<svelte:options runes={true} />
<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { onMount, onDestroy } from 'svelte';
  import { Mic, MicOff, PhoneOff, Volume2, VolumeX, Settings2 } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { Tooltip } from '$lib/components/ui';
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
    : call.transcribing ? $t('voice.call.transcribing') : call.waiting ? $t('voice.call.finishing') : appStore.currentChatGenerating ? $t('voice.call.replying') : call.noise ? $t('voice.call.noise') : $t('voice.call.listening'));
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
  <div class="call-row">
    <Tooltip label={call.muted ? $t('voice.call.unmute') : $t('voice.call.mute')} position="top">
      <UiIconButton label={call.muted ? $t('voice.call.unmute') : $t('voice.call.mute')} size="sm" type="button" class={uiClass(" input-toggle", "ui-local-3fee7e8a", {"hearing": call.speech})}   aria-pressed={call.muted} onclick={() => call.toggleMute()}>
        {#if call.muted}<MicOff class="size-4" />{:else}<Mic class="size-4" />{/if}
      </UiIconButton>
    </Tooltip>
    <div class="call-status">
      <span role="status">{title}</span>
      {#if tool && appStore.composerMode !== 'instant'}<span class="activity">{tool.label}</span>{/if}
    </div>
    <div class="input-meter" class:hearing={call.speech} role="meter" aria-label={$t('voice.call.inputLevel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(call.level * 100)}>
      {#each [0,1,2,3] as index}<i class:lit={call.level * 4 > index}></i>{/each}
    </div>
    <div class="call-controls">
      <Tooltip label={outputMuted ? $t('voice.call.enableOutput') : $t('voice.call.silenceOutput')} position="top">
        <UiIconButton label={outputMuted ? $t('voice.call.enableOutput') : $t('voice.call.silenceOutput')} size="sm" type="button" class={uiClass("", "ui-local-3fee7e8a")}  aria-pressed={outputMuted} onclick={() => { outputMuted = !outputMuted; if (outputMuted) ttsStore.stop(); }}>{#if outputMuted}<VolumeX class="size-4" />{:else}<Volume2 class="size-4" />{/if}</UiIconButton>
      </Tooltip>
      <Tooltip label={`${$t('voice.call.settings')} · ${model} · ${call.deviceLabel || inputRoute} → ${outputRoute}`} position="top">
        <UiIconButton label={$t('voice.call.settings')} size="sm" type="button" class={uiClass("", "ui-local-3fee7e8a")}  onclick={() => { onend(); appStore.openSettings('voice'); }}><Settings2 class="size-4" /></UiIconButton>
      </Tooltip>
      <Tooltip label={$t('voice.call.end')} position="top">
        <UiIconButton label={$t('voice.call.end')} size="sm" type="button" class={uiClass(" end-call", "ui-local-3fee7e8a")}  onclick={onend}><PhoneOff class="size-4" /></UiIconButton>
      </Tooltip>
    </div>
  </div>
  {#if ttsStore.lastError}<p class="call-error" role="alert">{ttsStore.lastError}</p>{/if}
  {#if call.error}<p class="call-error" role="alert">{call.error}</p>{/if}
</section>

<style>
  .call-panel { background: var(--float-bg); border: 1px solid var(--float-border); border-radius: var(--float-radius); box-shadow: var(--float-shadow); padding: .375rem .5rem; margin-bottom: .5rem; font-size: var(--text-sm); }
  .call-row, .call-controls { display: flex; align-items: center; gap: .35rem; }
  .call-row { min-height: 2rem; }
  .call-status { display: grid; flex: 1; min-width: 0; gap: .15rem; padding-inline: .25rem; }
  .call-status > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .activity { color: var(--muted-foreground); font-size: var(--text-xs); }
  :global(.input-toggle.hearing.ui-local-3fee7e8a) { color: var(--accent-strong); background: var(--accent-soft); }
  .input-meter { display: flex; gap: 2px; align-items: center; margin-inline: .35rem; }
  .input-meter i { width: 2px; height: 12px; border-radius: 2px; background: var(--muted); }
  .input-meter i.lit { background: var(--muted-foreground); }
  :is(.input-meter.hearing, :global(.input-meter.hearing.ui-local-3fee7e8a)) i.lit { background: var(--accent-strong); }
  .call-controls { gap: .1rem; flex-shrink: 0; }
  :global(.end-call:hover.ui-local-3fee7e8a) { color: var(--error); }
  .call-error { color: var(--warning); line-height: 1.5; margin: .4rem .25rem; font-size: var(--text-xs); }
</style>
