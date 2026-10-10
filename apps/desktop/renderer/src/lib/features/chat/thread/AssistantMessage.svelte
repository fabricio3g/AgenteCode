<svelte:options runes={true} />

<script lang="ts">
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import { AlertTriangle, Copy, Dices, FileSearch, GitBranch, Pencil, Pin, RefreshCcw, Trash2, Volume2, X } from 'lucide-svelte';
  import { Button } from '$lib/components/ui';
  import RecallLine from '$lib/features/roleplay/RecallLine.svelte';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { roleplayStore } from '$lib/features/roleplay/roleplay.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import { copy } from '$lib/copy';
  import { stripChartBlocks } from '$lib/utils/charts';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import FileChangesCard from '$lib/components/agent/FileChangesCard.svelte';
  import { charactersStore, greetingsFor } from '$lib/features/roleplay/characters.svelte';
  import SwipePager from '$lib/features/roleplay/SwipePager.svelte';
  import ChoicePanel from '$lib/features/roleplay/ChoicePanel.svelte';
  import PropCard from '$lib/features/roleplay/PropCard.svelte';
  import PromptInspectorModal from '$lib/features/roleplay/PromptInspectorModal.svelte';
  import TtsAudioPlayer from '$lib/features/chat/TtsAudioPlayer.svelte';
  import { messageSpeechParts } from '$lib/features/roleplay/roleplay-voice';
  import BranchPicker from './BranchPicker.svelte';
  import MessageActionBar from './MessageActionBar.svelte';
  import MessageFooter from './MessageFooter.svelte';
  import MessageParts from './MessageParts.svelte';
  import { compactActions, type MessageAction } from './message-actions';
  import { useMessage } from './message-context';

  interface Props {
    hovering: boolean;
    onmenutoggle?: (open: boolean) => void;
  }

  let { hovering, onmenutoggle }: Props = $props();

  const ctx = useMessage();
  let promptOpen = $state(false);

  const diffStats = $derived(
    ctx.message.agentSteps?.flatMap((step) => step.diffStats || []) || []
  );
  /** Roleplay: the character this turn belongs to, when one is bound. */
  const speaker = $derived(charactersStore.getById(ctx.message.speakerId)
    ?? (ctx.contextMode === 'roleplay' ? ctx.displayMetadata?.roleplay?.sceneAfter.npcs.find((npc) => npc.id === ctx.message.speakerId) : undefined));

  /**
   * The greeting is the first turn of a roleplay chat. It gets the ‹ 1 / 3 ›
   * pager below its bubble so the opening can be flipped in place.
   */
  const chat = $derived(appStore.currentChat);
  const snapshot = $derived(chat?.contextMode === 'roleplay' ? ctx.displayMetadata?.roleplay : undefined);
  const presentation = $derived(chat?.contextMode === 'roleplay' ? roleplayStore.settings(chat) : undefined);
  const separateSpeakers = $derived(ctx.contextMode === 'roleplay');
  const isGreetingMessage = $derived(
    chat?.contextMode === 'roleplay' && chat.messages?.[0]?.id === ctx.message.id
  );
  /** Dynamic scenes: what the dice chose for this turn, as one quiet line. */
  const decision = $derived.by(() => {
    if (snapshot?.mode !== 'dynamic' || !snapshot.settled) return '';
    const outcome = snapshot.outcomeApplied && snapshot.outcome && snapshot.settings.showOutcomes ? $t(`roleplay.outcome.${snapshot.outcome}`) : '';
    const direction = snapshot.direction && snapshot.direction !== 'quiet' ? $t(`roleplay.direction.${snapshot.direction}`) : '';
    return [direction, outcome].filter(Boolean).join(' · ');
  });
  /** Roleplay: the latest reply can be swiped to another version, or a new one. */
  const swipeable = $derived(
    chat?.contextMode === 'roleplay' && !isGreetingMessage && !ctx.isStreaming && !ctx.message.metadata?.error
      && chat.messages.at(-1)?.id === ctx.message.id
  );
  const greetingCharacter = $derived(
    isGreetingMessage ? charactersStore.getById(chat?.characterId) : null
  );
  const greetingCount = $derived(
    greetingCharacter
      ? greetingsFor(greetingCharacter, { group: (chat?.roleplay?.characterIds?.length || 0) > 1 }).length
      : 0
  );

  /** Adventure choices render only on the newest reply, never mid-stream. */
  const adventureChoices = $derived.by(() => {
    const choices = snapshot?.choices ?? ctx.message.choices ?? [];
    if (!choices.length || chat?.contextMode !== 'roleplay' || ctx.isStreaming) return [];
    const last = chat.messages?.[chat.messages.length - 1];
    return last?.id === ctx.message.id ? choices.map((choice) => roleplayStore.displayText(choice, { messageId: ctx.message.id })) : [];
  });
  /** Props the turn put in the user's hands — roleplay's own artifacts. */
  // Not called `props`: Svelte would read `$props` in this scope as a store
  // subscription to it and the component would not compile.
  const handedProps = $derived(chat?.contextMode === 'roleplay' ? snapshot?.props ?? ctx.message.props ?? [] : []);
  /** Hiding the panel is per message; it must never turn the feature off. */
  let choicesDismissed = $state(false);
  const hasActiveDeepResearch = $derived(
    !!deepResearchStore.getActiveTaskForMessage(ctx.message.id)
  );

  /**
   * A roleplay reply whose generation failed: the error is written into the
   * message, so it shows as an error row with Retry, never as the character's line.
   */
  const roleplayFailed = $derived(chat?.contextMode === 'roleplay' && !!ctx.message.metadata?.error && !ctx.isStreaming);
  const recall = $derived(chat?.contextMode === 'roleplay' && !roleplayFailed ? snapshot?.recall : undefined);
  const retryBusy = $derived(appStore.currentChatGenerating || appStore.currentChatBlockedByOtherLocalRun);

  const ttsEnabled = $derived(!!appStore.config.tts?.enable_voice_output && presentation?.voicePlayback !== false);
  const ttsBusy = $derived(
    ttsStore.currentMessageId === ctx.message.id && (ttsStore.isGenerating || ttsStore.playing || ttsStore.paused)
  );
  const hasTtsAudio = $derived(ttsStore.hasStoredAudio(ctx.message.id) || !!ctx.message.ttsAudio);
  const showTtsPlayer = $derived(
    ttsEnabled && !ctx.isStreaming && (hasTtsAudio || ((ttsStore.playing || ttsStore.paused) && ttsStore.currentMessageId === ctx.message.id))
  );

  // Charts render as their own blocks, so the copyable text is the prose only.
  // Roleplay copies what is shown; the raw text would carry unresolved macros.
  const copyableText = $derived(stripChartBlocks(ctx.displayContent) || (ctx.contextMode === 'roleplay' ? '' : ctx.message.content) || '');

  function toggleTts() {
    if (ttsBusy || (separateSpeakers && ttsStore.currentMessageId?.startsWith(`${ctx.message.id}:voice:`))) {
      ttsStore.stop();
      return;
    }
    const text = ctx.displayContent;
    if (!text.trim()) return;
    if (separateSpeakers) ttsStore.speakSequence(messageSpeechParts({ ...ctx.message, content: text, versions: [] }, charactersStore.characters, appStore.config));
    else void ttsStore.speak(ctx.message.id, text, appStore.config);
  }

  const actions = $derived<MessageAction[]>(
    compactActions([
      {
        id: 'copy',
        label: copy.actions.copy,
        icon: Copy,
        primary: true,
        confirms: true,
        run: () => void writeToClipboard(copyableText)
      },
      // The opening greeting is picked with the pager, not regenerated: a
      // retry there would ask the model to rewrite the card's own words.
      !isGreetingMessage && {
        id: 'retry',
        label: copy.actions.retry,
        icon: RefreshCcw,
        primary: true,
        disabled: appStore.currentChatGenerating || appStore.currentChatBlockedByOtherLocalRun,
        run: () => appStore.regenerateMessage(ctx.message.id)
      },
      {
        id: 'edit',
        label: copy.actions.edit,
        icon: Pencil,
        run: () => appStore.openEditMessage(ctx.message.id)
      },
      !isGreetingMessage && {
        id: 'branch',
        label: $t('thread.branchFromHere'),
        icon: GitBranch,
        disabled: appStore.currentChatGenerating,
        run: () => appStore.branchFromMessage(ctx.message.id)
      },
      // Roleplay: show the composed prompt, lore and token estimate.
      snapshot?.mode === 'dynamic' && snapshot.settings.rerollEnabled && {
        id: 'reroll', label: $t('roleplay.newDirection'), icon: Dices,
        disabled: appStore.currentChatGenerating || appStore.currentChatBlockedByOtherLocalRun,
        run: () => appStore.regenerateMessage(ctx.message.id, { reroll: true })
      },
      chat?.contextMode === 'roleplay' && {
        id: 'pin',
        label: $t('roleplay.memory.pinAction'),
        icon: Pin,
        run: () => roleplayStore.pinToMemory(ctx.message.content || '')
      },
      chat?.contextMode === 'roleplay' && {
        id: 'prompt',
        label: $t('roleplay.prompt'),
        icon: FileSearch,
        run: () => (promptOpen = true)
      },
      ttsEnabled && {
        id: 'listen',
        label: copy.thread.listen,
        icon: Volume2,
        activeLabel: copy.thread.stopListening,
        activeIcon: X,
        active: ttsBusy,
        run: toggleTts
      },
      {
        id: 'delete',
        label: copy.actions.delete,
        icon: Trash2,
        danger: true,
        run: () =>
          confirmStore.show({
            ...copy.confirm.deleteMessage,
            danger: true,
            onConfirm: () => appStore.deleteMessage(ctx.message.id)
          })
      }
    ])
  );

  // TTS writes duration back onto the message once generation finishes.
  $effect(() => {
    const id = ctx.message.id;
    const handler = (msgId: string, duration: number) => {
      if (msgId !== id || ctx.message.ttsAudio) return;
      ctx.message.ttsAudio = {
        duration,
        voice: appStore.config.tts?.voice || 'af_heart',
        generatedAt: Date.now()
      };
      appStore.persist();
    };
    ttsStore.onAudioComplete = handler;
    return () => {
      if (ttsStore.onAudioComplete === handler) ttsStore.onAudioComplete = null;
    };
  });
