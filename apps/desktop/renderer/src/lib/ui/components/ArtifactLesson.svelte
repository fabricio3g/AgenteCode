<svelte:options runes={true} />

<!--
  An interactive lesson or practice set: one block at a time, a minimal
  segmented track across the top, and a quiet footer with one obvious next
  action.

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
  import LessonGraphChallenge from './LessonGraphChallenge.svelte';
  import LessonVisualChoice from './LessonVisualChoice.svelte';
  import LessonHotspot from './LessonHotspot.svelte';
  import LessonTimeline from './LessonTimeline.svelte';
  import LessonAlgoStepper from './LessonAlgoStepper.svelte';
  import ChartBlock from '$lib/features/chat/ChartBlock.svelte';
  import ArtifactDiagram from './ArtifactDiagram.svelte';
  import ArtifactInfoCard from './ArtifactInfoCard.svelte';
  import VizHeading from './VizHeading.svelte';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { ArrowLeft, ArrowRight, Check, ListChecks, X } from '$lib/icons';
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

  function gotoBlock(index: number) {
    if (readOnly || index === lessonState.index || index > lessonState.index) return;
    lessonState = reduceLesson(lessonState, { type: 'goto', index, count: blocks.length });
  }

  function askHelp() {
    edit('stuck', buildStuckMessage({ title: payload.title, index: lessonState.index, blocks, state: lessonState, block: current }));
  }

  function choiceClass(chosen: boolean, correct: boolean, answeredNow: boolean): string {
    return [
      'choice',
      chosen ? 'is-chosen' : '',
      answeredNow && correct ? 'is-correct' : '',
      chosen && !correct ? 'is-wrong' : '',
      answeredNow && !chosen && !correct ? 'is-dim' : ''
    ]
      .filter(Boolean)
      .join(' ');
  }

  function chooseChoice(choice: LessonChoice) {
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
    if (/^[1-5]$/.test(event.key) && current && (current.type === 'choice' || current.type === 'visual_choice' || current.type === 'pretest')) {
      const choices = current.choices ?? [];
      const choice = choices[Number(event.key) - 1];
      if (choice) { event.preventDefault(); chooseChoice(choice); }
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
    class="viz-surface lesson"
    class:is-practice={isPractice}
    tabindex="0"
    role="application"
    aria-label={payload.title}
    onkeydown={onKeydown}
  >
    <header class="viz-header lesson-header">
      <VizHeading
        kind="lesson"
        icon={isPractice ? ListChecks : undefined}
        title={payload.title}
        subtitle={payload.subtitle}
      />
      <span class="lesson-position" aria-live="polite">{lessonState.index + 1} / {blocks.length}</span>
    </header>

    {#if blocks.length > 1}
      <div class="lesson-track" role="presentation">
        {#each blocks as _block, index (index)}
          {@const done = index < lessonState.index}
          {@const active = index === lessonState.index}
          <Button
            variant="plain"
            type="button"
            class={`lesson-segment${done ? ' is-done' : ''}${active ? ' is-current' : ''}`}
            disabled={!done || readOnly}
            tabindex={done && !readOnly ? 0 : -1}
            aria-label={`${index + 1} / ${blocks.length}`}
            onclick={() => gotoBlock(index)}
          />
        {/each}
      </div>
    {/if}

    <div class="lesson-block">
      {#if current}
        {@const blockPrompt = 'prompt' in current ? current.prompt : ''}
        {#if blockPrompt && current.type !== 'reveal'}
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
                    variant="plain"
                    class={choiceClass(chosen, correct, !!answered)}
                    disabled={!!answered || readOnly}
                    onclick={() => chooseChoice(choice)}
                  >
                    <span class="choice-key" aria-hidden="true">
                      {#if answered && correct}
                        <Check class="size-3.5" />
                      {:else if chosen && !correct}
                        <X class="size-3.5" />
                      {:else}
                        {index + 1}
                      {/if}
                    </span>
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
                placeholder="0"
                bind:value={numericDraft}
                disabled={!!answered || readOnly}
                aria-label={$t('artifacts.lesson.yourAnswer')}
                onkeydown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); submitPretestNumeric(current); } }}
              />
              <Button size="sm" disabled={!!answered || readOnly || !numericDraft.trim()} onclick={() => submitPretestNumeric(current)}>
                {$t('artifacts.lesson.check')}
              </Button>
            </div>
            {#if answered}
              <p class="numeric-feedback" class:is-good={answered.correct} class:is-wrong={!answered.correct}>
                {#if answered.correct}
                  <Check class="size-3.5 shrink-0" />
                  <span>{current.numeric.answer}</span>
                {:else}
                  <X class="size-3.5 shrink-0" />
                  <span>{current.numeric.answer}</span>
                {/if}
              </p>
            {/if}
          {/if}
          {#if answered && current.type === 'pretest' && current.why}
            <p class="lesson-note">{current.why}</p>
          {/if}
        {:else if current.type === 'numeric'}
          <div class="numeric">
            <Input
              class="answer"
              inputmode="decimal"
              placeholder="0"
              bind:value={numericDraft}
              disabled={!!answered || readOnly}
              aria-label={$t('artifacts.lesson.yourAnswer')}
              onkeydown={(event) => { if (event.key === 'Enter') { event.stopPropagation(); submitNumeric(current); } }}
            />
            {#if current.unit}<span class="unit">{current.unit}</span>{/if}
            <Button size="sm" disabled={!!answered || readOnly || !numericDraft.trim()} onclick={() => submitNumeric(current)}>
              {$t('artifacts.lesson.check')}
            </Button>
          </div>
          {#if answered}
            <p class="numeric-feedback" class:is-good={answered.correct} class:is-wrong={!answered.correct}>
              {#if answered.correct}
                <Check class="size-3.5 shrink-0" />
                <span>{current.answer}{#if current.unit} {current.unit}{/if}</span>
              {:else}
                <X class="size-3.5 shrink-0" />
                <span>{current.answer}{#if current.unit} {current.unit}{/if}</span>
              {/if}
            </p>
          {/if}
        {:else if current.type === 'visual_choice'}
          <LessonVisualChoice
            choices={current.choices ?? []}
            answeredValue={answered?.value}
            {readOnly}
            onChoose={(choice) => chooseChoice(choice)}
          />
        {:else if current.type === 'graph_challenge'}
          <LessonGraphChallenge
            expression={current.expression}
            xRange={current.xRange}
            initialX={current.initialX}
            metric={current.metric}
            target={current.target}
            tolerance={current.tolerance}
            explanation={current.explanation}
            {readOnly}
            onAnswer={(value, correct) => answerWith(lessonState.index, value, correct)}
          />
        {:else if current.type === 'hotspot_diagram'}
          <LessonHotspot pins={current.pins ?? []} />
        {:else if current.type === 'timeline_story'}
          <LessonTimeline eras={current.eras ?? []} />
        {:else if current.type === 'algo_stepper'}
          <LessonAlgoStepper data={current.data ?? []} steps={current.steps ?? []} />
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
                  <span class="step-index">{index + 1}</span>
                  <div class="step-content">
                    <span class="step-note">{step.note}</span>
                    {#if step.formula}<div class="step-formula">{@html formula(step.formula)}</div>{/if}
                  </div>
                </li>
              {/if}
            {/each}
          </ol>
          {#if stepsShown < current.steps.length - 1}
            <div class="steps-action">
              <Button variant="ghost" size="sm" onclick={() => (stepsShown += 1)}>
                {$t('artifacts.lesson.nextStep')}
              </Button>
            </div>
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
                <Button variant="plain" size="xs" class="chip" onclick={() => edit('next', question)}>
                  <span>{question}</span>
                  <ArrowRight class="size-3 shrink-0 opacity-60" />
                </Button>
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

    <footer class="lesson-footer">
      {#if !isPractice && isQuestion(current)}
        <Button variant="ghost" size="sm" onclick={askHelp} disabled={readOnly}>
          {$t('artifacts.lesson.stuck')}
        </Button>
      {/if}
      <span class="spacer"></span>
      {#if lessonState.index > 0}
        <Button variant="ghost" size="sm" onclick={back}>
          <ArrowLeft class="size-3.5" />
          <span>{$t('artifacts.lesson.back')}</span>
        </Button>
      {/if}
      {#if lessonState.index < blocks.length - 1}
        <Button size="sm" onclick={next} disabled={!canAdvance(lessonState, current)}>
          <span>{$t('artifacts.lesson.continue')}</span>
          <ArrowRight class="size-3.5" />
        </Button>
      {/if}
    </footer>
  </section>
{/if}

<style>
  .lesson {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    outline: none;
  }

  .lesson:focus-visible {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand-accent) 45%, transparent);
  }

  .lesson-header {
    align-items: center;
    margin-bottom: 0;
  }

  .lesson-position {
    flex-shrink: 0;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--muted-foreground);
    font-variant-numeric: tabular-nums;
  }

  /* Minimal horizontal segmented track: full width, zero visual clutter. */
  .lesson-track {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    gap: 0.25rem;
    padding: 0;
  }

  .lesson :global(.lesson-segment) {
    height: 3px;
    min-height: 0;
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: color-mix(in srgb, var(--foreground) 10%, transparent);
    cursor: default;
    transition: background-color var(--motion-fast) var(--motion-ease), opacity var(--motion-fast) var(--motion-ease);
  }

  .lesson :global(.lesson-segment.is-done) {
    background: color-mix(in srgb, var(--foreground) 34%, transparent);
    cursor: pointer;
  }

  .lesson :global(.lesson-segment.is-done:hover) {
    background: color-mix(in srgb, var(--foreground) 58%, transparent);
  }

  .lesson :global(.lesson-segment.is-current) {
    background: var(--brand-accent, var(--foreground));
  }

  .lesson.is-practice :global(.lesson-segment.is-current) {
    background: var(--foreground);
  }

  .lesson-block {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
    max-height: min(56vh, 460px);
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
  }

  .lesson-prompt {
    margin: 0;
    color: var(--foreground);
    font-size: var(--text-sm);
    font-weight: 450;
    line-height: 1.6;
  }

  .lesson-formula {
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--foreground) 3%, transparent);
    overflow-x: auto;
  }

  .choices {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .lesson :global(.choice) {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    min-height: 2.5rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--foreground) 3.5%, transparent);
    color: var(--foreground);
    font: inherit;
    font-size: var(--text-sm);
    line-height: 1.45;
    text-align: left;
    cursor: pointer;
    transition:
      background-color var(--motion-instant) var(--motion-ease),
      border-color var(--motion-instant) var(--motion-ease),
      opacity var(--motion-fast) var(--motion-ease);
  }

  .lesson :global(.choice:hover:not(:disabled)) {
    background: var(--surface-hover);
    border-color: color-mix(in srgb, var(--foreground) 10%, transparent);
  }

  .lesson :global(.choice:active:not(:disabled)) {
    background: color-mix(in srgb, var(--foreground) 9%, transparent);
  }

  .lesson :global(.choice:disabled) { cursor: default; }
  .lesson :global(.choice.is-dim) { opacity: 0.48; }
  .lesson :global(.choice.is-chosen) { border-color: color-mix(in srgb, var(--foreground) 16%, transparent); }
  .lesson :global(.choice.is-correct) {
    border-color: color-mix(in srgb, var(--accent-green-text) 40%, transparent);
    background: var(--accent-green-bg);
  }
  .lesson :global(.choice.is-wrong) {
    border-color: color-mix(in srgb, var(--accent-red-text) 35%, transparent);
    background: var(--accent-red-bg);
  }

  .choice-key {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    flex-shrink: 0;
    border-radius: 0.375rem;
    background: color-mix(in srgb, var(--foreground) 6%, transparent);
    color: var(--muted-foreground);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .lesson :global(.choice.is-correct .choice-key) {
    background: color-mix(in srgb, var(--accent-green-text) 16%, transparent);
    color: var(--accent-green-text);
  }

  .lesson :global(.choice.is-wrong .choice-key) {
    background: color-mix(in srgb, var(--accent-red-text) 16%, transparent);
    color: var(--accent-red-text);
  }

  .choice-text { flex: 1; min-width: 0; }

  .choice-why {
    margin: 0.3rem 0 0.2rem 2.75rem;
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--text-secondary);
  }

  .choice-why.is-good { color: var(--accent-green-text); }

  .numeric {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .lesson :global(.answer) {
    width: 9.5rem;
    font-variant-numeric: tabular-nums;
  }

  .unit {
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }

  .numeric-feedback {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    margin: 0;
    padding: 0.3rem 0.625rem;
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    align-self: flex-start;
  }

  .numeric-feedback.is-good {
    background: var(--accent-green-bg);
    color: var(--accent-green-text);
  }

  .numeric-feedback.is-wrong {
    background: var(--accent-red-bg);
    color: var(--accent-red-text);
  }

  .steps {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .steps li {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    font-size: var(--text-sm);
  }

  .step-index {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    flex-shrink: 0;
    margin-top: 0.05rem;
    border-radius: 999px;
    background: color-mix(in srgb, var(--foreground) 6%, transparent);
    color: var(--muted-foreground);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
  }

  .step-content {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
    flex: 1;
  }

  .step-note { color: var(--text-secondary); line-height: 1.5; }
  .step-formula { overflow-x: auto; }
  .steps-action { display: flex; }

  .reveal {
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--foreground) 3%, transparent);
    padding: 0.625rem 0.8rem;
    font-size: var(--text-sm);
  }

  .reveal summary {
    cursor: pointer;
    font-weight: 500;
    color: var(--foreground);
    list-style: none;
  }

  .reveal summary::-webkit-details-marker { display: none; }
  .reveal summary::after {
    content: '+';
    float: right;
    color: var(--muted-foreground);
    transition: transform var(--motion-fast) var(--motion-ease);
  }
  .reveal[open] summary::after { transform: rotate(45deg); }
  .reveal-body { margin-top: 0.5rem; color: var(--text-secondary); line-height: 1.6; }

  .summary-points {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin: 0;
    padding-left: 1.15rem;
    font-size: var(--text-sm);
    line-height: 1.55;
    color: var(--text-secondary);
  }

  .next-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    padding-top: 0.25rem;
  }

  .lesson :global(.chip) {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    height: 1.85rem;
    padding: 0 0.7rem;
    border: 1px solid transparent;
    border-radius: 999px;
    background: color-mix(in srgb, var(--foreground) 4%, transparent);
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-xs);
    font-weight: 500;
    cursor: pointer;
    transition: background-color var(--motion-instant) var(--motion-ease), color var(--motion-instant) var(--motion-ease);
  }

  .lesson :global(.chip:hover) {
    background: var(--surface-hover);
    color: var(--foreground);
  }

  .lesson-note {
    margin: 0;
    padding: 0.5rem 0.7rem;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--foreground) 3%, transparent);
    font-size: var(--text-xs);
    line-height: 1.55;
    color: var(--text-secondary);
  }

  .lesson-footer {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding-top: 0.625rem;
    border-top: 1px solid var(--border-subtle);
  }

  .spacer { flex: 1; }

  .lesson-poster {
    width: var(--inline-block-width, 100%);
    margin-top: 0.65rem;
    padding: 0.85rem 1rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--artifact-radius, 14px);
    background: var(--artifact-surface, var(--card));
  }

  .poster-title { margin: 0; font-size: var(--text-sm); font-weight: 600; color: var(--foreground); }
  .poster-subtitle { margin: 0.15rem 0 0; font-size: var(--text-xs); color: var(--text-secondary); }
  .poster-meta { margin: 0.4rem 0 0; font-size: var(--text-xs); color: var(--muted-foreground); }

  @media (prefers-reduced-motion: reduce) {
    .lesson :global(.lesson-segment),
    .lesson :global(.choice),
    .lesson :global(.chip),
    .reveal summary::after { transition: none; }
  }
</style>
