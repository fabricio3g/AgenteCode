<svelte:options runes={true} />

<script lang="ts">
  import LessonPlot from './LessonPlot.svelte';
  import { sampleSeries, type LessonPoint } from './simulation-model';
  import Button from '$lib/components/ui/Button.svelte';

  interface Props {
    expression?: string;
    series?: LessonPoint[];
    xRange: [number, number];
    yRange?: [number, number];
    label?: string;
    insight?: string;
    readOnly?: boolean;
    onSettle?: () => void;
  }

  let { expression, series, xRange, yRange, label, insight, readOnly = false, onSettle }: Props = $props();

  const HANDLES = 5;

  const truth = $derived.by<LessonPoint[]>(() => {
    if (series?.length) return [...series].sort((a, b) => a.x - b.x);
    if (!expression) return [];
    return sampleSeries({ expression, variable: 'x', from: xRange[0], to: xRange[1] });
  });

  const domain = $derived.by<[number, number]>(() => {
    if (yRange) return yRange;
    const ys = truth.map((point) => point.y).filter((value) => Number.isFinite(value));
    if (!ys.length) return [0, 1];
    const min = Math.min(...ys, 0);
    const max = Math.max(...ys, 1);
    return [min, max];
  });

  let guess = $state<number[]>([]);
  let revealed = $state(false);

  $effect(() => {
    const key = `${xRange[0]}:${xRange[1]}:${domain[0]}:${domain[1]}:${truth.length}`;
    if (revealed || guess.length) return;
    guess = Array.from({ length: HANDLES }, () => (domain[0] + domain[1]) / 2);
    void key;
  });

  const handlePoints = $derived(guess.map((value, index) => ({
    x: xRange[0] + ((xRange[1] - xRange[0]) * index) / (HANDLES - 1),
    y: value
  })));

  function drag(index: number, value: number) {
    if (readOnly || revealed) return;
    const clamped = Math.min(domain[1], Math.max(domain[0], value));
    guess = guess.map((entry, position) => (position === index ? clamped : entry));
  }

  function reveal() {
    if (revealed) return;
    revealed = true;
    onSettle?.();
  }

  function retry() {
    revealed = false;
    guess = Array.from({ length: HANDLES }, () => (domain[0] + domain[1]) / 2);
  }
</script>

<div class="predict">
  <LessonPlot
    series={[
      ...(revealed && truth.length ? [{ points: truth, area: true }] : []),
      ...(revealed ? [{ points: handlePoints, tone: 'ghost' as const }] : [])
    ]}
    handles={revealed ? undefined : handlePoints}
    onHandleDrag={drag}
    xLabel={label ?? 'x'}
    label={label ?? 'Your guess'}
  />

  <div class="actions">
    {#if revealed}
      <Button variant="ghost" size="sm" onclick={retry} disabled={readOnly}>Try again</Button>
    {:else}
      <Button size="sm" onclick={reveal} disabled={readOnly}>Show the real curve</Button>
    {/if}
    {#if insight}
      <p class="insight">{insight}</p>
    {/if}
  </div>
</div>

<style>
  .predict {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    flex-wrap: wrap;
  }

  .insight {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
</style>
