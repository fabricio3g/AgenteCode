<svelte:options runes={true} />

<!--
  Step-by-step array / pointer state machine for algorithms (binary search,
  two pointers, sliding window, sorting passes).
-->

<script lang="ts">
  import Button from '$lib/components/ui/Button.svelte';

  export interface AlgoStep {
    low?: number;
    mid?: number;
    high?: number;
    found?: number;
    note: string;
  }

  interface Props {
    data: Array<string | number>;
    steps: AlgoStep[];
  }

  let { data, steps }: Props = $props();
  let stepIndex = $state(0);

  $effect(() => {
    void data;
    stepIndex = 0;
  });

  const cur = $derived(steps[stepIndex]);
</script>

<div class="algo">
  <div class="algo-cells">
    {#each data as val, i (i)}
      {@const out = cur && ((typeof cur.low === 'number' && i < cur.low) || (typeof cur.high === 'number' && i > cur.high))}
      {@const isFound = cur?.found === i}
      {@const isMid = cur?.mid === i}
      <div class="algo-cell" class:is-out={out} class:is-mid={isMid && !isFound} class:is-found={isFound}>
        <span class="algo-i">{i}</span>
        <span>{val}</span>
        {#if isFound}
          <span class="algo-p is-good">hit</span>
        {:else if isMid}
          <span class="algo-p is-acc">mid</span>
        {:else if cur?.low === i}
          <span class="algo-p">lo</span>
        {:else if cur?.high === i}
          <span class="algo-p">hi</span>
        {/if}
      </div>
    {/each}
  </div>

  {#if cur}
    <p class="algo-note">{cur.note}</p>
  {/if}

  <div class="algo-actions">
    <Button variant="ghost" size="sm" disabled={stepIndex === 0} onclick={() => (stepIndex = 0)}>Reset</Button>
    <Button size="sm" disabled={stepIndex >= steps.length - 1} onclick={() => (stepIndex += 1)}>
      Step {stepIndex + 1} / {Math.max(1, steps.length)}
    </Button>
  </div>
</div>

<style>
  .algo { display: flex; flex-direction: column; gap: 0.65rem; }
  .algo-cells { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 0.3rem; padding: 1.1rem 0.25rem 1.25rem; }
  .algo-cell {
    position: relative; height: 2.6rem; border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle); background: color-mix(in srgb, var(--foreground) 3%, transparent);
    display: flex; align-items: center; justify-content: center;
    font-family: var(--font-mono); font-size: var(--text-xs); font-weight: 600;
    transition: opacity var(--motion-fast) var(--motion-ease), border-color var(--motion-fast) var(--motion-ease);
  }
  .algo-cell.is-out { opacity: 0.25; }
  .algo-cell.is-mid { border-color: var(--brand-accent, var(--foreground)); color: var(--brand-accent, var(--foreground)); }
  .algo-cell.is-found { border-color: var(--accent-green-text); background: var(--accent-green-bg); color: var(--accent-green-text); }
  .algo-i { position: absolute; top: -1rem; font-size: 10px; font-weight: 400; color: var(--muted-foreground); }
  .algo-p { position: absolute; bottom: -1.1rem; font-size: 10px; font-weight: 600; color: var(--text-secondary); }
  .algo-p.is-acc { color: var(--brand-accent, var(--foreground)); }
  .algo-p.is-good { color: var(--accent-green-text); }
  .algo-note { margin: 0; font-size: var(--text-xs); color: var(--text-secondary); }
  .algo-actions { display: flex; align-items: center; gap: 0.4rem; }
</style>
