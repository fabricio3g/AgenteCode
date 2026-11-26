<svelte:options runes={true} />

<script lang="ts">
  import { spaceVisible } from '$lib/components/layout/space-visibility';
  import { t } from 'svelte-i18n';
  import { Check, ListChecks } from '$lib/icons';
  import Button from '$lib/components/ui/Button.svelte';
  import type { PendingUserInput, UserInputResolution } from '$lib/stores/user-inputs.svelte';
  import { formatShortcut } from '$lib/utils/shortcuts';
  import {
    buildElicitationContent,
    initialElicitationState,
    parseElicitationSchema,
    validateElicitationAnswers,
    type ElicitationField,
    type ElicitationFormState
  } from './elicitation-schema';

  const shown = spaceVisible();

  let {
    input,
    index = 1,
    total = 1,
    onanswer
  }: {
    input: PendingUserInput;
    index?: number;
    total?: number;
    onanswer: (resolution: UserInputResolution) => void;
  } = $props();

  const fields = $derived(parseElicitationSchema(input.schema));
  let formState = $state<ElicitationFormState>({ values: {}, customValues: {} });
  let validationError = $state('');

  $effect(() => {
    const parsed = parseElicitationSchema(input.schema);
    void input.id;
    formState = initialElicitationState(parsed);
    validationError = '';
  });

  function selectSingle(field: Extract<ElicitationField, { kind: 'single_select' }>, value: string) {
    validationError = '';
    const current = formState.values[field.key];
    formState.values = {
      ...formState.values,
      [field.key]: !field.required && current === value ? '' : value
    };
    if (field.customKey) {
      formState.customValues = { ...formState.customValues, [field.key]: '' };
    }
  }

  function updateSingleCustom(fieldKey: string, text: string) {
    validationError = '';
    formState.customValues = { ...formState.customValues, [fieldKey]: text };
    if (text.trim()) {
      formState.values = { ...formState.values, [fieldKey]: '' };
    }
  }

  function toggleMulti(fieldKey: string, value: string) {
    validationError = '';
    const current = Array.isArray(formState.values[fieldKey]) ? (formState.values[fieldKey] as string[]) : [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    formState.values = { ...formState.values, [fieldKey]: next };
  }

  function updateMultiCustom(fieldKey: string, text: string) {
    validationError = '';
    formState.customValues = { ...formState.customValues, [fieldKey]: text };
  }

  function updateScalar(fieldKey: string, value: string | boolean) {
    validationError = '';
    formState.values = { ...formState.values, [fieldKey]: value };
  }

  function submit() {
    const missing = validateElicitationAnswers(fields, formState);
    if (missing) {
      validationError = $t('code.question.requiredField', { values: { field: missing } });
      return;
    }
    const content = buildElicitationContent(fields, formState);
    onanswer({ action: 'accept', content });
  }

  function skip() {
    onanswer({ action: 'decline' });
  }

  function onKeydown(event: KeyboardEvent) {
    if (!shown() || event.defaultPrevented || event.isComposing) return;
    const target = event.target;
    const insideInput = target instanceof Element && !!target.closest('textarea, input, select, [contenteditable="true"]');
    if (event.key === 'Escape') {
      event.preventDefault();
      skip();
      return;
    }
    if (insideInput) {
      if (event.key === 'Enter' && !event.shiftKey && !(target instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        submit();
      }
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
      return;
    }
    if (fields.length === 1 && (fields[0]!.kind === 'single_select' || fields[0]!.kind === 'multi_select')) {
      const idx = Number(event.key) - 1;
      const only = fields[0]!;
      if (/^[1-9]$/.test(event.key) && idx >= 0 && idx < only.options.length) {
        event.preventDefault();
        if (only.kind === 'single_select') selectSingle(only, only.options[idx]!.value);
        else toggleMulti(only.key, only.options[idx]!.value);
      }
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="frame">
  <div class="question-band" role="group" aria-label={input.message || $t('code.question.title')}>
    <div class="header-row">
      <span class="glyph" aria-hidden="true"><ListChecks class="size-4" /></span>
      <div class="heading-text">
        <p class="title">
          {input.message && input.message !== 'Questions' ? input.message : $t('code.question.title')}
          {#if total > 1}<span class="count">{$t('code.approve.of', { values: { n: index, total } })}</span>{/if}
        </p>
      </div>
      <div class="actions">
        <Button variant="ghost" size="sm" onclick={skip}>
          {$t('code.question.skip')}<kbd>{formatShortcut('escape')}</kbd>
        </Button>
        <Button variant="default" size="sm" onclick={submit}>
          {$t('code.question.submit')}<kbd>{formatShortcut('enter')}</kbd>
        </Button>
      </div>
    </div>

    {#if fields.length}
      <div class="fields">
        {#each fields as field (field.key)}
          <div class="field-block">
            <div class="field-head">
              <span class="field-title">{field.title}{#if field.required}<span class="req">*</span>{/if}</span>
              {#if field.description && field.description !== field.title}
                <span class="field-desc">{field.description}</span>
              {/if}
            </div>

            {#if field.kind === 'single_select'}
              <div class="options-grid" role="radiogroup" aria-label={field.title}>
                {#each field.options as opt, optIdx (opt.value)}
                  {@const selected = formState.values[field.key] === opt.value}
                  <button
                    type="button"
                    class="option-row"
                    class:is-selected={selected}
                    role="radio"
                    aria-checked={selected}
                    onclick={() => selectSingle(field, opt.value)}
                  >
                    <span class="radio-dot" class:is-selected={selected} aria-hidden="true"></span>
                    <span class="opt-text">
                      <span class="opt-label">{opt.label}</span>
                      {#if opt.description}<span class="opt-desc">{opt.description}</span>{/if}
                    </span>
                    {#if fields.length === 1 && optIdx < 9}
                      <span class="opt-key">{optIdx + 1}</span>
                    {/if}
                  </button>
                {/each}
              </div>
              {#if field.customKey}
                <input
                  type="text"
                  class="text-input"
                  value={formState.customValues[field.key] ?? ''}
                  placeholder={field.customPlaceholder || field.customLabel || $t('code.question.otherPlaceholder')}
                  oninput={(e) => updateSingleCustom(field.key, (e.currentTarget as HTMLInputElement).value)}
                />
              {/if}
            {:else if field.kind === 'multi_select'}
              <div class="options-grid" role="group" aria-label={field.title}>
                {#each field.options as opt, optIdx (opt.value)}
                  {@const selected = Array.isArray(formState.values[field.key]) && (formState.values[field.key] as string[]).includes(opt.value)}
                  <button
                    type="button"
                    class="option-row"
                    class:is-selected={selected}
                    role="checkbox"
                    aria-checked={selected}
                    onclick={() => toggleMulti(field.key, opt.value)}
                  >
                    <span class="check-box" class:is-selected={selected} aria-hidden="true">
                      {#if selected}<Check class="size-2.5" />{/if}
                    </span>
                    <span class="opt-text">
                      <span class="opt-label">{opt.label}</span>
                      {#if opt.description}<span class="opt-desc">{opt.description}</span>{/if}
                    </span>
                    {#if fields.length === 1 && optIdx < 9}
                      <span class="opt-key">{optIdx + 1}</span>
                    {/if}
                  </button>
                {/each}
              </div>
              {#if field.customKey}
                <input
                  type="text"
                  class="text-input"
                  value={formState.customValues[field.key] ?? ''}
                  placeholder={field.customPlaceholder || field.customLabel || $t('code.question.otherPlaceholder')}
                  oninput={(e) => updateMultiCustom(field.key, (e.currentTarget as HTMLInputElement).value)}
                />
              {/if}
            {:else if field.kind === 'boolean'}
              <label class="bool-row">
                <input
                  type="checkbox"
                  checked={!!formState.values[field.key]}
                  onchange={(e) => updateScalar(field.key, (e.currentTarget as HTMLInputElement).checked)}
                />
                <span>{field.description || field.title}</span>
              </label>
            {:else if field.kind === 'number'}
              <input
                type="number"
                step={field.isInteger ? '1' : 'any'}
                class="text-input"
                value={String(formState.values[field.key] ?? '')}
                placeholder={field.description || field.title}
                oninput={(e) => updateScalar(field.key, (e.currentTarget as HTMLInputElement).value)}
              />
            {:else}
              <input
                type="text"
                class="text-input"
                value={String(formState.values[field.key] ?? '')}
                placeholder={field.description || $t('code.question.answerPlaceholder')}
                oninput={(e) => updateScalar(field.key, (e.currentTarget as HTMLInputElement).value)}
              />
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if validationError}
      <p class="validation-error" role="alert">{validationError}</p>
    {/if}
  </div>
</div>

<style>
  .frame {
    container-type: inline-size;
  }
  .question-band {
    --tone: var(--warning);
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin: 0.4375rem 0.4375rem 0;
    padding: 0.625rem 0.75rem;
    border-radius: 0.75rem;
    background: color-mix(in srgb, var(--foreground) 3.5%, var(--composer-surface));
    border: 1px solid var(--float-border);
    box-shadow: var(--control-shadow);
    animation: question-in var(--motion-normal) var(--motion-ease-out) both;
  }
  .header-row {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }
  .glyph {
    display: inline-flex;
    width: 1.75rem;
    height: 1.75rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--tone) 14%, transparent);
    color: var(--tone);
  }
  .heading-text {
    min-width: 0;
    flex: 1;
  }
  .title {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin: 0;
    color: var(--foreground);
    font-size: var(--text-sm);
    font-weight: 600;
    line-height: 1.35;
  }
  .count {
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    font-weight: 400;
    font-variant-numeric: tabular-nums;
  }
  .actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.375rem;
  }
  .actions kbd {
    margin-left: 0.5rem;
    padding: 0;
    border: 0;
    background: none;
    box-shadow: none;
    color: inherit;
    font-family: inherit;
    font-size: var(--text-xs);
    font-weight: 400;
    opacity: 0.55;
  }
  .fields {
    display: flex;
    max-height: 18rem;
    flex-direction: column;
    gap: 0.625rem;
    overflow-y: auto;
    padding-right: 0.125rem;
  }
  .field-block {
    display: flex;
    flex-direction: column;
    gap: 0.3125rem;
  }
  .field-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.375rem;
  }
  .field-title {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--foreground);
  }
  .req {
    margin-left: 0.125rem;
    color: var(--warning);
  }
  .field-desc {
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }
  .options-grid {
    display: flex;
    flex-direction: column;
    gap: 0.1875rem;
  }
  .option-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--foreground);
    text-align: left;
    cursor: pointer;
    transition: background var(--motion-instant) var(--motion-ease);
  }
  .option-row:hover,
  .option-row:focus-visible {
    background: var(--surface-hover);
    outline: none;
  }
  .option-row.is-selected {
    background: color-mix(in srgb, var(--brand-accent) 12%, transparent);
  }
  .radio-dot {
    width: 0.75rem;
    height: 0.75rem;
    flex-shrink: 0;
    border-radius: 9999px;
    border: 1.5px solid var(--muted-foreground);
    transition: border-color var(--motion-instant) var(--motion-ease), background var(--motion-instant) var(--motion-ease);
  }
  .radio-dot.is-selected {
    border-color: var(--brand-accent-strong);
    background: var(--brand-accent-strong);
    box-shadow: inset 0 0 0 2px var(--composer-surface);
  }
  .check-box {
    display: inline-flex;
    width: 0.8125rem;
    height: 0.8125rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.25rem;
    border: 1.5px solid var(--muted-foreground);
    color: var(--background);
    transition: border-color var(--motion-instant) var(--motion-ease), background var(--motion-instant) var(--motion-ease);
  }
  .check-box.is-selected {
    border-color: var(--brand-accent-strong);
    background: var(--brand-accent-strong);
  }
  .opt-text {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.375rem;
  }
  .opt-label {
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--foreground);
  }
  .opt-desc {
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }
  .opt-key {
    flex-shrink: 0;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }
  .text-input {
    width: 100%;
    padding: 0.3125rem 0.5rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--composer-surface);
    color: var(--foreground);
    font-size: var(--text-xs);
    outline: none;
  }
  .text-input:focus {
    border-color: var(--brand-accent-strong);
  }
  .bool-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--text-xs);
    color: var(--foreground);
    cursor: pointer;
  }
  .validation-error {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--error);
  }
  @container (max-width: 32rem) {
    .header-row { flex-wrap: wrap; }
    .actions { width: 100%; justify-content: flex-end; }
  }
  @keyframes question-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    .question-band { animation: none; }
  }
</style>
