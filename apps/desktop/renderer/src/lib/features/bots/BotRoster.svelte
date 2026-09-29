<svelte:options runes={true} />

<!--
  The roster: who is working right now, then every bot. One row per bot,
  in the sidebar's 13px rhythm.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { Plus, Search } from 'lucide-svelte';
  import BotAvatar from './BotAvatar.svelte';
  import { botsStore } from './bots.svelte';
  import type { Bot } from './bots-ipc';

  let { oncreate }: { oncreate: () => void } = $props();

  let query = $state('');

  const matches = $derived(
    botsStore.bots.filter((bot) => {
      const needle = query.trim().toLowerCase();
      return !needle || bot.title.toLowerCase().includes(needle) || bot.handle.includes(needle) || bot.role.toLowerCase().includes(needle);
    })
  );
  const working = $derived(matches.filter((bot) => bot.working));
</script>

{#snippet row(bot: Bot)}
  <button
    type="button"
    class="bot-row"
    class:is-current={botsStore.selected === bot.handle}
    aria-current={botsStore.selected === bot.handle ? 'true' : undefined}
    onclick={() => void botsStore.select(bot.handle)}
  >
    <BotAvatar {bot} />
    <span class="min-w-0 flex-1 text-left">
      <span class="block truncate text-[13px] font-medium text-foreground">{bot.title}</span>
      <span class="block truncate text-[11.5px] text-muted-foreground">
        {bot.working ? $t('bots.working') : bot.role || `@${bot.handle}`}
      </span>
    </span>
  </button>
{/snippet}

<aside class="flex w-60 shrink-0 flex-col border-r border-[var(--border-subtle)]" aria-label={$t('bots.roster')}>
  <div class="flex items-center gap-2 px-3 pb-2 pt-3">
    <label class="search">
      <Search class="size-3.5 shrink-0 text-muted-foreground" />
      <input bind:value={query} placeholder={$t('bots.search')} aria-label={$t('bots.search')} />
    </label>
    <button type="button" class="new-btn" onclick={oncreate} title={$t('bots.new')} aria-label={$t('bots.new')}>
      <Plus class="size-4" />
    </button>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
    {#if working.length}
      <p class="section">{$t('bots.activeNow')}</p>
      {#each working as bot (bot.handle)}{@render row(bot)}{/each}
    {/if}
    <p class="section">{$t('bots.all')}</p>
    {#each matches as bot (bot.handle)}{@render row(bot)}{/each}
    {#if botsStore.loaded && !matches.length}
      <p class="px-2 py-3 text-[12px] text-muted-foreground">{$t('bots.noMatch')}</p>
    {/if}
  </div>
</aside>

<style>
  .search {
    display: flex;
    min-width: 0;
    flex: 1;
    align-items: center;
    gap: 0.4rem;
    border-radius: 9999px;
    border: 1px solid var(--border-subtle);
    padding: 0.3rem 0.65rem;
  }
  .search input {
    min-width: 0;
    flex: 1;
    background: transparent;
    font-size: 12.5px;
    outline: none;
  }
  .new-btn {
    display: inline-flex;
    height: 1.9rem;
    width: 1.9rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    color: var(--muted-foreground);
  }
  .new-btn:hover { background: var(--surface-hover); color: var(--foreground); }
  .section {
    padding: 0.75rem 0.5rem 0.3rem;
    font-size: 11px;
    color: var(--muted-foreground);
  }
  .bot-row {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.6rem;
    border-radius: 0.6rem;
    padding: 0.4rem 0.5rem;
  }
  .bot-row:hover { background: var(--surface-hover); }
  .bot-row.is-current { background: var(--surface-active); }
</style>
