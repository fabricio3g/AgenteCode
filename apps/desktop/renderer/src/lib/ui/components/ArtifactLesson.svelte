<svelte:options runes={true} />

<!--
  An interactive lesson: one block at a time, a rail of ticks, and a footer that
  always has exactly one obvious next action.

  Nothing here counts, grades or rewards. There is no score, no streak, no
  percentage, no progress ring — the only thing kept between visits is which
  block you were on.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import type { LessonArtifactPayload, LessonBlock, LessonChoice } from '$lib/types/chat';
  import { appStore } from '$lib/stores/app.svelte';
  import {
    answerFor,
    buildStuckMessage,
    canAdvance,
    createLessonState,
    hintLadderStep,
    isQuestion,
    reduceLesson,
    type LessonState
  } from './lesson-runner';
  import { loadLessonProgress, lessonProgressKey, saveLessonProgress } from './lesson-progress';
  import LessonExplore from './LessonExplore.svelte';
  import LessonPredict from './LessonPredict.svelte';
  import ChartBlock from '$lib/features/chat/ChartBlock.svelte';
  import ArtifactDiagram from './ArtifactDiagram.svelte';
  import ArtifactInfoCard from './ArtifactInfoCard.svelte';
  import { renderMarkdown } from '$lib/utils/markdown';
  import Button from '$lib/components/ui/Button.svelte';
  import Input from '$lib/components/ui/Input.svelte';

  interface Props {
    payload: LessonArtifactPayload;
    /** Artifact path, so progress follows the lesson and not the chat. */
    entryKey?: string;
    /** Static poster for library thumbnails: no controls, no interactions. */
    poster?: boolean;
    /** Another space opened this from the library: read it, do not work it. */
    readOnly?: boolean;
  }

  let { payload, entryKey, poster = false, readOnly = false }: Props = $props();

  const blocks = $derived<LessonBlock[]>(Array.isArray(payload.blocks) ? payload.blocks : []);
  const progressKey = $derived(lessonProgressKey(payload.title, entryKey));

  let lessonState = $state<LessonState>(createLessonState(0));
  let resumed = false;

  $effect(() => {
    if (resumed || poster) return;
    resumed = true;
    const stored = loadLessonProgress(progressKey);
    const index = stored === null ? 0 : Math.min(stored, Math.max(0, blocks.length - 1));
    lessonState = createLessonState(index);
  });

  $effect(() => {
    if (poster || lessonState.index <= 0) return;
    saveLessonProgress(progressKey, lessonState.index);
  });

  const current = $derived<LessonBlock | undefined>(blocks[lessonState.index]);
  const answered = $derived(answerFor(lessonState, lessonState.index));
  const helpLevel = $derived(hintLadderStep(lessonState, lessonState.index));
  const isPractice = $derived(payload.mode === 'practice');

  let numericDraft = $state('');
  let stepsShown = $state(0);
  $effect(() => {
    // Reset per-block drafts without touching the reducer.
    void lessonState.index;
    numericDraft = '';
    stepsShown = 0;
  });

  const markdown = (source: string) => renderMarkdown(source || '', { math: true });
  const formula = (source: string) => renderMarkdown(`$$${source}$$`, { math: true });

  function edit(where: string, text: string) {
    appStore.updateComposer(text);
    window.dispatchEvent(new Event('focus-composer'));
    void where;
  }

  function answerWith(index: number, value: string | number, correct: boolean) {
    if (readOnly) return;
    lessonState = reduceLesson(lessonState, { type: 'answer', index, value, correct });
  }

  function next() {
    if (!canAdvance(lessonState, current)) return;
    lessonState = reduceLesson(lessonState, { type: 'next', count: blocks.length });
  }

  function back() {
    lessonState = reduceLesson(lessonState, { type: 'back' });
  }

  function askHelp() {
    edit('stuck', buildStuckMessage({ title: payload.title, index: lessonState.index, blocks, state: lessonState, block: current }));
  }

  function choiceClass(chosen: boolean, correct: boolean, answeredNow: boolean): string {
    return ['choice', chosen ? 'is-chosen' : '', answeredNow && correct ? 'is-correct' : '', chosen && !correct ? 'is-wrong' : '']
      .filter(Boolean)
      .join(' ');
  }

  function chooseChoice(choice: LessonChoice, index: number) {
    if (answered || readOnly) return;
    answerWith(lessonState.index, choice.text, choice.correct === true);
  }

  function submitNumeric(block: Extract<LessonBlock, { type: 'numeric' }>) {
    const value = Number(numericDraft.replace(',', '.'));
    if (!Number.isFinite(value)) return;
    const tolerance = block.tolerance ?? 0;
    answerWith(lessonState.index, value, Math.abs(value - block.answer) <= tolerance);
  }

  function submitPretestNumeric(block: Extract<LessonBlock, { type: 'pretest' }>) {
    const numeric = block.numeric;
    if (!numeric) return;
    const value = Number(numericDraft.replace(',', '.'));
    if (!Number.isFinite(value)) return;
    const tolerance = numeric.tolerance ?? 0;
    answerWith(lessonState.index, value, Math.abs(value - numeric.answer) <= tolerance);
  }

  function onKeydown(event: KeyboardEvent) {
    if (poster || readOnly) return;
    const target = event.target as HTMLElement | null;
    const typing = !!target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
    if (event.key === 'ArrowRight' && !typing) { event.preventDefault(); next(); return; }
    if (event.key === 'ArrowLeft' && !typing) { event.preventDefault(); back(); return; }
    if (typing) return;
    if (/^[1-5]$/.test(event.key) && current && (current.type === 'choice' || current.type === 'pretest')) {
      const choices = current.choices ?? [];
      const choice = choices[Number(event.key) - 1];
      if (choice) { event.preventDefault(); chooseChoice(choice, Number(event.key) - 1); }
    }
    if (event.key === 'Enter' && !typing) { event.preventDefault(); next(); }
  }
