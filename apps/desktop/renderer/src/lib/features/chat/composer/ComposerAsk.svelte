<svelte:options runes={true} />

<!--
  The question, on top of the prompt sheet.

  A decision that blocks the turn belongs where the hands already are: the same
  sheet the user types into, one row per answer, the first one Enter. It is not
  a modal (nothing to dismiss), and not a card in the transcript (nothing to
  scroll back to) — the run resumes the moment an option is taken.

  Options are rows, not buttons in a footer: the whole row is the target, the
  key number sits at the edge, and the hint under them spells the grammar.
-->

<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    question,
    detail,
    options,
    hint,
    onanswer
  }: {
    question: string;
    /** The concrete thing being asked about — a command, a path, a reason. */
    detail?: string;
    options: { id: string; label: string; desc?: string }[];
    hint?: Snippet;
    onanswer: (id: string) => void;
  } = $props();

  /*
   * Keys come from the window, not from focus.
   *
   * The question must be answerable while the caret is still in the field, and
   * it must never swallow a keystroke meant for the message: typing wins inside
   * any editable element, everywhere else Enter and the option numbers answer.
   */
  function onKeydown(event: KeyboardEvent) {
    const target = event.target;
    /* The window is a target too: only elements can be inside an editor. */
    if (target instanceof Element && target.closest('textarea, input, select, [contenteditable="true"]')) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      const first = options[0];
      if (first) onanswer(first.id);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      const last = options.at(-1);
      if (last) onanswer(last.id);
      return;
    }
    const index = Number(event.key);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) {
      event.preventDefault();
      const option = options[index - 1];
      if (option) onanswer(option.id);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="ask" role="group" aria-label={question}>
  <p class="ask-q">
    {question}
    {#if detail}<span class="sub">{detail}</span>{/if}
  </p>

  <ul class="options">
    {#each options as option, index (option.id)}
      <li>
        <button class="option" type="button" onclick={() => onanswer(option.id)}>
          <span class="text">
            <span class="label">{option.label}</span>
            {#if option.desc}<span class="desc">{option.desc}</span>{/if}
          </span>
          <span class="key" aria-hidden="true">{index + 1}</span>
        </button>
      </li>
    {/each}
  </ul>

  {#if hint}<p class="hint">{@render hint()}</p>{/if}
</div>

<style>
  /* One tinted block inside the already-ringed sheet: no second border, no
     shadow. It reads as the top of the same object the field belongs to. */
  .ask {
    margin: 0.4375rem 0.4375rem 0;
    padding: 0.625rem 0.625rem 0.5rem;
    border-radius: 1rem;
    background: color-mix(in srgb, var(--foreground) 4%, transparent);
    animation: ask-in var(--motion-normal, 200ms) cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  .ask-q {
    margin: 0 0 0.375rem;
    padding: 0 0.125rem;
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--foreground);
  }
  .ask-q .sub {
    display: block;
    margin-top: 0.125rem;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--text-xs);
    color: var(--muted-foreground);
    overflow-wrap: anywhere;
  }

  .options {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .option {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.625rem;
    padding: 0.4375rem 0.5rem;
    border: 0;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--foreground);
    font: inherit;
    text-align: left;
    cursor: pointer;
    transition: background-color var(--motion-fast, 150ms) var(--motion-ease, ease);
  }
  .option:hover,
  .option:focus-visible {
    background: var(--surface-hover);
    outline: none;
  }
  .option .text {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 1px;
  }
  .option .label {
    font-size: var(--text-sm);
    font-weight: 500;
  }
  .option .desc {
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .option .key {
    flex: none;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10.5px;
    color: var(--muted-foreground);
    opacity: 0;
    transition: opacity var(--motion-fast, 150ms) var(--motion-ease, ease);
  }
  .option:hover .key,
  .option:focus-visible .key {
    opacity: 1;
  }

  .hint {
    margin: 0.375rem 0 0;
    padding: 0 0.125rem;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }

  @keyframes ask-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .ask {
      animation: none;
    }
  }
</style>
