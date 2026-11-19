<svelte:options runes={true} />

<!--
  The models subagents may run on. The agent creates each subagent for its
  task and picks one of these by reading the note under it.

  Laid out by the Laws of UX (lawsofux.com):
  - Jakob's law + Von Restorff: the default is a radio at the start of each
    row (the conversation's own model is the last option), and the default
    row is the one that stands out — no second control elsewhere says it.
  - Chunking + proximity: a row is its name and model on one line, the note
    in readable text under it; rows sit in one common region, the switch in
    another.
  - Hick + Occam: nothing but name, model and note; no headings repeating
    the dialog's own title, no live subagent cards in a settings view.
  - Postel: names are folded into shape as they are typed, never refused.
  - Zeigarnik: a row without a model stays on screen as a draft until it
    gets one or is removed — nothing disappears silently.
  - Fitts: the whole row opens it; Remove sits apart from Done.
  Changes save as they happen.
-->

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { Plus } from '$lib/icons';
  import { Button, Input, Switch, Textarea } from '$lib/components/ui';
  import { invoke } from '$lib/services/bridge';
  import ModelOverridePicker from '$lib/features/shared/ModelOverridePicker.svelte';
  import { shortModel } from '$lib/utils/format';
  import type { SubagentModelEntry, SubagentSettings } from '$shared/agente-protocol';
  import { modelName, settledName, typedName } from './subagent-models';

  let { onerror }: { onerror: (message: string) => void } = $props();

  type Row = SubagentModelEntry & { key: string };

  const MAIN = 'main';
  let rows = $state<Row[]>([]);
  let picks = $state(true);
  /** A list name, or `main` for the conversation's model (saved as unset). */
  let defaultModel = $state(MAIN);
  let editing = $state<string | null>(null);
  let loaded = $state(false);
  let saved = $state(false);
  let lastSaved = '';

  const complete = $derived(rows.filter((row) => row.name && row.provider && row.model));

  onMount(async () => {
    try {
      const settings = await invoke<{ subagents?: SubagentSettings }>('agente_runtime_settings');
      const current = settings?.subagents ?? {};
      rows = (current.models ?? []).map((entry) => ({ ...entry, provider: entry.provider.replace(/^desktop-/, ''), key: crypto.randomUUID() }));
      picks = current.orchestrator_picks ?? true;
      defaultModel = current.default_model && rows.some((row) => row.name === current.default_model) ? current.default_model : MAIN;
      lastSaved = snapshot();
    } catch (cause) {
      onerror(String(cause));
    } finally {
      loaded = true;
    }
  });

  /** What would be saved: complete rows, and the default unless it is the conversation's model. */
  function snapshot(): string {
    const models = complete.map(({ key: _key, ...entry }) => ({ ...entry, use_for: entry.use_for?.trim() || undefined }));
    const known = models.some((entry) => entry.name === defaultModel);
    return JSON.stringify({ orchestrator_picks: picks ? undefined : false, models, default_model: known ? defaultModel : undefined });
  }

  $effect(() => {
    if (!loaded) return;
    const next = snapshot();
    if (next === lastSaved) return;
    saved = false;
    const timer = setTimeout(async () => {
      try {
        await invoke('agente_subagent_settings', JSON.parse(next) as Record<string, unknown>);
        lastSaved = next;
        saved = true;
      } catch (cause) {
        onerror(String(cause));
      }
    }, 400);
    return () => clearTimeout(timer);
  });

  async function add() {
    const row: Row = { key: crypto.randomUUID(), name: '', provider: '', model: '', use_for: '' };
    rows.push(row);
    editing = row.key;
    await tick();
    document.querySelector<HTMLElement>(`[data-model-row="${row.key}"] .model-trigger`)?.click();
  }

  function choose(index: number, pin: { provider: string; model: string; thinking?: string } | undefined) {
    const row = rows[index]!;
    row.provider = pin?.provider ?? '';
    row.model = pin?.model ?? '';
    row.thinking = pin?.thinking;
    if (!row.name && row.model) row.name = modelName(row.model, rows, index);
  }

  function settle(index: number) {
    const row = rows[index]!;
    const before = row.name;
    row.name = settledName(rows, index);
    if (defaultModel === before && before !== row.name) defaultModel = row.name || MAIN;
  }

  function remove(row: Row) {
    rows = rows.filter((item) => item.key !== row.key);
    if (defaultModel === row.name) defaultModel = MAIN;
    if (editing === row.key) editing = null;
  }

  function modelLabel(row: Row): string {
    return shortModel(row.model);
  }
</script>

<div class="editor-root">
  <div class="region" role="radiogroup" aria-label={$t('code.project.agents.defaultModel')}>
    {#each rows as row, index (row.key)}
      {@const isDefault = defaultModel === row.name && !!row.model}
      <div class="row" data-model-row={row.key} class:is-default={isDefault} class:is-editing={editing === row.key}>
        <input
          class="radio"
          type="radio"
          name="subagent-default"
          checked={isDefault}
          disabled={!row.model || !row.name}
          aria-label={$t('code.project.agents.makeDefault', { values: { name: row.name || '—' } })}
          onchange={() => (defaultModel = row.name)}
        />
        {#if editing === row.key}
          <div class="form">
            <div class="form-line">
              <label class="field name-field">
                <span>{$t('code.project.agents.name')}</span>
                <Input value={row.name} oninput={(event) => (row.name = typedName((event.currentTarget as HTMLInputElement).value))} onblur={() => settle(index)} />
              </label>
              <div class="field model-field">
                <span>{$t('code.project.agents.model')}</span>
                <ModelOverridePicker compact placeholder={$t('code.project.agents.chooseModel')} value={row.provider && row.model ? { provider: row.provider, model: row.model, thinking: row.thinking } : undefined} onchange={(pin) => choose(index, pin)} />
              </div>
            </div>
            <label class="field">
              <span>{$t('code.project.agents.useFor')}</span>
              <Textarea rows={2} bind:value={row.use_for} placeholder={$t('code.project.agents.useForPlaceholder')} />
            </label>
            <div class="form-actions">
              <Button size="sm" variant="secondary" onclick={() => { settle(index); editing = null; }}>{$t('code.project.agents.done')}</Button>
              <Button size="sm" variant="ghost" class="remove" onclick={() => remove(row)}>{$t('code.project.agents.remove')}</Button>
            </div>
          </div>
        {:else}
          <button type="button" class="entry" onclick={() => (editing = row.key)} aria-label={$t('code.project.agents.edit', { values: { name: row.name || $t('code.project.agents.chooseModel') } })}>
            <span class="entry-head">
              <span class="entry-name">{row.name || $t('code.project.agents.draft')}</span>
              {#if isDefault}<span class="badge">{$t('code.project.agents.defaultChip')}</span>{/if}
              {#if row.model}
                <span class="entry-model" title={`${row.provider} · ${row.model}`}>
                  {modelLabel(row)}{#if row.model.endsWith(':free')}<span class="free">{$t('code.project.agents.free')}</span>{/if}
                </span>
              {/if}
            </span>
            {#if !row.model}
              <span class="entry-note is-draft">{$t('code.project.agents.needsModel')}</span>
            {:else}
              <span class="entry-note" class:is-empty={!row.use_for?.trim()}>{row.use_for?.trim() || $t('code.project.agents.noNote')}</span>
            {/if}
          </button>
        {/if}
      </div>
    {/each}

    <!-- The conversation's own model: always there, the last option, not editable. -->
    <label class="row main-row" class:is-default={defaultModel === MAIN}>
      <input class="radio" type="radio" name="subagent-default" checked={defaultModel === MAIN} onchange={() => (defaultModel = MAIN)} />
      <span class="entry">
        <span class="entry-head">
          <span class="entry-name">{$t('code.project.agents.mainModel')}</span>
          {#if defaultModel === MAIN}<span class="badge">{$t('code.project.agents.defaultChip')}</span>{/if}
        </span>
        <span class="entry-note is-empty">{$t('code.project.agents.mainModelHint')}</span>
      </span>
    </label>
  </div>

  <div class="add">
    <Button size="sm" variant="ghost" onclick={add}><Plus /> {$t('code.project.agents.add')}</Button>
    <span class="save-state" role="status" aria-live="polite">{saved ? $t('code.project.settings.saved') : ''}</span>
  </div>

  <label class="region switch-region">
    <span class="switch-text">
      <span class="switch-title">{$t('code.project.agents.picks')}</span>
      <span class="switch-hint">{picks ? $t('code.project.agents.picksOn') : $t('code.project.agents.picksOff')}</span>
    </span>
    <Switch label={$t('code.project.agents.picks')} bind:checked={picks} />
  </label>
</div>

<style>
  .editor-root { display: grid; gap: 0.5rem; padding: 0.25rem 0.375rem 0.5rem; }

  /* Common region: the list is one surface, the switch another. */
  .region { border: 1px solid var(--border-subtle); border-radius: 0.75rem; overflow: hidden; }
  .row { display: grid; grid-template-columns: 2.25rem minmax(0, 1fr); align-items: start; }
  .row + .row { border-top: 1px solid var(--border-subtle); }
  .row.is-default { background: color-mix(in oklab, var(--brand-accent) 7%, transparent); }
  .radio { justify-self: center; margin-top: 1.05rem; width: 1rem; height: 1rem; accent-color: var(--brand-accent); cursor: pointer; }
  .radio:disabled { cursor: default; opacity: 0.4; }

  .entry { display: grid; width: 100%; min-width: 0; gap: 0.25rem; padding: 0.75rem 0.875rem 0.75rem 0; text-align: left; cursor: pointer; }
  button.entry:hover .entry-name, button.entry:focus-visible .entry-name { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--border-hover); }
  .entry-head { display: flex; min-width: 0; align-items: baseline; gap: 0.5rem; }
  .entry-name { font-size: var(--text-prose); font-weight: 600; color: var(--foreground); }
  .badge { border-radius: 999px; background: color-mix(in oklab, var(--brand-accent) 16%, transparent); padding: 0 0.5rem; font-size: var(--text-xs); line-height: 1.6; font-weight: 500; color: var(--brand-accent-strong); }
  .entry-model { display: inline-flex; margin-left: auto; min-width: 0; align-items: baseline; gap: 0.375rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); color: var(--muted-foreground); }
  .free { border-radius: 999px; background: var(--surface-active); padding: 0 0.4rem; font-size: var(--text-xs); }
  .entry-note { max-width: 64ch; font-size: var(--text-sm); line-height: 1.55; color: var(--prose-ink, var(--foreground)); }
  .entry-note.is-empty { color: var(--muted-foreground); }
  .entry-note.is-draft { color: var(--warning, var(--muted-foreground)); }
  .main-row .entry { cursor: pointer; }

  .form { display: grid; gap: 0.75rem; padding: 0.75rem 0.875rem 0.875rem 0; }
  .form-line { display: grid; grid-template-columns: minmax(0, 11rem) minmax(0, 1fr); gap: 0.75rem; }
  .field { display: grid; gap: 0.25rem; min-width: 0; }
  .field > span { font-size: var(--text-xs); color: var(--muted-foreground); }
  /* Under its label the picker starts on the field's left edge, like the inputs. */
  .model-field :global(.picker.is-compact) { justify-content: flex-start; }
  .form-actions { display: flex; align-items: center; }
  .form-actions :global(.remove) { margin-left: auto; color: var(--muted-foreground); }

  .add { display: flex; align-items: center; justify-content: space-between; margin-left: -0.375rem; }
  .save-state { font-size: var(--text-xs); color: var(--muted-foreground); }

  .switch-region { display: flex; align-items: center; gap: 1rem; padding: 0.75rem 0.875rem; cursor: pointer; }
  .switch-text { display: grid; min-width: 0; flex: 1; gap: 0.125rem; }
  .switch-title { font-size: var(--text-sm); font-weight: 500; color: var(--foreground); }
  .switch-hint { font-size: var(--text-xs); line-height: 1.45; color: var(--muted-foreground); }

  @media (max-width: 560px) { .form-line { grid-template-columns: minmax(0, 1fr); } }
</style>
