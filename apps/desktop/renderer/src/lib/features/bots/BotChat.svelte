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
  import { AlertCircle, ArrowUp, CalendarClock, Eraser, Pencil, Users } from 'lucide-svelte';
  import RichContent from '$lib/ui/components/RichContent.svelte';
  import CodeStepRow from '$lib/features/code/CodeStepRow.svelte';
  import { orderedEntries } from '$lib/features/code/code-run';
  import BotAvatar from './BotAvatar.svelte';
  import SendButton from '$lib/features/shared/composer/SendButton.svelte';
  import { botsStore, type BotTurnView } from './bots.svelte';
  import type { Bot } from './bots-ipc';
  import { insertMention, matchBots, mentionAt, type Mention } from './mention';

  let {
    bot,
    onedit,
    routinesOpen,
    ontoggleroutines
  }: { bot: Bot; onedit: () => void; routinesOpen: boolean; ontoggleroutines: () => void } = $props();

  let draft = $state('');
  let input = $state<HTMLTextAreaElement | undefined>(undefined);
  // The `@teammate` being typed, and which suggestion is highlighted.
  let mention = $state<Mention | null>(null);
  let highlighted = $state(0);
  const suggestions = $derived(mention ? matchBots(botsStore.bots, mention.query, bot.handle) : []);
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

  function trackMention() {
    const next = input ? mentionAt(draft, input.selectionStart ?? draft.length) : null;
    if (next?.query !== mention?.query || next?.start !== mention?.start) highlighted = 0;
    mention = next;
  }

  function pick(handle: string) {
    if (!mention || !input) return;
    const next = insertMention(draft, input.selectionStart ?? draft.length, mention, handle);
    draft = next.text;
    mention = null;
    void tick().then(() => {
      input?.focus();
      input?.setSelectionRange(next.caret, next.caret);
    });
  }

  /** Arrow keys, Enter/Tab and Escape drive the suggestions while they show. */
  function onMentionKey(event: KeyboardEvent): boolean {
    if (!suggestions.length) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      highlighted = (highlighted + step + suggestions.length) % suggestions.length;
    } else if ((event.key === 'Enter' || event.key === 'Tab') && !event.isComposing) {
      pick(suggestions[highlighted].handle);
    } else if (event.key === 'Escape') {
      mention = null;
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  }

  function onKeydown(event: KeyboardEvent) {
    if (onMentionKey(event)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  }
</script>

<section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label={bot.title}>
  <header class="flex h-12 shrink-0 items-center gap-2.5 px-4">
    <BotAvatar {bot} size="sm" />
    <div class="min-w-0 flex-1">
      <p class="truncate text-[13px] font-medium text-foreground">{bot.title}</p>
      <p class="truncate text-[11.5px] text-muted-foreground">@{bot.handle}{bot.role ? ` · ${bot.role}` : ''}{bot.model ? ` · ${bot.model.model}` : ''}</p>
    </div>
    <button type="button" class="ui-icon-button head-btn" onclick={() => void botsStore.compact(bot.handle)} title={$t('bots.compactHint')} aria-label={$t('bots.compact')} disabled={bot.working || !turns.length}>
      <Eraser class="size-4" />
    </button>
    <button type="button" class="ui-icon-button head-btn" onclick={onedit} title={$t('bots.edit')} aria-label={$t('bots.edit')}>
      <Pencil class="size-4" />
    </button>
    <button type="button" class="ui-icon-button head-btn" class:on={routinesOpen} onclick={ontoggleroutines} title={$t('bots.routines')} aria-label={$t('bots.routines')} aria-pressed={routinesOpen}>
      <CalendarClock class="size-4" />
    </button>
  </header>

  <div class="ui-top-fade flex min-h-0 min-w-0 flex-1 flex-col">
    <div bind:this={viewport} class="min-h-0 flex-1 overflow-y-auto px-4 py-6" onscroll={onScroll}>
      <div class="mx-auto flex max-w-3xl flex-col gap-5">
        {#if !turns.length}
          <div class="empty">
            <BotAvatar {bot} size="xl" />
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
  </div>

  <div class="shrink-0 px-4 pb-4">
    <div class="relative mx-auto max-w-3xl">
      {#if suggestions.length}
        <ul class="mentions" role="listbox" id="bot-mentions" aria-label={$t('bots.mentionLabel')}>
          {#each suggestions as option, index (option.handle)}
            <li role="option" aria-selected={index === highlighted} id={`bot-mention-${option.handle}`}>
              <button type="button" class="mention" class:on={index === highlighted} onmousedown={(event) => event.preventDefault()} onclick={() => pick(option.handle)} onmouseenter={() => (highlighted = index)}>
                <BotAvatar bot={option} size="sm" />
                <span class="truncate text-[13px] text-foreground">{option.title}</span>
                <span class="truncate text-[12px] text-muted-foreground">@{option.handle}</span>
                {#if option.role}<span class="ml-auto truncate pl-2 text-[11.5px] text-muted-foreground">{option.role}</span>{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      <!-- The same shell and send/stop button as Home and Code. -->
      <div class="composer-shell ui-composer">
        <div class="composer-body">
              <textarea
                class="composer-textarea w-full resize-none bg-transparent text-foreground outline-none"
            bind:this={input}
            bind:value={draft}
            oninput={trackMention}
            onclick={trackMention}
            onblur={() => (mention = null)}
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls="bot-mentions"
            aria-autocomplete="list"
            aria-activedescendant={suggestions.length ? `bot-mention-${suggestions[highlighted]?.handle}` : undefined}
            rows="1"
            placeholder={$t('bots.placeholder', { values: { name: bot.title } })}
            aria-label={$t('bots.placeholder', { values: { name: bot.title } })}
            onkeydown={onKeydown}
          ></textarea>
          <div class="composer-bar">
            <div class="composer-bar-leading">
              <span class="truncate px-1 text-[12px] text-muted-foreground" title={$t('bots.model')}>{bot.model?.model ?? $t('bots.modelSame')}</span>
            </div>
            <div class="composer-bar-trailing">
              <SendButton
                running={bot.working}
                disabled={!draft.trim()}
                sendLabel={$t('bots.send')}
                stopLabel={$t('bots.stop')}
                onsend={send}
                onstop={() => botsStore.stop(bot.handle)}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<style>
  .head-btn.on { background: var(--surface-hover); color: var(--foreground); }
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
  .mentions {
    position: absolute;
    bottom: calc(100% + 0.4rem);
    left: 0;
    right: 0;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 1px;
    border-radius: 0.9rem;
    border: 1px solid var(--border);
    background: var(--popover);
    padding: 0.3rem;
    box-shadow: var(--shadow-lg);
  }
  .mention {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    gap: 0.5rem;
    border-radius: 0.6rem;
    padding: 0.35rem 0.5rem;
    text-align: left;
  }
  .mention.on { background: var(--surface-hover); }
</style>
