
<svelte:options runes={true} />

<!--
  A card text field that speaks in names.

  "Insert name" puts {{char}} or {{user}} at the caret instead of asking the
  writer to remember the syntax, and the line under the field shows the text as
  it will read with the current names. Text is stored raw; only the preview
  resolves.
-->

<script lang="ts">
  import UiInput from '$lib/components/ui/Input.svelte';
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { untrack } from 'svelte';
  import { Button } from '$lib/components/ui';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { Eye, UserRound } from 'lucide-svelte';
  import { resolveMacros } from '$lib/services/roleplay-macros';
  import { t } from 'svelte-i18n';

  interface Props {
    value: string;
    onchange: (value: string) => void;
    label: string;
    hint?: string;
    placeholder?: string;
    rows?: number;
    /** The names the preview and the inserted macros resolve against. */
    char: string;
    user: string;
    /** Single-line input instead of a textarea. */
    single?: boolean;
    id?: string;
  }

  let {
    value,
    onchange,
    label,
    hint = '',
    placeholder = '',
    rows = 4,
    char,
    user,
    single = false,
    id = undefined
  }: Props = $props();

  let field = $state<HTMLTextAreaElement | HTMLInputElement | null>(null);
  let menuOpen = $state(false);
  const fieldId = untrack(() => id ?? `macro-field-${Math.random().toString(36).slice(2, 8)}`);

  const preview = $derived(value.includes('{{') ? resolveMacros(value, { char: char || '…', user: user || '…' }) : '');

  function insert(macro: 'char' | 'user') {
    const token = `{{${macro}}}`;
    const start = field?.selectionStart ?? value.length;
    const end = field?.selectionEnd ?? start;
    const next = value.slice(0, start) + token + value.slice(end);
    onchange(next);
    requestAnimationFrame(() => {
      if (!field) return;
      field.focus();
      field.setSelectionRange(start + token.length, start + token.length);
    });
  }
</script>

<div class="macro-field">
  <div class="field-head">
    <label class="field-label" for={fieldId}>{label}</label>
    <Menu bind:open={menuOpen} placement="bottom-end" label={$t('roleplay.macro.insert')}>
      {#snippet trigger(props)}
        <Button variant="ghost" size="xs" class="insert-trigger" {...props}>
          <UserRound class="size-3" />
          <span>{$t('roleplay.macro.insert')}</span>
        </Button>
      {/snippet}
      <MenuItem label={$t('roleplay.macro.char')} description={$t('roleplay.macro.charHint')} onselect={() => insert('char')} />
      <MenuItem label={$t('roleplay.macro.user')} description={$t('roleplay.macro.userHint')} onselect={() => insert('user')} />
    </Menu>
  </div>
  {#if hint}<p class="field-hint">{hint}</p>{/if}
  {#if single}
    <UiInput
      id={fieldId}
      bind:ref={() => field as HTMLInputElement | undefined, node => { field = node ?? null; }}
      class={uiClass("", "ui-local-63bc9ae0")}
      {value}
      {placeholder}
      oninput={(event) => onchange(event.currentTarget.value)}
    />
  {:else}
    <UiTextarea
      id={fieldId}
      bind:ref={() => field as HTMLTextAreaElement | undefined, node => { field = node ?? null; }}
      class={uiClass(" field-area", "ui-local-63bc9ae0")}
      {rows}
      {value}
      {placeholder}
      oninput={(event) => onchange(event.currentTarget.value)}
    ></UiTextarea>
  {/if}
  {#if preview}
    <p class="preview" aria-live="polite">
      <Eye class="size-3 shrink-0" />
      <span class="preview-text">{preview}</span>
    </p>
  {/if}
</div>

<style>
  .macro-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    min-width: 0;
  }

  .field-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  .field-label {
    flex: 1;
    min-width: 0;
    color: var(--text-secondary);
    font-size: var(--text-sm);
    font-weight: 500;
  }

  :global(.insert-trigger) {
    height: 1.5rem;
    padding-inline: 0.45rem;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }

  .field-hint {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.45;
  }

  :global(.field-area.ui-local-63bc9ae0) {
    min-height: 4.5rem;
    resize: vertical;
  }

  .preview {
    display: flex;
    align-items: flex-start;
    gap: 0.35rem;
    margin: 0;
    padding: 0.35rem 0.5rem;
    border-radius: var(--radius-md);
    background: var(--surface-hover);
    color: var(--text-muted);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  .preview :global(svg) {
    margin-top: 0.15rem;
  }

  .preview-text {
    display: -webkit-box;
    min-width: 0;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    white-space: pre-wrap;
  }
</style>
