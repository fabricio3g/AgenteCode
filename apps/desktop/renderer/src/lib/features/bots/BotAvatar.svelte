<svelte:options runes={true} />

<!--
  A bot's face: the shared Avatar with the bot's initials, tint and a quiet
  ring while it works.
-->

<script lang="ts">
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import type { Bot } from './bots-ipc';

  let { bot, size = 'md' }: { bot: Pick<Bot, 'title' | 'avatar' | 'working'>; size?: 'sm' | 'md' | 'lg' } = $props();
</script>

<Avatar name={bot.title} image={bot.avatar?.image} initials={bot.avatar?.initials} tint={bot.avatar?.tint ?? 'blue'} working={bot.working} {size} />
