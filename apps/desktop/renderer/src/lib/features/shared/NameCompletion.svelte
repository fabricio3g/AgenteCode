<svelte:options runes={true} />
<script lang="ts">
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import Avatar from '$lib/components/ui/Avatar.svelte';
  import { completionAt, matchNames, replaceCompletion, type NameCandidate } from './name-completion';

  interface Props {
    textarea: HTMLTextAreaElement | undefined;
    text: string;
    candidates: NameCandidate[];
    automatic?: boolean;
    nickname?: boolean;
    onchange: (text: string) => void;
  }
  let { textarea, text, candidates, automatic = false, nickname = false, onchange }: Props = $props();
  let caret = $state(0);
  let focused = $state(false);
  let composing = $state(false);
  let selected = $state(0);
  let dismissed = $state('');
  const range = $derived(focused && !composing ? completionAt(text, caret, automatic) : null);
  const matches = $derived(range && dismissed !== `${text}:${caret}` ? matchNames(candidates, range.query) : []);
  const index = $derived(Math.min(selected, Math.max(0, matches.length - 1)));

  async function complete(candidate: NameCandidate) {
    if (!range || !textarea) return;
    const inserted = replaceCompletion(text, range, `${range.explicit ? '@' : ''}${nickname && candidate.nickname ? candidate.nickname : candidate.name}${candidate.disambiguate ? ` [character:${candidate.id}]` : ''}`);
    dismissed = `${inserted.text}:${inserted.caret}`;
    onchange(inserted.text);
    await tick();
    textarea.focus();
    textarea.setSelectionRange(inserted.caret, inserted.caret);
    caret = inserted.caret;
  }

  $effect(() => {
    const element = textarea;
    if (!element) return;
    const update = () => { caret = element.selectionStart; focused = document.activeElement === element; };
    const input = () => { dismissed = ''; selected = 0; update(); };
    const blur = () => { focused = false; };
    const start = () => { composing = true; };
    const end = () => { composing = false; input(); };
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || composing || !matches.length) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        selected = (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
      } else if ((event.key === 'Tab' || event.key === 'Enter') && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
        void complete(matches[index]);
      } else if (event.key === 'Escape') dismissed = `${text}:${caret}`;
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    element.addEventListener('input', input);
    element.addEventListener('select', update);
    element.addEventListener('click', update);
    element.addEventListener('keyup', update);
    element.addEventListener('focus', update);
    element.addEventListener('blur', blur);
    element.addEventListener('compositionstart', start);
    element.addEventListener('compositionend', end);
    element.addEventListener('keydown', key, true);
    update();
    return () => {
      element.removeEventListener('input', input);
      element.removeEventListener('select', update);
      element.removeEventListener('click', update);
      element.removeEventListener('keyup', update);
      element.removeEventListener('focus', update);
      element.removeEventListener('blur', blur);
      element.removeEventListener('compositionstart', start);
      element.removeEventListener('compositionend', end);
      element.removeEventListener('keydown', key, true);
    };
  });
</script>

{#if matches.length}
  <div class="name-completion" role="listbox" aria-label={$t('completion.label')}>
    {#each matches as candidate, row (candidate.id)}
      <button type="button" role="option" aria-selected={row === index} class="completion-row" class:is-selected={row === index}
        onpointerdown={(event) => event.preventDefault()} onclick={() => void complete(candidate)}>
        <span class="size-7 shrink-0"><Avatar size="fill" name={candidate.name} image={candidate.avatar} /></span>
        <span class="min-w-0 flex-1 truncate">{candidate.name}<small>{candidate.description || candidate.nickname || candidate.id.slice(-8)}</small></span>
      </button>
    {/each}
    <div class="completion-hint">{$t('completion.hint')}</div>
  </div>
{/if}

<style>
  .name-completion { position: absolute; bottom: calc(100% + 0.4rem); left: 0; z-index: var(--z-float); width: min(24rem, 100%); max-height: 20rem; overflow-y: auto; padding: var(--float-pad); border: 1px solid var(--float-border); border-radius: var(--float-radius); background: var(--float-bg); box-shadow: var(--float-shadow); pointer-events: auto; }
  .completion-row { display: flex; align-items: center; gap: 0.65rem; width: 100%; min-height: var(--float-row-h); padding: 0.3125rem 0.625rem; border-radius: var(--float-row-radius); text-align: left; color: var(--foreground); font-size: var(--text-sm); }
  .completion-row:hover, .is-selected { background: var(--float-row-hover); }
  small { display: block; color: var(--muted-foreground); font-size: var(--text-xs); overflow: hidden; text-overflow: ellipsis; }
  .completion-hint { padding: 0.4rem 0.5rem 0.2rem; color: var(--muted-foreground); font-size: var(--text-xs); }
</style>
