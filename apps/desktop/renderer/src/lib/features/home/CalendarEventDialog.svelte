<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { copy } from '$lib/copy';
  import Button from '$lib/components/ui/Button.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import Input from '$lib/components/ui/Input.svelte';
  import { EVENT_COLORS, removeCalendarEvent, saveCalendarEvent, type CalendarEvent, type EventColor } from '$lib/services/home-productivity';

  let { day, event, onclose, onsave }: {
    day: string;
    event?: CalendarEvent;
    onclose: () => void;
    onsave: (day: string) => void;
  } = $props();

  let text = $state(untrack(() => event?.text ?? ''));
  let date = $state(untrack(() => event?.day ?? day));
  let time = $state(untrack(() => event?.time ?? ''));
  let color = $state<EventColor>(untrack(() => event?.color ?? 'blue'));
  let removing = $state(false);
  let error = $state(false);

  function submit(submission: SubmitEvent) {
    submission.preventDefault();
    try {
      const saved = saveCalendarEvent({ text, day: date, time: time || undefined, color }, event?.id);
      onsave(saved.day);
    } catch { error = true; }
  }

  function remove() {
    if (!event) return;
    try { removeCalendarEvent(event.id); onclose(); }
    catch { error = true; }
  }
</script>

<Dialog title={$t(removing ? 'home.calendar.remove' : event ? 'home.calendar.edit' : 'home.calendar.add')} size="sm" {onclose}>
  {#if removing && event}
    <p class="fields">{$t('home.calendar.removePrompt', { values: { title: event.text } })}</p>
  {:else}
    <form id="calendar-event-form" class="fields" onsubmit={submit}>
      <label>{$t('home.calendar.eventTitle')} <Input bind:value={text} required maxlength={160} data-autofocus /></label>
      <label>{$t('home.calendar.date')} <Input type="date" bind:value={date} min="0001-01-01" max="9999-12-31" required /></label>
      <label>{$t('home.calendar.time')} <Input type="time" bind:value={time} /></label>
      <fieldset>
        <legend>{$t('home.calendar.color')}</legend>
        <div class="colors">
          {#each EVENT_COLORS as tone (tone)}
            <label class="color-option calendar-tone" data-tone={tone} title={$t(`home.calendar.colors.${tone}`)}>
              <input class="sr-only" type="radio" name="event-color" value={tone} bind:group={color} />
              <span class="calendar-dot" aria-hidden="true"></span>
              <span class="sr-only">{$t(`home.calendar.colors.${tone}`)}</span>
            </label>
          {/each}
        </div>
      </fieldset>
    </form>
  {/if}
  {#if error}<p class="px-4 pb-3 text-sm text-destructive" role="alert">{$t('home.calendar.saveError')}</p>{/if}
  {#snippet footer()}
    {#if removing && event}
      <Button variant="ghost" size="sm" onclick={() => { removing = false; error = false; }}>{copy.actions.cancel}</Button>
      <Button variant="destructive" size="sm" onclick={remove}>{$t('home.calendar.remove')}</Button>
    {:else}
      {#if event}<Button variant="ghost" size="sm" class="mr-auto" onclick={() => { removing = true; }}>{$t('home.calendar.remove')}</Button>{/if}
      <Button type="submit" form="calendar-event-form" size="sm">{copy.actions.save}</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .fields { display:grid; gap:0.75rem; padding:0.875rem 1rem; font-size:var(--text-sm); }
  .fields label { display:grid; gap:0.25rem; }
  .colors { display:flex; gap:0.375rem; margin-top:0.25rem; }
  .colors .color-option { display:grid; width:2rem; height:2rem; place-items:center; cursor:pointer; border-radius:50%; }
  .color-option:hover { background:var(--surface-hover); }
  .color-option:has(:checked) { background:color-mix(in srgb, var(--calendar-tone) 15%, var(--background)); box-shadow:inset 0 0 0 1px var(--calendar-tone); }
  .color-option:has(:focus-visible) { outline:2px solid var(--ring); }
  .color-option .calendar-dot { width:0.875rem; height:0.875rem; }
</style>
