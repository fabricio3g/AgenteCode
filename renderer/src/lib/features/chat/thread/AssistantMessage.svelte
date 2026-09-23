<svelte:options runes={true} />

<script lang="ts">
  import { Copy, FileSearch, Pencil, RefreshCcw, Trash2, Volume2, X } from 'lucide-svelte';
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
  import GreetingPager from '$lib/features/roleplay/GreetingPager.svelte';
  import ChoicePanel from '$lib/features/roleplay/ChoicePanel.svelte';
  import PropCard from '$lib/features/roleplay/PropCard.svelte';
  import PromptInspectorModal from '$lib/features/roleplay/PromptInspectorModal.svelte';
  import TtsAudioPlayer from '$lib/features/chat/TtsAudioPlayer.svelte';
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
  const speaker = $derived(charactersStore.getById(ctx.message.speakerId));

  /**
   * The greeting is the first turn of a roleplay chat. It gets the ‹ 1 / 3 ›
   * pager below its bubble so the opening can be flipped in place.
   */
  const chat = $derived(appStore.currentChat);
  const isGreetingMessage = $derived(
    chat?.contextMode === 'roleplay' && chat.messages?.[0]?.id === ctx.message.id
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
    const choices = ctx.message.choices || [];
    if (!choices.length || chat?.contextMode !== 'roleplay' || ctx.isStreaming) return [];
    const last = chat.messages?.[chat.messages.length - 1];
    return last?.id === ctx.message.id ? choices : [];
  });
  /** Props the turn put in the user's hands — roleplay's own artifacts. */
  // Not called `props`: Svelte would read `$props` in this scope as a store
  // subscription to it and the component would not compile.
  const handedProps = $derived(chat?.contextMode === 'roleplay' ? ctx.message.props || [] : []);
  /** Hiding the panel is per message; it must never turn the feature off. */
  let choicesDismissed = $state(false);
  const hasActiveDeepResearch = $derived(
    !!deepResearchStore.getActiveTaskForMessage(ctx.message.id)
  );

  const ttsEnabled = $derived(!!appStore.config.tts?.enable_voice_output);
  const ttsBusy = $derived(
    ttsStore.currentMessageId === ctx.message.id && (ttsStore.isGenerating || ttsStore.playing)
  );
  const hasTtsAudio = $derived(ttsStore.hasStoredAudio(ctx.message.id) || !!ctx.message.ttsAudio);
  const showTtsPlayer = $derived(
    ttsEnabled && !ctx.isStreaming && (hasTtsAudio || (ttsStore.playing && ttsStore.currentMessageId === ctx.message.id))
  );

  // Charts render as their own blocks, so the copyable text is the prose only.
  const copyableText = $derived(stripChartBlocks(ctx.displayContent) || ctx.message.content || '');

  function toggleTts() {
    if (ttsBusy) {
      ttsStore.stop();
      return;
    }
    const text = ctx.displayContent;
    if (!text.trim()) return;
    ttsStore.speak(ctx.message.id, text, appStore.config);
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
      // Roleplay: show the composed prompt, lore and token estimate.
      chat?.contextMode === 'roleplay' && {
        id: 'prompt',
        label: 'Prompt',
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
  {#if speaker}
    <span class="speaker-avatar" title={speaker.name}>
      {#if speaker.avatar}
        <img src={speaker.avatar} alt={speaker.name} />
      {:else}
        <span>{speaker.name?.trim()?.[0]?.toUpperCase() || '?'}</span>
      {/if}
    </span>
  {/if}
  <div class="min-w-0 flex-1">
    {#if ctx.message.storyTurn}
      <div class="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <span class="h-1 w-1 shrink-0 rounded-full bg-current opacity-60" aria-hidden="true"></span>
        <span class="min-w-0 truncate">{ctx.message.storyTurn.label}</span>
      </div>
    {/if}
    {#if speaker}
      <div class="speaker-name">{speaker.name}</div>
    {/if}
    <div data-chat-message-content data-chat-message-id={ctx.message.id}>
      <MessageParts />
    </div>

    {#each handedProps as prop, index (index)}
      <PropCard {prop} messageId={ctx.message.id} />
    {/each}

    {#if greetingCharacter && greetingCount > 1}
      <GreetingPager
        count={greetingCount}
        index={chat?.greetingIndex ?? 0}
        onchange={(index) => roleplayStore.setGreeting(greetingCharacter, index)}
      />
    {/if}

    {#if adventureChoices.length && !choicesDismissed}
      <ChoicePanel
        choices={adventureChoices}
        disabled={appStore.currentChatGenerating}
        timerSeconds={chat?.roleplay?.choiceTimerSeconds ?? null}
        onpick={(choice) => void roleplayStore.sendChoice(choice)}
        onexpire={() => void roleplayStore.expireChoice()}
        ondismiss={() => (choicesDismissed = true)}
      />
    {/if}

    {#if diffStats.length}
      <FileChangesCard stats={diffStats} />
    {/if}

    <MessageFooter />

    {#if showTtsPlayer}
      <div class="mt-1"><TtsAudioPlayer message={ctx.message} /></div>
    {/if}

    {#if !hasActiveDeepResearch && !ctx.isStreaming}
      <MessageActionBar {actions} visible={hovering || ctx.actionsPinned} {onmenutoggle}>
        {#snippet menuHeader()}
          {#if ctx.versionCount > 1}
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
    font-size: 0.75rem;
    font-weight: 600;
  }

  .speaker-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .speaker-name {
    margin-bottom: 0.25rem;
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
</style>
