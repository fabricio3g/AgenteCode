<svelte:options runes={true} />

<!--
  Make or change a routine: what to ask, and how often (frequency first,
  cron for anything else). Times are local.
-->

<script lang="ts">
  import UiInput from '$lib/components/ui/Input.svelte';
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Button, Dialog, Field, SegmentedControl, Select } from '$lib/components/ui';
  import { botsStore } from './bots.svelte';
  import type { Routine } from './bots-ipc';
  import { formFrom, toSchedule, WEEKDAYS, type ScheduleForm } from './routine-schedule';

  let { handle, routine, onclose }: { handle: string; routine: Routine | null; onclose: () => void } = $props();

  // The form starts from the routine as it was when the dialog opened.
  const initial = untrack(() => routine);
  let title = $state(initial?.title ?? '');
  let prompt = $state(initial?.prompt ?? '');
  let form = $state<ScheduleForm>(formFrom(initial?.schedule));
  let saving = $state(false);
  let error = $state<string | null>(null);

  const frequencies = $derived(
    (['hour', 'day', 'weekdays', 'week', 'cron'] as const).map((value) => ({ value, label: $t(`bots.every.${value}`) }))
  );

  async function save() {
    if (!title.trim() || !prompt.trim()) {
      error = $t('bots.routineNeeds');
      return;
    }
    saving = true;
    error = null;
    try {
      await botsStore.saveRoutine(handle, {
        ...(routine ? { id: routine.id } : {}),
        title,
        prompt,
        schedule: toSchedule(form),
        paused: routine?.paused ?? false
      });
      onclose();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      saving = false;
    }
  }
</script>

<Dialog title={routine ? $t('bots.editRoutine') : $t('bots.newRoutine')} description={$t('bots.routineHint')} size="md" {onclose}>
  <div class="space-y-4 p-4">
    <Field label={$t('bots.routineTitle')} htmlFor="routine-title">
      <UiInput id="routine-title"  bind:value={title} placeholder={$t('bots.routineTitlePlaceholder')} />
    </Field>
    <Field label={$t('bots.routinePrompt')} htmlFor="routine-prompt">
      <UiTextarea id="routine-prompt" class={uiClass(" min-h-24")} bind:value={prompt} placeholder={$t('bots.routinePromptPlaceholder')}></UiTextarea>
    </Field>
    <SegmentedControl label={$t('bots.frequency')} options={frequencies} bind:value={form.every} />
    <div class="flex flex-wrap items-end gap-3">
      {#if form.every === 'hour'}
        <Field label={$t('bots.minutePast')} htmlFor="routine-minute">
          <UiInput id="routine-minute" class={uiClass(" w-24")} type="number" min="0" max="59" bind:value={form.minute} />
        </Field>
      {:else if form.every === 'cron'}
        <Field label={$t('bots.cron')} description={$t('bots.cronHint')} htmlFor="routine-cron">
          <UiInput id="routine-cron" class={uiClass(" w-56 ")} bind:value={form.expr} />
        </Field>
      {:else}
        {#if form.every === 'week'}
          <Field label={$t('bots.day')}>
            <Select
              class="w-40"
              aria-label={$t('bots.day')}
              bind:value={form.day}
              options={WEEKDAYS.map((day) => ({ value: day, label: $t(`bots.days.${day}`) }))}
            />
          </Field>
        {/if}
        <Field label={$t('bots.at')} htmlFor="routine-at">
          <UiInput id="routine-at" class={uiClass(" w-32")} type="time" bind:value={form.at} />
        </Field>
      {/if}
    </div>
    {#if error}<p class="text-[12px] text-destructive">{error}</p>{/if}
    <div class="flex justify-end gap-2">
      <Button variant="ghost" onclick={onclose}>{$t('bots.cancel')}</Button>
      <Button onclick={save} loading={saving}>{$t('bots.save')}</Button>
    </div>
  </div>
</Dialog>
