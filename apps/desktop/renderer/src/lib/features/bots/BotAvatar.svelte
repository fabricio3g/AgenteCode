<svelte:options runes={true} />

<!--
  A bot's face: its animated drawing (BotFace), in the family of the tint the
  person picked and in the mood its live events put it in. A bot with a
  picture shows the picture, with a quiet ring while it works.
-->

<script lang="ts">
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import BotFace from './BotFace.svelte';
  import { botsStore } from './bots.svelte';
  import type { Bot } from './bots-ipc';

  let {
    bot,
    size = 'md'
  }: {
    /** A saved bot has a handle; the editor's preview of a new one does not. */
    bot: Pick<Bot, 'title' | 'avatar' | 'working'> & { handle?: string };
    size?: 'sm' | 'md' | 'lg' | 'xl';
  } = $props();

  /** The same boxes the initials avatar used, plus a hero size. */
  const PIXELS = { sm: 24, md: 32, lg: 40, xl: 72 } as const;
  // The stored seed draws the face; bots made before seeds use their handle.
  const faceKey = $derived(bot.avatar?.seed != null ? `seed:${bot.avatar.seed}` : bot.handle || bot.title);
  const live = $derived(bot.handle ? botsStore.moodOf(bot.handle) : null);
  // A bot that works without a turn this window saw (a routine) still looks busy.
  const faceState = $derived(live && live.state !== 'idle' ? live.state : bot.working ? 'working' : 'idle');
</script>

{#if bot.avatar?.image}
  <Avatar name={bot.title} image={bot.avatar.image} working={bot.working} size={size === 'xl' ? 'lg' : size} />
{:else}
  <BotFace {faceKey} tint={bot.avatar?.tint ?? 'blue'} size={PIXELS[size]} mood={faceState} cue={live?.cue ?? null} />
{/if}
