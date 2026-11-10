<svelte:options runes={true} />

<script lang="ts">
  import type { LessonModel } from '$lib/types/chat';
  import LessonPlot from './LessonPlot.svelte';
  import { evaluateExpression, formatLessonNumber, sampleSeries } from './simulation-model';
  import Range from '$lib/components/ui/Range.svelte';

  interface Props {
    model: LessonModel;
    insight?: string;
    readOnly?: boolean;
  }

  let { model, insight, readOnly = false }: Props = $props();

  function seedValues(): Record<string, number> {
    const values: Record<string, number> = {};
    for (const variable of model.variables) values[variable.key] = variable.value;
    return values;
  }

  let values = $state<Record<string, number>>(seedValues());
  // Re-seed when the model changes (a reopened artifact), not on every drag.
  let seeded = '';
  $effect(() => {
    const key = JSON.stringify(model.variables.map((variable) => [variable.key, variable.value]));
    if (key === seeded) return;
    seeded = key;
    values = seedValues();
  });

  const outputs = $derived(model.outputs.map((output) => ({
    ...output,
    value: evaluateExpression(output.expression, values),
    invalid: !isUsable(output.expression)
  })));

  /** True when the expression parses — so a broken one shows a dash, not a guess. */
  function isUsable(expression: string): boolean {
    try {
      // evaluateExpression already swallows errors; compile once more for the flag.
      return evaluateExpression(expression, values) !== null;
    } catch {
      return false;
    }
  }

  const plotSeries = $derived.by(() => {
    const plot = model.plot;
    if (!plot) return [];
    const from = plot.from ?? (model.variables.find((variable) => variable.key === plot.variable)?.min ?? 0);
    const to = plot.to ?? (model.variables.find((variable) => variable.key === plot.variable)?.max ?? 1);
    return sampleSeries({
      expression: plot.expression,
      variable: plot.variable,
      from,
      to,
      samples: plot.samples,
      vars: values
    });
  });

  function setVariable(key: string, value: number) {
    values = { ...values, [key]: value };
  }
</script>

<div class="explore">
  {#if outputs.length}
    <dl class="metrics">
      {#each outputs as output (output.key)}
        <div class="metric">
          <dt>{output.label}</dt>
          <dd class:is-invalid={output.value === null}>{formatLessonNumber(output.value, output.format, output.unit)}</dd>
        </div>
      {/each}
    </dl>
  {/if}

  {#if model.plot && plotSeries.length}
    <LessonPlot
      series={[{ points: plotSeries, area: true }]}
      xLabel={model.plot.xLabel ?? model.plot.variable}
      yLabel={model.plot.yLabel}
      label={model.plot.label ?? model.plot.expression}
    />
  {/if}

  <div class="controls">
    {#each model.variables as variable (variable.key)}
      {@const current = values[variable.key] ?? variable.value}
      <label class="control">
        <span class="control-label">{variable.label}</span>
        <Range
          min={variable.min}
          max={variable.max}
          step={variable.step ?? (variable.max - variable.min) / 100}
          value={current}
          disabled={readOnly}
          aria-label={variable.label}
          oninput={(event) => setVariable(variable.key, Number(event.currentTarget.value))}
        />
        <span class="control-value">{formatLessonNumber(current, 'number', variable.unit)}</span>
      </label>
    {/each}
  </div>

  {#if insight}
    <p class="insight">{insight}</p>
  {/if}
</div>

<style>
  .explore {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }

  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
    margin: 0;
    border-block: 1px solid var(--border-subtle);
  }

  .metric {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    padding: 0.6rem 0.7rem;
    border-right: 1px solid var(--border-subtle);
  }

  .metric:first-child { padding-left: 0; }
  .metric:last-child { border-right: 0; }

  .metric dt {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--text-tertiary, var(--text-secondary));
  }

  .metric dd {
    margin: 0;
    font-size: calc(var(--text-base) * 1.35);
    font-weight: 600;
    letter-spacing: -0.03em;
    font-variant-numeric: tabular-nums;
  }

  .metric dd.is-invalid { color: var(--text-tertiary, var(--text-secondary)); }

  .controls {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .control {
    display: grid;
    grid-template-columns: minmax(6rem, 30%) 1fr auto;
    align-items: center;
    gap: 0.6rem;
    font-size: var(--text-sm);
  }

  .control-label { color: var(--text-secondary); }

  .control-value {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
    min-width: 3.5rem;
    text-align: right;
  }

  .insight {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }

  @media (max-width: 480px) {
    .control { grid-template-columns: 1fr auto; }
    .control-label { grid-column: 1 / -1; }
  }
</style>
