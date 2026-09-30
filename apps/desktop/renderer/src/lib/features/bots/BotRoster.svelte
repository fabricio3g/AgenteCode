<svelte:options runes={true} />

<!--
  The roster, in the app sidebar when the Bots tab is open: who is working
  right now, then every bot. One row per bot, in the sidebar's 13px rhythm.
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Bot as BotIcon } from 'lucide-svelte';
  import BotAvatar from './BotAvatar.svelte';
  import { botsStore } from './bots.svelte';
  import type { Bot } from './bots-ipc';

  const working = $derived(botsStore.matches.filter((bot) => bot.working));

  onMount(() => {
    if (!botsStore.loaded) void botsStore.load();
  });
</script>

{#snippet row(bot: Bot)}
  <button
    type="button"
    class="bot-row"
    class:is-current={botsStore.selected === bot.handle}
    aria-current={botsStore.selected === bot.handle ? 'true' : undefined}
    title={bot.role || `@${bot.handle}`}
    onclick={() => void botsStore.select(bot.handle)}
  >
    <BotAvatar {bot} size="sm" />
    <span class="bot-name">{bot.title}</span>
    {#if bot.working}<span class="working-dot" aria-label={$t('bots.working')}></span>{/if}
  </button>
{/snippet}

<nav aria-label={$t('bots.roster')}>
  {#if working.length}
    <p class="section">{$t('bots.activeNow')}</p>
    <div class="space-y-0.5">{#each working as bot (bot.handle)}{@render row(bot)}{/each}</div>
  {/if}
  {#if botsStore.matches.length}
    <p class="section">{$t('bots.all')}</p>
    <div class="space-y-0.5">{#each botsStore.matches as bot (bot.handle)}{@render row(bot)}{/each}</div>
  {:else if botsStore.loaded}
    <div class="empty">
      <BotIcon class="size-4" />
      <p>{botsStore.query.trim() ? $t('bots.noMatch') : $t('bots.none')}</p>
    </div>
  {/if}
</nav>

<style>
  .section {
    padding: 0.75rem 0.5rem 0.25rem;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
  }

  .bot-row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.5rem;
    border-radius: var(--radius-full);
    padding: 0.25rem 0.5rem 0.25rem 0.3rem;
    color: var(--text-secondary);
    font-size: 13px;
    text-align: left;
  }

  .bot-row:hover {
    background: var(--sidebar-accent);
    color: var(--sidebar-foreground);
  }

  .bot-row.is-current {
    background: var(--sidebar-accent);
    color: var(--sidebar-foreground);
    font-weight: 500;
  }

  .bot-name {
    min-width: 0;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .working-dot {
    width: 0.375rem;
    height: 0.375rem;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--success);
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 2.5rem 0.5rem;
    color: var(--text-muted);
    font-size: 12.5px;
    text-align: center;
  }
</style>