</script>

<div class="flex w-full max-w-full items-start gap-2">
  {#if speaker && !separateSpeakers && presentation?.showAvatars !== false}
    <span class="speaker-avatar" title={speaker.name}>
      <Avatar size="fill" name={speaker.name ?? ''} image={'avatar' in speaker && typeof speaker.avatar === 'string' ? speaker.avatar : undefined} />
    </span>
  {/if}
  <div class="min-w-0 flex-1">
    {#if ctx.message.storyTurn}
      <div class="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        <span class="h-1 w-1 shrink-0 rounded-full bg-current opacity-60" aria-hidden="true"></span>
        <span class="min-w-0 truncate">{ctx.message.storyTurn.label}</span>
      </div>
    {/if}
    {#if speaker && !separateSpeakers}
      <div class="speaker-name">{speaker.name}</div>
    {/if}
    {#if decision}
      <div class="decision" title={$t('roleplay.decisionHint')}>
        <Dices class="size-3 shrink-0" />
        <span>{decision}</span>
      </div>
    {/if}
    {#if roleplayFailed}
      <div class="rp-error" role="alert" data-roleplay-error>
        <AlertTriangle class="size-3.5 shrink-0" />
        <span class="min-w-0 flex-1 truncate">{copy.thread.generationFailed}{ctx.message.metadata?.errorMessage ? ` · ${ctx.message.metadata.errorMessage}` : ''}</span>
        <Button variant="outline" size="xs" type="button" disabled={retryBusy} onclick={() => appStore.regenerateMessage(ctx.message.id)}>
          <RefreshCcw class="size-3" />
          <span>{copy.actions.retry}</span>
        </Button>
      </div>
    {:else}
      <div data-chat-message-content data-chat-message-id={ctx.message.id}>
        <MessageParts />
      </div>
    {/if}

    {#each handedProps as prop, index (index)}
      <PropCard {prop} messageId={ctx.message.id} />
    {/each}

    {#if greetingCharacter && greetingCount > 1}
      <SwipePager
        label={$t('roleplay.swipe.greeting')}
        wrap
        count={greetingCount}
        index={chat?.greetingIndex ?? 0}
        onchange={(index) => roleplayStore.setGreeting(greetingCharacter, index)}
      />
    {:else if swipeable}
      <SwipePager
        label={$t('roleplay.swipe.label')}
        count={ctx.versionCount}
        index={ctx.activeVersionIndex}
        disabled={appStore.currentChatGenerating || appStore.currentChatBlockedByOtherLocalRun}
        onchange={(index) => appStore.setMessageActiveVersion(ctx.message.id, index > ctx.activeVersionIndex ? 1 : -1)}
        oncreate={() => void appStore.regenerateMessage(ctx.message.id)}
      />
    {/if}

    {#if adventureChoices.length && !choicesDismissed && !roleplayFailed}
      <ChoicePanel
        choices={adventureChoices}
        disabled={appStore.currentChatGenerating}
        timerSeconds={snapshot?.settings.choiceTimerSeconds ?? roleplayStore.settings(chat ?? null).choiceTimerSeconds ?? null}
        onpick={(choice) => void roleplayStore.sendChoice(choice)}
        onexpire={() => void roleplayStore.expireChoice()}
        ondismiss={() => (choicesDismissed = true)}
      />
    {/if}

    {#if diffStats.length}
      <FileChangesCard stats={diffStats} />
    {/if}

    {#if !roleplayFailed}<MessageFooter />{/if}

    {#if recall}
      <RecallLine {recall} />
    {/if}

    {#if showTtsPlayer && !separateSpeakers}
      <div class="mt-2"><TtsAudioPlayer message={ctx.message} /></div>
    {/if}

    {#if !hasActiveDeepResearch && !ctx.isStreaming}
      <MessageActionBar {actions} visible={hovering || ctx.actionsPinned} {onmenutoggle}>
        {#snippet menuHeader()}
          {#if ctx.versionCount > 1 && !swipeable}
            <BranchPicker />
          {/if}
        {/snippet}
      </MessageActionBar>
    {/if}

    {#if promptOpen}
      <PromptInspectorModal messageId={ctx.message.id} onclose={() => (promptOpen = false)} />
    {/if}
  </div>
</div>

<style>
  /* Chat-app layout: the avatar sits beside the reply, at the top. */
  .speaker-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    margin-top: 0.125rem;
    overflow: hidden;
    flex-shrink: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--muted);
    color: var(--text-muted);
    font-size: var(--text-xs);
    font-weight: 600;
  }


  .rp-error {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0.625rem;
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--error) 5%, transparent);
    color: var(--text-secondary);
    font-size: var(--text-sm);
  }

  .rp-error :global(svg) {
    color: var(--error);
  }

  .decision {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    margin: 0 0 0.35rem 0.625rem;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }

  .speaker-name {
    margin-bottom: 0.25rem;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.01em;
  }
</style>
