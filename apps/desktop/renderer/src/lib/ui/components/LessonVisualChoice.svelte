<svelte:options runes={true} />

<!--
  2x2 visual choice grid: each option renders a miniature SVG curve alongside
  its label and keyboard keycap (1–5), dimming distractors once answered.
-->

<script lang="ts">
  import { Check, X } from '$lib/icons';
  import Button from '$lib/components/ui/Button.svelte';
  import type { LessonChoice } from '$lib/types/chat';
  import { sampleSeries } from './simulation-model';

  interface Props {
    choices: LessonChoice[];
    answeredValue?: string | number;
    readOnly?: boolean;
    onChoose: (choice: LessonChoice) => void;
  }

  let { choices, answeredValue, readOnly = false, onChoose }: Props = $props();

  const answered = $derived(answeredValue !== undefined);

  function miniPath(expr?: string): string {
    if (!expr) return '';
    const pts = sampleSeries({ expression: expr, variable: 'x', from: -3, to: 3, samples: 40 });
    const ys = pts.map((p) => p.y).filter((v) => Number.isFinite(v));
    if (!ys.length) return '';
    const min = Math.min(...ys), max = Math.max(...ys);
    const span = max - min || 1;
    return pts.map((p, i) => {
      const sx = 12 + ((p.x + 3) / 6) * 196;
      const sy = 48 - ((p.y - min) / span) * 38;
      return `${i ? 'L' : 'M'} ${sx.toFixed(1)} ${sy.toFixed(1)}`;
    }).join(' ');
  }
</script>

<div class="vchoices">
  {#each choices as choice, index (index)}
    {@const chosen = answeredValue === choice.text}
    {@const correct = choice.correct === true}
    {@const cls = [
      'vchoice',
      answered && correct ? 'is-correct' : '',
      chosen && !correct ? 'is-wrong' : '',
      answered && !chosen && !correct ? 'is-dim' : ''
    ].filter(Boolean).join(' ')}
    {@const path = miniPath(choice.plot)}
    <div class="vchoice-wrap">
      <Button variant="plain" class={cls} disabled={answered || readOnly} onclick={() => onChoose(choice)}>
        <span class="vchoice-head">
          <span class="vchoice-key" aria-hidden="true">
            {#if answered && correct}<Check class="size-3.5" />{:else if chosen && !correct}<X class="size-3.5" />{:else}{index + 1}{/if}
          </span>
          <span class="vchoice-label">{choice.text}</span>
        </span>
        {#if path}
          <svg class="vchoice-svg" viewBox="0 0 220 56" aria-hidden="true">
            <line x1="10" y1="29" x2="210" y2="29" class="vc-axis" />
            <path d={path} class="vc-curve" class:is-acc={answered && correct} />
          </svg>
        {/if}
      </Button>
      {#if answered && (chosen || correct) && choice.why}
        <p class="vchoice-why" class:is-good={correct}>{choice.why}</p>
      {/if}
    </div>
  {/each}
</div>

<style>
  .vchoices {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.5rem;
  }
  @media (max-width: 520px) { .vchoices { grid-template-columns: 1fr; } }

  .vchoice-wrap { display: flex; flex-direction: column; gap: 0.25rem; }

  .vchoices :global(.vchoice) {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.45rem;
    width: 100%;
    padding: 0.6rem 0.7rem;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--foreground) 3.5%, transparent);
    text-align: left;
    cursor: pointer;
    transition: background-color var(--motion-instant) var(--motion-ease), border-color var(--motion-instant) var(--motion-ease), opacity var(--motion-fast) var(--motion-ease);
  }
  .vchoices :global(.vchoice:hover:not(:disabled)) { background: var(--surface-hover); border-color: var(--border); }
  .vchoices :global(.vchoice.is-dim) { opacity: 0.42; }
  .vchoices :global(.vchoice.is-correct) { border-color: color-mix(in srgb, var(--accent-green-text) 40%, transparent); background: var(--accent-green-bg); }
  .vchoices :global(.vchoice.is-wrong) { border-color: color-mix(in srgb, var(--accent-red-text) 35%, transparent); background: var(--accent-red-bg); }

  .vchoice-head { display: flex; align-items: center; gap: 0.5rem; font-size: var(--text-xs); font-weight: 500; color: var(--foreground); }
  .vchoice-key {
    display: inline-flex; align-items: center; justify-content: center;
    width: 1.25rem; height: 1.25rem; border-radius: 0.3rem; flex-shrink: 0;
    background: color-mix(in srgb, var(--foreground) 6%, transparent);
    color: var(--muted-foreground); font-family: var(--font-mono); font-size: var(--text-xs);
  }
  .vchoice-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .vchoice-svg { display: block; width: 100%; height: auto; }
  .vc-axis { stroke: var(--border); stroke-dasharray: 2 3; }
  .vc-curve { fill: none; stroke: var(--foreground); stroke-width: 1.8; stroke-linecap: round; }
  .vc-curve.is-acc { stroke: var(--accent-green-text); }

  .vchoice-why { margin: 0 0.2rem; font-size: var(--text-xs); color: var(--text-secondary); line-height: 1.45; }
  .vchoice-why.is-good { color: var(--accent-green-text); }
</style>
