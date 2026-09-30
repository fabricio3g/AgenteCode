<svelte:options runes={true} />

<script lang="ts">
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { charactersStore } from './characters.svelte';
  import { roleplayStore } from './roleplay.svelte';
  import { characterBubbles, voiceConfig } from './roleplay-voice';
  import TtsAudioPlayer from '$lib/features/chat/TtsAudioPlayer.svelte';
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
  const parts = $derived(characterBubbles(content, new Map(cast.map((card) => [card.id, card.name])), speakerId ?? null));
</script>

<div class="narrative-response">
  {#each parts as part, index (index)}
    {@const character = cast.find((card) => card.id === part.speakerId)}
    {@const spoken = character ? stripSpeakerPrefix(part.content, [character.name, ...character.aliases]) : part.content}
    {@const audioId = `${messageId}:voice:${part.speakerId ?? `narrator-${index}`}`}
    {@const audioConfig = voiceConfig(appStore.config, part.speakerId === null ? appStore.config.tts?.narrator : character?.voice)}
    {#if part.speakerId === null}
      <div class="narrator-passage" aria-label="Narration" data-roleplay-narration>
        <RichContent content={part.content} {status} {mentionNames} />
        {#if messageId && status !== 'streaming' && appStore.config.tts?.enable_voice_output && settings.voicePlayback !== false}
          <TtsAudioPlayer message={{ id: audioId, role: 'assistant', content: spoken, createdAt: 0 }} config={audioConfig} showIdle />
        {/if}
      </div>
    {:else}
      <div class="character-contribution" data-roleplay-speaker={part.speakerId}>
        {#if character && settings.showAvatars !== false}
          <span class="contribution-avatar"><Avatar size="fill" name={character.name} image={character.avatar} /></span>
        {/if}
        <div class="min-w-0 flex-1">
          {#if character}<div class="mb-1 text-xs font-semibold text-[var(--text-secondary)]">{character.name}</div>{/if}
          <RichContent content={spoken} {status} {mentionNames} />
          {#if messageId && status !== 'streaming' && appStore.config.tts?.enable_voice_output && settings.voicePlayback !== false}
            <TtsAudioPlayer message={{ id: audioId, role: 'assistant', content: spoken, createdAt: 0 }} config={audioConfig} showIdle />
          {/if}
        </div>
      </div>
    {/if}
  {/each}
</div>

<style>
  .narrative-response { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
  .narrator-passage { padding: 0.25rem 0.5rem; color: var(--text-secondary); }
  .narrator-passage :global(.markdown-body) { color: inherit; }
  .character-contribution { display: flex; align-items: flex-start; gap: 0.5rem; min-width: 0; padding: 0.625rem 0.75rem; border-radius: var(--radius-xl); background: color-mix(in srgb, var(--foreground) 3%, transparent); }
  .contribution-avatar { display: block; width: 1.75rem; height: 1.75rem; flex-shrink: 0; overflow: hidden; border-radius: var(--radius-full); }
</style>
