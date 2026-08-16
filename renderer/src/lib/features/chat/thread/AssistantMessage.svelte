<svelte:options runes={true} />

<script lang="ts">
  import { Copy, Pencil, RefreshCcw, Trash2, Volume2, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { deepResearchStore } from '$lib/stores/deep-research.svelte';
  import { copy } from '$lib/copy';
  import { stripChartBlocks } from '$lib/utils/charts';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import FileChangesCard from '$lib/components/agent/FileChangesCard.svelte';
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

  const diffStats = $derived(
    ctx.message.agentSteps?.flatMap((step) => step.diffStats || []) || []
  );
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
      {
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
  <div class="min-w-0 flex-1">
    <div data-chat-message-content data-chat-message-id={ctx.message.id}>
      <MessageParts />
    </div>

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
  </div>
</div>
