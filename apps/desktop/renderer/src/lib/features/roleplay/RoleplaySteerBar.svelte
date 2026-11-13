<svelte:options runes={true} />

<!--
  Quiet chips above the roleplay composer for steering the scene without
  writing the next turn yourself: let the last reply keep going, draft your
  own next line, keep an author's note, offer choices, throw a twist.
-->

<script lang="ts">
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Dices, FastForward, ListOrdered, PenLine, StickyNote } from '$lib/icons';
  import { Button } from '$lib/components/ui';
  import { motionSlide } from '$lib/utils/transitions';
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
    <div class="note" transition:motionSlide={{ duration: 150 }}>
      <UiTextarea
        class={uiClass(" note-input", "ui-local-1d5c78b6")}
        rows={2}
        value={note}
        placeholder={$t('roleplay.steer.notePlaceholder')}
        aria-label={$t('roleplay.steer.note')}
        onchange={(event) => roleplayStore.setOption('authorNote', event.currentTarget.value)}
      ></UiTextarea>
    </div>
  {/if}
  <div class="chips" role="toolbar" aria-label={$t('roleplay.steer.label')}>
    <Button variant="outline" size="xs" disabled={!canContinue} title={$t('roleplay.steer.continueHint')} onclick={() => last && void appStore.continueMessage(last.id)}>
      <FastForward class="size-3" /> {$t('roleplay.steer.continue')}
    </Button>
    <Button variant="outline" size="xs" disabled={busy} loading={roleplayStore.impersonating} title={$t('roleplay.steer.impersonateHint')} onclick={() => void roleplayStore.impersonate()}>
      <PenLine />
      {$t('roleplay.steer.impersonate')}
    </Button>
    <Button variant="outline" size="xs" class={noteOpen || note.trim() ? 'bg-[var(--surface-hover)]' : ''} aria-expanded={noteOpen} title={$t('roleplay.steer.noteHint')} onclick={() => (noteOpen = !noteOpen)}>
      <StickyNote class="size-3" /> {$t('roleplay.steer.note')}
    </Button>
    <Button variant="outline" size="xs" class={settings.adventureChoices ? 'bg-[var(--surface-hover)]' : ''} aria-pressed={!!settings.adventureChoices} title={$t('roleplay.steer.choicesHint')} onclick={() => roleplayStore.setOption('adventureChoices', !settings.adventureChoices)}>
      <ListOrdered class="size-3" /> {$t('roleplay.steer.choices')}
    </Button>
    {#if settings.interactionMode === 'dynamic'}
      <Button variant="outline" size="xs" disabled={busy} title={$t('roleplay.steer.twistHint')} onclick={() => void roleplayStore.throwTwist()}>
        <Dices class="size-3" /> {$t('roleplay.steer.twist')}
      </Button>
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
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  :global(.note-input.ui-local-1d5c78b6) {
    resize: vertical;
    font-size: var(--text-sm);
    line-height: 1.45;
  }
</style>
