<svelte:options runes={true} />

<!--
  Make a bot or change one. Quick setup is a name, a role and a colour;
  Advanced holds its files: who it is (SOUL.md), what it knows about you
  (USER.md) and the notes it keeps (MEMORY.md), each up to 4,000 characters.
-->

<script lang="ts">
  import UiIconButton from '$lib/components/ui/IconButton.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Dices } from 'lucide-svelte';
  import { Button, Dialog, Disclosure, Field, Tooltip } from '$lib/components/ui';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import BotAvatar from './BotAvatar.svelte';
  import BotModelPicker from './BotModelPicker.svelte';
  import BotTelegram from './BotTelegram.svelte';
  import { botsStore } from './bots.svelte';
  import { botsIpc, type BotDetail, type BotTint, type SandboxStatus, type Toolset } from './bots-ipc';

  let { bot, onclose }: { bot: BotDetail | null; onclose: () => void } = $props();

  const DOC_CAP = 4000;
  const TINTS: BotTint[] = ['green', 'blue', 'yellow', 'red'];

  // The form starts from the bot as it was when the dialog opened.
  const initial = untrack(() => bot);
  let title = $state(initial?.title ?? '');
  let role = $state(initial?.role ?? '');
  let tint = $state<string>(initial?.avatar.tint ?? 'blue');
  // What the face is drawn from. A new bot gets one right away, so typing its
  // name never redraws it; Shuffle draws another. Bots made before seeds keep
  // the face from their handle until shuffled.
  const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
  let seed = $state<number | undefined>(initial ? initial.avatar.seed : newSeed());
  let soul = $state(initial?.soul ?? '');
  let user = $state(initial?.user ?? '');
  let memory = $state(initial?.memory ?? '');
  // Its own provider and model, or none to follow the chat's.
  let modelPin = $state(initial?.model);
  // Empty means no limit.
  let budget = $state(initial?.daily_budget != null ? String(initial.daily_budget) : '');
  // What the bot may use. Every set on (the default) saves as none named,
  // which keeps meaning "everything", sets added later included.
  let toolsets = $state<Toolset[]>([]);
  let enabled = $state<string[]>(initial?.toolsets ?? []);
  let sandbox = $state<SandboxStatus | null>(null);
  const allTools = $derived(!enabled.length || toolsets.every((set) => enabled.includes(set.id)));
  const isOn = (id: string) => !enabled.length || enabled.includes(id);
  function toggleSet(id: string) {
    const current = enabled.length ? enabled : toolsets.map((set) => set.id);
    enabled = current.includes(id) ? current.filter((set) => set !== id) : [...current, id];
  }
  $effect(() => {
    void botsIpc.toolsets().then((sets) => {
      toolsets = sets;
      // A new bot starts without MCP servers (they run outside the sandbox),
      // which lets a boxed bot work without asking.
      if (!initial) enabled = sets.map((set) => set.id).filter((id) => id !== 'mcp');
    }).catch(() => {});
    void botsIpc.sandbox().then((status) => (sandbox = status)).catch(() => {});
  });

  let advanced = $state(false);
  let telegramOpen = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

  // An existing bot keeps its own face while edited; a new one is drawn from its title.
  const preview = $derived({ handle: bot?.handle, title: title || '?', avatar: { tint, seed, initials: bot?.avatar.initials }, working: false });
  const tooLong = $derived([soul, user, memory].some((text) => text.length > DOC_CAP));
  const budgetValue = $derived(budget.trim() === '' ? undefined : Number(budget.trim().replace(',', '.')));
  const budgetInvalid = $derived(budgetValue !== undefined && !(Number.isFinite(budgetValue) && budgetValue > 0));
  const usd = (value: number) => `$${value.toFixed(2)}`;

  // What both a new bot and an edited one save from the form.
  const form = $derived({
    title: title.trim(),
    role: role.trim(),
    model: modelPin,
    toolsets: allTools ? [] : enabled,
    daily_budget: budgetValue
  });

  async function persist() {
    if (bot) {
      // Fields the form doesn't show (skills, the sandbox) are kept as they are.
      const config = { ...form, avatar: { ...bot.avatar, tint, seed }, skills: bot.skills, sandbox: bot.sandbox };
      await botsStore.save(bot.handle, config, { soul, user, memory });
      return;
    }
    const created = await botsStore.create({ ...form, avatar: { tint, seed }, soul });
    if (user.trim()) await botsIpc.writeDoc(created.handle, 'user', user);
  }

  async function save() {
    if (!title.trim()) {
      error = $t('bots.nameNeeded');
      return;
    }
    saving = true;
    error = null;
    try {
      await persist();
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

<Dialog title={bot ? $t('bots.editTitle', { values: { name: bot.title } }) : $t('bots.new')} size="md" {onclose}>
  <div class="space-y-4 p-4">
    <div class="flex items-center gap-3">
      <BotAvatar bot={preview} size="xl" />
      <div class="flex gap-1.5" role="radiogroup" aria-label={$t('bots.color')}>
        {#each TINTS as option (option)}
          <Button variant="plain" style={`background:var(--accent-${option}-bg);color:var(--accent-${option}-text)`}
            type="button"
            role="radio"
            aria-checked={tint === option}
            aria-label={$t(`bots.tints.${option}`)}
            class={uiClass("swatch", "ui-local-93ef8bbd", {"selected": tint === option})}



            onclick={() => (tint = option)}
          >●</Button>
        {/each}
      </div>
      {#if !bot?.avatar.image}
        <Tooltip label={$t('bots.shuffleFace')} position="bottom"><UiIconButton label={$t('bots.shuffleFace')} size="sm" type="button" class={uiClass(" shuffle", "ui-local-93ef8bbd")} onclick={() => (seed = newSeed())} >
          <Dices class="size-4" />
        </UiIconButton></Tooltip>
      {/if}
    </div>
    <Field label={$t('bots.name')} htmlFor="bot-name">
      <UiInput id="bot-name" class={uiClass("", "ui-local-93ef8bbd")} bind:value={title} placeholder={$t('bots.namePlaceholder')} />
    </Field>
    <Field label={$t('bots.role')} htmlFor="bot-role">
      <UiInput id="bot-role" class={uiClass("", "ui-local-93ef8bbd")} bind:value={role} placeholder={$t('bots.rolePlaceholder')} />
    </Field>

    <Field label={$t('bots.model')}>
      <BotModelPicker bind:value={modelPin} />
    </Field>

    <Disclosure bind:open={advanced} title={$t('bots.advanced')}>
      <div class="space-y-4 pt-2">
        {#if toolsets.length}
          <Field label={$t('bots.tools')} description={`${$t('bots.toolsHint')} ${sandbox ? $t(sandbox.available ? 'bots.sandboxOn' : 'bots.sandboxOff') : ''}`.trim()}>
            <div class="flex flex-wrap gap-1.5" role="group" aria-label={$t('bots.tools')}>
              {#each toolsets as set (set.id)}
                <Button variant="plain" type="button" class={uiClass("toolset", "ui-local-93ef8bbd", {"on": isOn(set.id)})}  aria-pressed={isOn(set.id)} title={set.tools.join(', ')} onclick={() => toggleSet(set.id)}>
                  {$t(`bots.toolsets.${set.id}`, { default: set.id })}
                </Button>
              {/each}
            </div>
          </Field>
        {/if}
        <Field label={$t('bots.soul')} description={$t('bots.soulHint')} htmlFor="bot-soul">
          <UiTextarea id="bot-soul" class={uiClass(" min-h-28", "ui-local-93ef8bbd")} bind:value={soul}></UiTextarea>
        </Field>
        <Field label={$t('bots.aboutYou')} description={$t('bots.aboutYouHint')} htmlFor="bot-user">
          <UiTextarea id="bot-user" class={uiClass(" min-h-20", "ui-local-93ef8bbd")} bind:value={user}></UiTextarea>
        </Field>
        {#if bot}
          <Field label={$t('bots.memory')} description={$t('bots.memoryHint')} htmlFor="bot-memory">
            <UiTextarea id="bot-memory" class={uiClass(" min-h-24 text-[length:var(--text-xs)]", "ui-local-93ef8bbd")} bind:value={memory}></UiTextarea>
          </Field>
        {/if}
        <Field
          label={$t('bots.budget')}
          description={bot ? $t('bots.budgetHintSpent', { values: { spent: usd(bot.spent_today ?? 0) } }) : $t('bots.budgetHint')}
          error={budgetInvalid ? $t('bots.budgetInvalid') : undefined}
          htmlFor="bot-budget"
        >
          <div class="flex items-center gap-2">
            <span class="text-[length:var(--text-sm)] text-muted-foreground">$</span>
            <UiInput id="bot-budget" class={uiClass(" budget-input", "ui-local-93ef8bbd")} type="text" inputmode="decimal" bind:value={budget} placeholder={$t('bots.noLimit')} />
            <span class="whitespace-nowrap text-[length:var(--text-xs)] text-muted-foreground">{$t('bots.perDay')}</span>
          </div>
        </Field>
        {#if tooLong}<p class="text-[length:var(--text-xs)] text-destructive">{$t('bots.tooLong', { values: { n: DOC_CAP } })}</p>{/if}
      </div>
    </Disclosure>

    {#if bot}
      <Disclosure bind:open={telegramOpen} title={$t('bots.telegram.title')} description={$t('bots.telegram.hint')}>
        <div class="pt-2">
          {#if telegramOpen}<BotTelegram handle={bot.handle} />{/if}
        </div>
      </Disclosure>
    {/if}

    {#if error}<p class="text-[length:var(--text-xs)] text-destructive">{error}</p>{/if}
    <div class="flex items-center gap-2">
      {#if bot && !bot.builtin}
        <Button variant="ghost" class="hover:text-destructive" onclick={remove}>{$t('bots.delete')}</Button>
      {/if}
      <span class="flex-1"></span>
      <Button variant="ghost" onclick={onclose}>{$t('bots.cancel')}</Button>
      <Button onclick={save} loading={saving} disabled={tooLong || budgetInvalid}>{bot ? $t('bots.save') : $t('bots.create')}</Button>
    </div>
  </div>
</Dialog>

<style>
  :global(.swatch.ui-local-93ef8bbd) {
    display: inline-flex;
    height: 1.6rem;
    width: 1.6rem;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    box-shadow: inset 0 0 0 1px var(--border-subtle);
  }
  :global(.budget-input.ui-local-93ef8bbd) { width: 8rem; }
  :global(.shuffle.ui-local-93ef8bbd) { margin-left: 0.25rem; }
  :global(.toolset.ui-local-93ef8bbd) {
    height: 1.75rem;
    padding: 0 0.75rem;
    border-radius: var(--radius-full);
    font-size: var(--text-sm);
    color: var(--muted-foreground);
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--border);
    transition: background 150ms var(--motion-ease), color 150ms var(--motion-ease);
  }
  :global(.toolset:hover.ui-local-93ef8bbd) { color: var(--foreground); }
  :global(.toolset.on.ui-local-93ef8bbd) { color: var(--foreground); background: var(--muted); box-shadow: inset 0 0 0 1px var(--border-hover); }
  :global(.swatch.selected.ui-local-93ef8bbd) { box-shadow: 0 0 0 2px var(--background), 0 0 0 3.5px var(--foreground); }
</style>
