<svelte:options runes={true} />

<!--
  Quiet chips above the roleplay composer for steering the scene without
  writing the next turn yourself: let the last reply keep going, draft your
  own next line, keep an author's note, offer choices, throw a twist.
-->

<script lang="ts">
  import { Dices, FastForward, ListOrdered, LoaderCircle, PenLine, StickyNote } from 'lucide-svelte';
  import { slide } from 'svelte/transition';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { roleplayStore } from './roleplay.svelte';

  let noteOpen = $state(false);

  const chat = $derived(appStore.currentChat);
  const settings = $derived(roleplayStore.settings(chat));
  const busy = $derived(appStore.currentChatGenerating || appStore.currentChatBlockedByOtherLocalRun);
  const last = $derived(chat?.messages.at(-1));
  const canContinue = $derived(!busy && last?.role === 'assistant' && !!last.content.trim() && chat?.messages[0]?.id !== last.id);
  const note = $derived(settings.authorNote ?? '');
</script>

<div class="steer">
  {#if noteOpen}
    <div class="note" transition:slide={{ duration: 150 }}>
      <textarea
        class="note-input"
        rows="2"
        value={note}
        placeholder={$t('roleplay.steer.notePlaceholder')}
        aria-label={$t('roleplay.steer.note')}
        onchange={(event) => roleplayStore.setOption('authorNote', event.currentTarget.value)}
      ></textarea>
    </div>
  {/if}
  <div class="chips" role="toolbar" aria-label={$t('roleplay.steer.label')}>
    <button type="button" class="chip" disabled={!canContinue} title={$t('roleplay.steer.continueHint')} onclick={() => last && void appStore.continueMessage(last.id)}>
      <FastForward class="size-3" /> {$t('roleplay.steer.continue')}
    </button>
    <button type="button" class="chip" disabled={busy || roleplayStore.impersonating} title={$t('roleplay.steer.impersonateHint')} onclick={() => void roleplayStore.impersonate()}>
      {#if roleplayStore.impersonating}<LoaderCircle class="size-3 animate-spin" />{:else}<PenLine class="size-3" />{/if}
      {$t('roleplay.steer.impersonate')}
    </button>
    <button type="button" class="chip" class:is-on={noteOpen || !!note.trim()} aria-expanded={noteOpen} title={$t('roleplay.steer.noteHint')} onclick={() => (noteOpen = !noteOpen)}>
      <StickyNote class="size-3" /> {$t('roleplay.steer.note')}
    </button>
    <button type="button" class="chip" class:is-on={settings.adventureChoices} aria-pressed={!!settings.adventureChoices} title={$t('roleplay.steer.choicesHint')} onclick={() => roleplayStore.setOption('adventureChoices', !settings.adventureChoices)}>
      <ListOrdered class="size-3" /> {$t('roleplay.steer.choices')}
    </button>
    {#if settings.interactionMode === 'dynamic'}
      <button type="button" class="chip" disabled={busy} title={$t('roleplay.steer.twistHint')} onclick={() => void roleplayStore.throwTwist()}>
        <Dices class="size-3" /> {$t('roleplay.steer.twist')}
      </button>
    {/if}
  </div>
</div>

<style>
  .steer {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0 0.25rem 0.375rem;
  }

  .chips {
    display: flex;
    gap: 0.25rem;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .chip {
    flex-shrink: 0;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    height: 1.5rem;
    padding: 0 0.55rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    color: var(--muted-foreground);
    font-size: 11.5px;
    transition: background-color var(--motion-fast), color var(--motion-fast), border-color var(--motion-fast);
  }

  .chip:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .chip.is-on {
    border-color: var(--border-hover);
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .chip:disabled {
    opacity: 0.45;
  }

  .note-input {
    width: 100%;
    resize: vertical;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
    padding: 0.4rem 0.6rem;
    color: var(--foreground);
    font-size: 13px;
    line-height: 1.45;
  }

  .note-input:focus {
    outline: none;
    border-color: var(--border-hover);
  }
</style>
