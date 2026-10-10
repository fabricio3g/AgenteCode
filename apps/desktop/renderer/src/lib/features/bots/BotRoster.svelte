<svelte:options runes={true} />

<!--
  The roster, in the app sidebar when the Bots tab is open: who is working
  right now, then every bot. One row per bot, in the sidebar's shared row
  recipe (app.css `.sidebar-row`) — no scoped row styles left.
-->

<script lang="ts">
  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import { cn as uiClass } from '$lib/utils/cn';

  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Bot as BotIcon } from 'lucide-svelte';
  import BotAvatar from './BotAvatar.svelte';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';
  import { botsStore } from './bots.svelte';
  import type { Bot } from './bots-ipc';

  const working = $derived(botsStore.matches.filter((bot) => bot.working));

  onMount(() => {
    if (!botsStore.loaded) void botsStore.load();
  });
</script>

{#snippet row(bot: Bot)}
  <UiListRow
    type="button"
    class={uiClass("sidebar-row", {"is-current": botsStore.selected === bot.handle})}

    aria-current={botsStore.selected === bot.handle ? 'true' : undefined}
    title={bot.role || `@${bot.handle}`}
    onclick={() => void botsStore.select(bot.handle)}
  >
    <BotAvatar {bot} size="sm" />
    <span class="sidebar-row-label">{bot.title}</span>
    {#if bot.working}<StatusDot tone="active" label={$t('bots.working')} />{/if}
  </UiListRow>
{/snippet}

<nav aria-label={$t('bots.roster')}>
  {#if working.length}
    <p class="sidebar-section">{$t('bots.activeNow')}</p>
    <div class="space-y-0.5">{#each working as bot (bot.handle)}{@render row(bot)}{/each}</div>
  {/if}
  {#if botsStore.matches.length}
    <p class="sidebar-section">{$t('bots.all')}</p>
    <div class="space-y-0.5">{#each botsStore.matches as bot (bot.handle)}{@render row(bot)}{/each}</div>
  {:else if botsStore.loaded}
    <div class="sidebar-empty">
      <div class="sidebar-empty-icon"><BotIcon class="size-4" /></div>
      <p>{botsStore.query.trim() ? $t('bots.noMatch') : $t('bots.none')}</p>
    </div>
  {/if}
</nav>
