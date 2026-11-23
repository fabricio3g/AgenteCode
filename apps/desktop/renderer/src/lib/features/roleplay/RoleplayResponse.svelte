<svelte:options runes={true} />

<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import Avatar from '$lib/components/ui/Avatar.svelte';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { charactersStore } from './characters.svelte';
  import { roleplayStore } from './roleplay.svelte';
  import { characterBubbles, voiceConfig } from './roleplay-voice';
  import { ttsStore } from '$lib/stores/tts.svelte';
  import { Square, Volume2 } from '$lib/icons';
  import { t } from 'svelte-i18n';
  import { stripSpeakerPrefix } from './roleplay-output';
  import type { ChatMessage, RoleplayTurnSnapshot } from '$lib/types/chat';

  let { content, status, snapshot, speakerId, messageId }: {
    messageId?: string;
    content: string;
    status?: ChatMessage['status'];
    snapshot?: RoleplayTurnSnapshot;
    speakerId?: string | null;
  } = $props();

  const settings = $derived(roleplayStore.settings(appStore.currentChat));
  const cast = $derived.by(() => {
    const ids = snapshot?.settings.characterIds ?? appStore.currentChat?.roleplay?.characterIds
      ?? (appStore.currentChat?.characterId ? [appStore.currentChat.characterId] : []);
    const cards = ids.flatMap((id) => {
      const card = charactersStore.getById(id);
      return card ? [card] : [];
    });
    const npcs = snapshot?.sceneAfter.npcs ?? roleplayStore.room().npcs;
    return [...cards.map((card) => ({ id: card.id, name: card.name, avatar: card.avatar, voice: card.voice ?? (card.voiceId ? { voice: card.voiceId } : undefined), aliases: [card.nickname, ...(card.aliases ?? [])].filter((name): name is string => !!name) })),
      ...npcs.map((npc) => ({ id: npc.id, name: npc.name, avatar: undefined, voice: undefined, aliases: [] as string[] }))];
  });
  const mentionNames = $derived([...cast.flatMap((card) => [card.name, ...card.aliases]), snapshot?.persona?.name ?? ''].filter(Boolean));
  /** A per-bubble voice once the reply is done and voices are on. */
  const canSpeak = $derived(!!messageId && status !== 'streaming' && !!appStore.config.tts?.enable_voice_output && settings.voicePlayback !== false);
  const parts = $derived(characterBubbles(content, new Map(cast.map((card) => [card.id, card.name])), speakerId ?? null));
</script>

<!--
  One roleplay turn: narration as quiet italic prose between the bubbles, and
  one bubble per character (avatar and name on one line, then what they said).
  Hovering a bubble offers its own voice; the turn's Listen action reads them
  all in order.
-->
<div class="rp-turn">
  {#each parts as part, index (index)}
    {@const character = cast.find((card) => card.id === part.speakerId)}
    {@const spoken = character ? stripSpeakerPrefix(part.content, [character.name, ...character.aliases]) : part.content}
    {@const audioId = `${messageId}:voice:${part.speakerId ?? `narrator-${index}`}`}
    {#if part.speakerId === null}
      <div class="narration" aria-label={$t('roleplay.narration')} data-roleplay-narration>
        <RichContent content={part.content} {status} {mentionNames} />
      </div>
    {:else}
      <div class="bubble" data-roleplay-speaker={part.speakerId}>
        {#if character}
          <div class="bubble-head">
            {#if settings.showAvatars !== false}
              <span class="bubble-avatar"><Avatar size="fill" name={character.name} image={character.avatar} /></span>
            {/if}
            <span class="bubble-name">{character.name}</span>
            {#if canSpeak}
              <UiButton variant="plain"
                type="button"
                class={uiClass("bubble-play", "ui-local-b904d26d", {"is-on": ttsStore.isSpeaking(audioId)})}

                aria-label={ttsStore.isSpeaking(audioId) ? $t('roleplay.voice.stop') : $t('roleplay.voice.play', { values: { name: character.name } })}
                title={ttsStore.isSpeaking(audioId) ? $t('roleplay.voice.stop') : $t('roleplay.voice.play', { values: { name: character.name } })}
                onclick={() => (ttsStore.isSpeaking(audioId) ? ttsStore.stop() : void ttsStore.speak(audioId, spoken, voiceConfig(appStore.config, character.voice)))}
              >
                {#if ttsStore.isSpeaking(audioId)}<Square class="size-2.5" />{:else}<Volume2 class="size-3" />{/if}
              </UiButton>
            {/if}
          </div>
        {/if}
        <RichContent content={spoken} {status} {mentionNames} />
      </div>
    {/if}
  {/each}
</div>

<style>
  .rp-turn {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }

  .narration {
    padding: 0 0.625rem;
    color: var(--text-secondary);
    font-style: italic;
  }

  .narration :global(.markdown-body) {
    color: inherit;
  }

  .bubble {
    min-width: 0;
    padding: 0.5rem 0.625rem;
    border-radius: var(--bubble-radius);
    background: color-mix(in srgb, var(--foreground) 3.5%, transparent);
  }

  .bubble-head {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.2rem;
  }

  .bubble-avatar {
    display: block;
    width: 1.5rem;
    height: 1.5rem;
    flex-shrink: 0;
    overflow: hidden;
    border-radius: var(--radius-full);
    background: var(--muted);
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
  }

  .bubble-name {
    min-width: 0;
    overflow: hidden;
    color: var(--text-secondary);
    font-size: var(--text-xs);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.bubble-play.ui-local-b904d26d) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    margin-left: auto;
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    opacity: 0;
    transition: opacity var(--motion-fast), background-color var(--motion-fast), color var(--motion-fast);
  }

  .bubble:hover :global(.bubble-play.ui-local-b904d26d),
  :global(.bubble-play:focus-visible.ui-local-b904d26d),
  :global(.bubble-play.is-on.ui-local-b904d26d) {
    opacity: 1;
  }

  :global(.bubble-play:hover.ui-local-b904d26d) {
    background: var(--surface-hover);
    color: var(--foreground);
  }
</style>