</script>

{#if poster}
  <div class="lesson-poster">
    <p class="poster-title">{payload.title}</p>
    {#if payload.subtitle}<p class="poster-subtitle">{payload.subtitle}</p>{/if}
    <p class="poster-meta">{blocks.length} {isPractice ? $t('artifacts.lesson.exercises') : $t('artifacts.lesson.steps')}</p>
  </div>
{:else}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <section
    class="lesson"
    class:is-practice={isPractice}
    tabindex="0"
    role="application"
    aria-label={payload.title}
    onkeydown={onKeydown}
  >
    <header class="lesson-header">
      <div class="lesson-heading">
        <h3 class="lesson-title">{payload.title}</h3>
        {#if payload.subtitle}<p class="lesson-subtitle">{payload.subtitle}</p>{/if}
      </div>
      <span class="lesson-position">{lessonState.index + 1} / {blocks.length}</span>
    </header>

    <div class="lesson-body">
      <ol class="lesson-rail" aria-hidden="true">
        {#each blocks as _block, index}
          <li class:is-current={index === lessonState.index} class:is-done={index < lessonState.index}></li>
        {/each}
      </ol>

      <div class="lesson-block" class:scrolls={!!$t('artifacts.lesson.steps')}>
        {#if current}
          {@const blockPrompt = 'prompt' in current ? current.prompt : ''}
          {#if blockPrompt}
            <p class="lesson-prompt">{blockPrompt}</p>
          {/if}

          {#if 'formula' in current && current.formula}
            <div class="lesson-formula">{@html formula(current.formula)}</div>
          {/if}

          {#if current.type === 'choice' || current.type === 'pretest'}
            {@const choices = current.choices ?? []}
            {#if choices.length}
              <ul class="choices">
                {#each choices as choice, index (index)}
                  {@const chosen = answered?.value === choice.text}
                  {@const correct = choice.correct === true}
                  <li>
                    <Button
                      variant="ghost"
                      class={choiceClass(chosen, correct, !!answered)}
                      disabled={!!answered || readOnly}
                      onclick={() => chooseChoice(choice, index)}
                    >
                      <span class="choice-key">{index + 1}</span>
                      <span class="choice-text">{choice.text}</span>
                    </Button>
                    {#if answered && (chosen || correct) && choice.why}
                      <p class="choice-why" class:is-good={correct}>{choice.why}</p>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else if current.type === 'pretest' && current.numeric}
              <div class="numeric">
                <Input
                  class="answer"
                  inputmode="decimal"
                  bind:value={numericDraft}
                  disabled={!!answered || readOnly}
                  aria-label={$t('artifacts.lesson.yourAnswer')}
                  onkeydown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); submitPretestNumeric(current); } }}
                />
                <Button size="sm" disabled={!!answered || readOnly} onclick={() => submitPretestNumeric(current)}>
                  {$t('artifacts.lesson.check')}
                </Button>
              </div>
            {/if}
            {#if answered && current.type === 'pretest' && current.why}
              <p class="lesson-note">{current.why}</p>
            {/if}
          {:else if current.type === 'numeric'}
            <div class="numeric">
              <Input
                class="answer"
                inputmode="decimal"
                bind:value={numericDraft}
                disabled={!!answered || readOnly}
                aria-label={$t('artifacts.lesson.yourAnswer')}
                onkeydown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); submitNumeric(current); } }}
              />
              {#if current.unit}<span class="unit">{current.unit}</span>{/if}
              <Button size="sm" disabled={!!answered || readOnly} onclick={() => submitNumeric(current)}>
                {$t('artifacts.lesson.check')}
              </Button>
            </div>
          {:else if current.type === 'explore'}
            <LessonExplore model={current.model} insight={current.insight} {readOnly} />
          {:else if current.type === 'predict'}
            <LessonPredict
              expression={current.expression}
              series={current.series}
              xRange={current.xRange}
              yRange={current.yRange}
              label={current.label}
              insight={current.insight}
              {readOnly}
              onSettle={() => answerWith(lessonState.index, 'drawn', true)}
            />
          {:else if current.type === 'steps'}
            <ol class="steps">
              {#each current.steps as step, index (index)}
                {#if index <= stepsShown}
                  <li>
                    <span class="step-note">{step.note}</span>
                    {#if step.formula}<span class="step-formula">{@html formula(step.formula)}</span>{/if}
                  </li>
                {/if}
              {/each}
            </ol>
            {#if stepsShown < current.steps.length - 1}
              <Button variant="ghost" size="sm" onclick={() => (stepsShown += 1)}>
                {$t('artifacts.lesson.nextStep')}
              </Button>
            {/if}
          {:else if current.type === 'reveal'}
            <details class="reveal">
              <summary>{current.prompt}</summary>
              <div class="reveal-body">{@html markdown(current.body)}</div>
            </details>
          {:else if current.type === 'figure'}
            {#if current.chart}
              <ChartBlock type={current.chart.chartType ?? 'bar'} title={current.chart.title ?? ''} raw={JSON.stringify(current.chart)} variant="artifact" />
            {:else if current.diagram}
              <ArtifactDiagram payload={{ kind: 'diagram', title: current.diagram.title ?? '', source: current.diagram.source, diagramType: current.diagram.diagramType }} />
            {:else if current.infoCard}
              <ArtifactInfoCard payload={{ ...current.infoCard, kind: 'info_card' }} />
            {/if}
          {:else if current.type === 'summary'}
            <ul class="summary-points">
              {#each current.points as point (point)}
                <li>{@html markdown(point)}</li>
              {/each}
            </ul>
            {#if current.next?.length}
              <div class="next-chips">
                {#each current.next as question (question)}
                  <Button variant="ghost" size="xs" class="chip" onclick={() => edit('next', question)}>{question}</Button>
                {/each}
              </div>
            {/if}
          {/if}

          {#if !isPractice && helpLevel > 0 && isQuestion(current)}
            {#if helpLevel >= 2 && 'hint' in current && current.hint}
              <p class="lesson-note">{current.hint}</p>
            {/if}
          {/if}
        {/if}
      </div>
    </div>

    <footer class="lesson-footer">
      {#if !isPractice && isQuestion(current)}
        <Button variant="ghost" size="sm" onclick={askHelp} disabled={readOnly}>
          {$t('artifacts.lesson.stuck')}
        </Button>
      {/if}
      <span class="spacer"></span>
      {#if lessonState.index > 0}
        <Button variant="ghost" size="sm" onclick={back}>{$t('artifacts.lesson.back')}</Button>
      {/if}
      {#if lessonState.index < blocks.length - 1}
        <Button size="sm" onclick={next} disabled={!canAdvance(lessonState, current)}>
          {$t('artifacts.lesson.continue')}
        </Button>
      {/if}
    </footer>
  </section>
{/if}

<style>
  .lesson {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    width: var(--inline-block-width, 100%);
    max-width: 100%;
    margin-top: 0.65rem;
    padding: 0.85rem 0.95rem;
    border-radius: var(--artifact-radius, 12px);
    background: var(--artifact-surface, var(--card));
    outline: none;
  }

  .lesson:focus-visible {
    box-shadow: 0 0 0 2px var(--border);
  }

  .lesson-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .lesson-heading { min-width: 0; }

  .lesson-title {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: -0.015em;
  }

  .lesson-subtitle {
    margin: 0.1rem 0 0;
    font-size: var(--text-xs);
    color: var(--text-tertiary, var(--text-secondary));
  }

  .lesson-position {
    font-size: var(--text-xs);
    color: var(--text-tertiary, var(--text-secondary));
    font-variant-numeric: tabular-nums;
  }

  .lesson-body {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.8rem;
    align-items: start;
  }

  .lesson-rail {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0;
    padding: 0.15rem 0;
    list-style: none;
  }

  .lesson-rail li {
    width: 3px;
    height: 0.55rem;
    border-radius: 2px;
    background: var(--border-subtle);
    transition: background-color var(--motion-fast) var(--motion-ease);
  }

  .lesson-rail li.is-done { background: var(--border); }
  .lesson-rail li.is-current { background: var(--chart-1, var(--foreground)); }

  .lesson-block {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    min-width: 0;
    max-height: min(56vh, 460px);
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
  }

  .lesson-prompt {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.55;
  }

  .lesson-formula { overflow-x: auto; }

  .choices { display: flex; flex-direction: column; gap: 0.35rem; margin: 0; padding: 0; list-style: none; }

  .lesson :global(.choice) {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
    width: 100%;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
    transition: background-color var(--motion-fast) var(--motion-ease), border-color var(--motion-fast) var(--motion-ease);
  }

  .lesson :global(.choice:hover:not(:disabled)) { background: var(--muted); }
  .lesson :global(.choice:disabled) { cursor: default; }
  .lesson :global(.choice.is-chosen) { border-color: var(--border); }
  .lesson :global(.choice.is-correct) { border-color: var(--accent-green-text); background: var(--accent-green-bg); }
  .lesson :global(.choice.is-wrong) { background: var(--accent-red-bg); border-color: transparent; }

  .choice-key {
    font-size: var(--text-xs);
    color: var(--text-tertiary, var(--text-secondary));
    font-variant-numeric: tabular-nums;
    min-width: 0.8rem;
  }

  .choice-text { flex: 1; }

  .choice-why {
    margin: 0.2rem 0 0.3rem 1.35rem;
    font-size: var(--text-xs);
    color: var(--text-secondary);
  }

  .choice-why.is-good { color: var(--accent-green-text); }

  .numeric { display: flex; align-items: center; gap: 0.5rem; }

  .lesson :global(.answer) {
    width: 8rem;
    font-variant-numeric: tabular-nums;
  }

  .unit { font-size: var(--text-xs); color: var(--text-secondary); }

  .steps { display: flex; flex-direction: column; gap: 0.5rem; margin: 0; padding-left: 1.1rem; }
  .steps li { display: flex; flex-direction: column; gap: 0.15rem; font-size: var(--text-sm); }
  .step-note { color: var(--text-secondary); }
  .step-formula { overflow-x: auto; }

  .reveal { font-size: var(--text-sm); }
  .reveal summary { cursor: pointer; }
  .reveal-body { margin-top: 0.4rem; color: var(--text-secondary); }

  .summary-points { margin: 0; padding-left: 1.1rem; font-size: var(--text-sm); }
  .summary-points li { margin-bottom: 0.25rem; }

  .next-chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }

  .lesson :global(.chip) {
    height: 1.7rem;
    padding: 0 0.6rem;
    border: 0;
    border-radius: 999px;
    background: var(--muted);
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .lesson :global(.chip:hover) { color: var(--foreground); }

  .lesson-note {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-tertiary, var(--text-secondary));
  }

  .lesson-footer {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-top: 0.15rem;
  }

  .spacer { flex: 1; }

  .lesson-poster {
    width: var(--inline-block-width, 100%);
    margin-top: 0.65rem;
    padding: 0.75rem 0.85rem;
    border-radius: var(--artifact-radius, 12px);
    background: var(--artifact-surface, var(--card));
  }

  .poster-title { margin: 0; font-size: var(--text-sm); font-weight: 600; }
  .poster-subtitle { margin: 0.15rem 0 0; font-size: var(--text-xs); color: var(--text-secondary); }
  .poster-meta { margin: 0.35rem 0 0; font-size: var(--text-xs); color: var(--text-tertiary, var(--text-secondary)); }

  @media (max-width: 520px) {
    .lesson-body { grid-template-columns: 1fr; }
    .lesson-rail { flex-direction: row; }
    .lesson-rail li { height: 3px; width: 0.7rem; }
  }

  @media (prefers-reduced-motion: reduce) {
    .lesson-rail li, .lesson :global(.choice) { transition: none; }
  }
</style>
