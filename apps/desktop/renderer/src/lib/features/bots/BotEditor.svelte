<svelte:options runes={true} />

<!--
  Make a bot or change one. Quick setup is a name, a role and a colour;
  Advanced holds its files: who it is (SOUL.md), what it knows about you
  (USER.md) and the notes it keeps (MEMORY.md), each up to 4,000 characters.
-->

<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Button, Dialog, Disclosure, Field } from '$lib/components/ui';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import BotAvatar from './BotAvatar.svelte';
  import BotModelPicker from './BotModelPicker.svelte';
  import BotTelegram from './BotTelegram.svelte';
  import { botsStore } from './bots.svelte';
  import { botsIpc, type BotDetail, type BotTint } from './bots-ipc';

  let { bot, onclose }: { bot: BotDetail | null; onclose: () => void } = $props();

  const DOC_CAP = 4000;
  const TINTS: BotTint[] = ['green', 'blue', 'yellow', 'red'];

  // The form starts from the bot as it was when the dialog opened.
  const initial = untrack(() => bot);
  let title = $state(initial?.title ?? '');
  let role = $state(initial?.role ?? '');
  let tint = $state<string>(initial?.avatar.tint ?? 'blue');
  let soul = $state(initial?.soul ?? '');
  let user = $state(initial?.user ?? '');
  let memory = $state(initial?.memory ?? '');
  // Its own provider and model, or none to follow the chat's.
  let modelPin = $state(initial?.model);
  // Empty means no limit.
  let budget = $state(initial?.daily_budget != null ? String(initial.daily_budget) : '');
  let advanced = $state(false);
  let telegramOpen = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

  const preview = $derived({ title: title || '?', avatar: { tint, initials: bot?.avatar.initials }, working: false });
  const tooLong = $derived([soul, user, memory].some((text) => text.length > DOC_CAP));
  const budgetValue = $derived(budget.trim() === '' ? undefined : Number(budget.trim().replace(',', '.')));
  const budgetInvalid = $derived(budgetValue !== undefined && !(Number.isFinite(budgetValue) && budgetValue > 0));
  const usd = (value: number) => `$${value.toFixed(2)}`;

  async function save() {
    if (!title.trim()) {
      error = $t('bots.nameNeeded');
      return;
    }
    saving = true;
    error = null;
    try {
      if (bot) {
        const { avatar, toolsets, skills } = bot;
        await botsStore.save(
          bot.handle,
          { title: title.trim(), role: role.trim(), avatar: { ...avatar, tint }, model: modelPin, toolsets, skills, daily_budget: budgetValue },
          { soul, user, memory }
        );
      } else {
        const created = await botsStore.create({ title: title.trim(), role: role.trim(), avatar: { tint }, soul, model: modelPin, daily_budget: budgetValue });
        if (user.trim()) await botsIpc.writeDoc(created.handle, 'user', user);
      }
      onclose();
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      saving = false;
    }
  }

  function remove() {
    if (!bot) return;
    confirmStore.show({
      title: $t('bots.deleteTitle', { values: { name: bot.title } }),
      message: $t('bots.deleteMessage'),
      confirmLabel: $t('bots.delete'),
      danger: true,
      onConfirm: () => {
        void botsStore.remove(bot.handle);
        onclose();
      }
    });
  }
</script>

