<svelte:options runes={true} />

<!--
  A bot's one conversation. Each turn shows who asked (you, a routine, or a
  teammate handing work over) and the bot's work, rendered with the Code
  section's step rows. `/new` shortens the conversation instead of starting
  another: the bot keeps what matters in its memory.
-->

<script lang="ts">
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { AlertCircle, ArrowUp, CalendarClock, Eraser, Pencil, Square, Users } from 'lucide-svelte';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import CodeStepRow from '$lib/features/code/CodeStepRow.svelte';
  import { orderedEntries } from '$lib/features/code/code-run';
  import BotAvatar from './BotAvatar.svelte';
  import { botsStore, type BotTurnView } from './bots.svelte';
  import type { Bot } from './bots-ipc';

  let {
    bot,
    onedit,
    routinesOpen,
    ontoggleroutines
  }: { bot: Bot; onedit: () => void; routinesOpen: boolean; ontoggleroutines: () => void } = $props();

  let draft = $state('');
  let viewport = $state<HTMLDivElement | undefined>(undefined);
  let pinned = $state(true);

  const turns = $derived(botsStore.turnsFor(bot.handle));

  $effect(() => {
    void turns.length;
    void turns[turns.length - 1]?.run.content;
    void turns[turns.length - 1]?.run.steps.length;
    if (pinned) void tick().then(() => viewport && (viewport.scrollTop = viewport.scrollHeight));
  });

  function onScroll() {
    if (viewport) pinned = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
  }

  function entries(turn: BotTurnView) {
    return orderedEntries({ agentSteps: turn.run.steps, content: turn.run.content, metadata: { codeTimeline: turn.run.timeline } });
  }

  function send() {
    const text = draft.trim();
    if (!text || bot.working) return;
    draft = '';
    pinned = true;
    if (text === '/new') void botsStore.compact(bot.handle);
    else void botsStore.send(text);
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  }
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={bot.title}>
  <header class="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--border-subtle)] px-4">
    <BotAvatar {bot} />
    <div class="min-w-0 flex-1">
      <p class="truncate text-[13px] font-medium text-foreground">{bot.title}</p>
      <p class="truncate text-[11.5px] text-muted-foreground">@{bot.handle}{bot.role ? ` · ${bot.role}` : ''}</p>
    </div>
    <button type="button" class="head-btn" onclick={() => void botsStore.compact(bot.handle)} title={$t('bots.compactHint')} aria-label={$t('bots.compact')} disabled={bot.working || !turns.length}>
      <Eraser class="size-4" />
    </button>
    <button type="button" class="head-btn" onclick={onedit} title={$t('bots.edit')} aria-label={$t('bots.edit')}>
      <Pencil class="size-4" />
    </button>
    <button type="button" class="head-btn" class:on={routinesOpen} onclick={ontoggleroutines} title={$t('bots.routines')} aria-label={$t('bots.routines')} aria-pressed={routinesOpen}>
      <CalendarClock class="size-4" />
    </button>
  </header>

  <div bind:this={viewport} class="min-h-0 flex-1 overflow-y-auto px-4 py-6" onscroll={onScroll}>
    <div class="mx-auto flex max-w-3xl flex-col gap-5">
      {#if !turns.length}
        <div class="empty">
          <BotAvatar {bot} size="lg" />
          <p class="text-[13px] font-medium text-foreground">{$t('bots.emptyTitle', { values: { name: bot.title } })}</p>
          <p class="max-w-sm text-center text-[12.5px] text-muted-foreground">{$t('bots.emptyHint')}</p>
        </div>
      {/if}

      {#each turns as turn (turn.key)}
        {#if turn.source.kind === 'user' && turn.prompt}
          <div class="flex justify-end">
            <div class="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm border border-border bg-muted px-4 py-2.5 text-sm leading-relaxed text-foreground">{turn.prompt}</div>
          </div>
        {:else if turn.source.kind === 'routine'}
          <div class="source"><CalendarClock class="size-3.5" /> {$t('bots.fromRoutine', { values: { title: turn.source.title } })}</div>
          {#if turn.prompt}<p class="quoted">{turn.prompt}</p>{/if}
        {:else if turn.source.kind === 'handoff'}
          <div class="source"><Users class="size-3.5" /> {$t('bots.fromBot', { values: { handle: turn.source.from } })}</div>
          {#if turn.prompt}<p class="quoted">{turn.prompt}</p>{/if}
        {/if}

        <div class="flex flex-col gap-3">
          {#each entries(turn) as entry (entry.key)}
            {#if entry.step}
              <div class="-mx-2"><CodeStepRow step={entry.step} /></div>
            {:else if entry.text}
              <div class="text-sm leading-relaxed text-foreground"><RichContent content={entry.text} /></div>
            {/if}
          {/each}
          {#if !turn.run.done && !turn.run.content && !turn.run.steps.length}
            <span class="text-xs text-muted-foreground">{$t('bots.working')}</span>
          {/if}
          {#if turn.run.error}
            <div class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              <AlertCircle class="mt-0.5 size-3.5 shrink-0" />
              <span class="min-w-0 break-words">{turn.run.error}</span>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>

  <div class="shrink-0 px-4 pb-4">
    <div class="composer mx-auto max-w-3xl">
      <textarea
        bind:value={draft}
        rows="1"
        placeholder={$t('bots.placeholder', { values: { name: bot.title } })}
        aria-label={$t('bots.placeholder', { values: { name: bot.title } })}
        onkeydown={onKeydown}
      ></textarea>
      {#if bot.working}
        <button type="button" class="send" onclick={() => botsStore.stop(bot.handle)} title={$t('bots.stop')} aria-label={$t('bots.stop')}>
          <Square class="size-3.5" />
        </button>
      {:else}
        <button type="button" class="send" onclick={send} disabled={!draft.trim()} title={$t('bots.send')} aria-label={$t('bots.send')}>
          <ArrowUp class="size-4" />
        </button>
      {/if}
    </div>
  </div>
</section>

<style>
  .head-btn {
    display: inline-flex;
    height: 2rem;
    width: 2rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    color: var(--muted-foreground);
  }
  .head-btn:hover:not(:disabled), .head-btn.on { background: var(--surface-hover); color: var(--foreground); }
  .head-btn:disabled { opacity: 0.45; }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.6rem;
    padding: 4rem 0 2rem;
  }
  .source {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 11.5px;
    color: var(--muted-foreground);
  }
  .quoted {
    margin-top: -0.6rem;
    border-left: 2px solid var(--border);
    padding-left: 0.75rem;
    font-size: 13px;
    color: var(--muted-foreground);
    white-space: pre-wrap;
  }
  .composer {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
    border-radius: 1.25rem;
    border: 1px solid var(--border);
    background: var(--card);
    padding: 0.5rem 0.5rem 0.5rem 1rem;
    box-shadow: var(--surface-shadow);
  }
  .composer textarea {
    max-height: 12rem;
    min-height: 1.75rem;
    flex: 1;
    resize: none;
    field-sizing: content;
    background: transparent;
    padding: 0.25rem 0;
    font-size: 14px;
    outline: none;
  }
  .send {
    display: inline-flex;
    height: 2rem;
    width: 2rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    background: var(--foreground);
    color: var(--background);
  }
  .send:disabled { opacity: 0.3; }
</style>