<Dialog title={bot ? $t('bots.editTitle', { values: { name: bot.title } }) : $t('bots.new')} description={$t('bots.editorHint')} size="md" {onclose}>
  <div class="space-y-4 p-4">
    <div class="flex items-center gap-3">
      <BotAvatar bot={preview} size="lg" />
      <div class="flex gap-1.5" role="radiogroup" aria-label={$t('bots.color')}>
        {#each TINTS as option (option)}
          <button
            type="button"
            role="radio"
            aria-checked={tint === option}
            aria-label={$t(`bots.tints.${option}`)}
            class="swatch"
            class:selected={tint === option}
            style:background={`var(--accent-${option}-bg)`}
            style:color={`var(--accent-${option}-text)`}
            onclick={() => (tint = option)}
          >●</button>
        {/each}
      </div>
    </div>
    <Field label={$t('bots.name')} htmlFor="bot-name">
      <input id="bot-name" class="aui-input" bind:value={title} placeholder={$t('bots.namePlaceholder')} />
    </Field>
    <Field label={$t('bots.role')} htmlFor="bot-role">
      <input id="bot-role" class="aui-input" bind:value={role} placeholder={$t('bots.rolePlaceholder')} />
    </Field>

    <Field label={$t('bots.model')} description={$t('bots.modelHint')}>
      <BotModelPicker bind:value={modelPin} />
    </Field>

    <Disclosure bind:open={advanced} title={$t('bots.advanced')} description={$t('bots.advancedHint')}>
      <div class="space-y-4 pt-2">
        <Field label={$t('bots.soul')} description={$t('bots.soulHint')} htmlFor="bot-soul">
          <textarea id="bot-soul" class="aui-input min-h-28" bind:value={soul}></textarea>
        </Field>
        <Field label={$t('bots.aboutYou')} description={$t('bots.aboutYouHint')} htmlFor="bot-user">
          <textarea id="bot-user" class="aui-input min-h-20" bind:value={user}></textarea>
        </Field>
        {#if bot}
          <Field label={$t('bots.memory')} description={$t('bots.memoryHint')} htmlFor="bot-memory">
            <textarea id="bot-memory" class="aui-input min-h-24 text-[12px]" bind:value={memory}></textarea>
          </Field>
        {/if}
        <Field
          label={$t('bots.budget')}
          description={bot ? $t('bots.budgetHintSpent', { values: { spent: usd(bot.spent_today ?? 0) } }) : $t('bots.budgetHint')}
          error={budgetInvalid ? $t('bots.budgetInvalid') : undefined}
          htmlFor="bot-budget"
        >
          <div class="flex items-center gap-2">
            <span class="text-[13px] text-muted-foreground">$</span>
            <input id="bot-budget" class="aui-input budget-input" type="text" inputmode="decimal" bind:value={budget} placeholder={$t('bots.noLimit')} />
            <span class="whitespace-nowrap text-[12px] text-muted-foreground">{$t('bots.perDay')}</span>
          </div>
        </Field>
        {#if tooLong}<p class="text-[12px] text-destructive">{$t('bots.tooLong', { values: { n: DOC_CAP } })}</p>{/if}
      </div>
    </Disclosure>

    {#if bot}
      <Disclosure bind:open={telegramOpen} title={$t('bots.telegram.title')} description={$t('bots.telegram.hint')}>
        <div class="pt-2">
          {#if telegramOpen}<BotTelegram handle={bot.handle} />{/if}
        </div>
      </Disclosure>
    {/if}

    {#if error}<p class="text-[12px] text-destructive">{error}</p>{/if}
    <div class="flex items-center gap-2">
      {#if bot && !bot.builtin}
        <Button variant="ghost" class="text-destructive" onclick={remove}>{$t('bots.delete')}</Button>
      {/if}
      <span class="flex-1"></span>
      <Button variant="ghost" onclick={onclose}>{$t('bots.cancel')}</Button>
      <Button onclick={save} loading={saving} disabled={tooLong || budgetInvalid}>{bot ? $t('bots.save') : $t('bots.create')}</Button>
    </div>
  </div>
</Dialog>

<style>
  .swatch {
    display: inline-flex;
    height: 1.6rem;
    width: 1.6rem;
    align-items: center;
    justify-content: center;
    border-radius: 9999px;
    font-size: 10px;
    box-shadow: inset 0 0 0 1px var(--border-subtle);
  }
  .budget-input { width: 8rem; }
  .swatch.selected { box-shadow: 0 0 0 2px var(--background), 0 0 0 3.5px var(--foreground); }
</style>
