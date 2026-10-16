<svelte:options runes={true} />

<!--
  The agent's tweaks (tweaks.json): a few values it chose to leave adjustable,
  at the top of the Tokens tab, where the same custom properties are listed
  below. Moving one previews it at once in every frame (a custom property set
  on the page's root) and, a moment after the pointer rests, rewrites that one
  declaration in tokens.css through the Tokens tab's own path. Nothing shows
  when the design has no tweaks.json or none of its properties exist.
-->

<script lang="ts">
  import ColorInput from '$lib/components/ui/ColorInput.svelte';
  import Range from '$lib/components/ui/Range.svelte';
  import Select from '$lib/components/ui/Select.svelte';
  import { copy } from '$lib/copy';
  import { designStore } from './design.svelte';
  import { colorValue, parseTweaks, rangeText, rangeValue, resolveTweaks, TWEAKS_FILE, type ResolvedTweak } from './design-tweaks';
  import type { TokenDecl } from './design-tokens';

  let { light }: { light: TokenDecl[] } = $props();

  /** How long a slider rests before its value is written to the file. */
  const SETTLE_MS = 350;

  const tweaks = $derived(resolveTweaks(parseTweaks(designStore.data.files[TWEAKS_FILE]), light));
  /** What a control shows while it is being moved, until its write lands. */
  let live = $state<Record<string, number>>({});
  const timers: Record<string, ReturnType<typeof setTimeout>> = {};

  async function write(item: ResolvedTweak, value: string) {
    clearTimeout(timers[item.tweak.id]);
    await designStore.writeToken(item.decl, value);
    delete live[item.tweak.id];
  }

  function move(item: ResolvedTweak, n: number) {
    const text = rangeText(item.tweak, n);
    live[item.tweak.id] = n;
    designStore.previewVar(item.tweak.cssVar, text);
    clearTimeout(timers[item.tweak.id]);
    timers[item.tweak.id] = setTimeout(() => void write(item, text), SETTLE_MS);
  }

  function pickColor(item: ResolvedTweak, value: string, final: boolean) {
    designStore.previewVar(item.tweak.cssVar, value);
    if (final) void write(item, value);
  }

  function choose(item: ResolvedTweak, value: string) {
    designStore.previewVar(item.tweak.cssVar, value);
    void write(item, value);
  }
</script>

{#if tweaks.length}
  <section class="block" aria-label={copy.design.tweaks.title}>
    <h3>{copy.design.tweaks.title}</h3>
    <ul class="tweaks">
      {#each tweaks as item (item.tweak.id)}
        {@const tweak = item.tweak}
        <li class="tweak">
          <span class="name" title={tweak.cssVar}>{tweak.label}</span>
          {#if tweak.type === 'range'}
            {@const n = live[tweak.id] ?? rangeValue(item)}
            <span class="control">
              <Range
                min={tweak.min}
                max={tweak.max}
                step={tweak.step}
                value={n}
                aria-label={tweak.label}
                oninput={(event) => move(item, Number(event.currentTarget.value))}
                onchange={(event) => void write(item, rangeText(tweak, Number(event.currentTarget.value)))}
              />
              <output class="reading">{rangeText(tweak, n)}</output>
            </span>
          {:else if tweak.type === 'color'}
            <span class="control end">
              <ColorInput
                class="swatch-input"
                value={colorValue(item) ?? '#000000'}
                aria-label={tweak.label}
                oninput={(event) => pickColor(item, event.currentTarget.value, false)}
                onchange={(event) => pickColor(item, event.currentTarget.value, true)}
              />
              <output class="reading">{item.current}</output>
            </span>
          {:else}
            <span class="control end">
              <Select
                size="sm"
                aria-label={tweak.label}
                options={(tweak.options ?? []).map((option) => ({ value: option.value, label: option.label }))}
                value={item.current}
                onchange={(value) => choose(item, value)}
              />
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .block { display: flex; flex-direction: column; gap: 0.4375rem; }
  h3 { margin: 0; font-size: var(--text-xs); font-weight: 500; color: var(--muted-foreground); }
  .tweaks { display: flex; flex-direction: column; gap: 0.375rem; margin: 0; padding: 0; list-style: none; }
  .tweak { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 10rem); align-items: center; gap: 0.5rem; }
  .name { overflow: hidden; color: var(--foreground); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
  .control { display: flex; min-width: 0; align-items: center; gap: 0.5rem; }
  .control.end { justify-content: flex-end; }
  .reading { min-width: 2.75rem; color: var(--muted-foreground); font-family: var(--font-mono); font-size: var(--text-xs); font-variant-numeric: tabular-nums; text-align: right; }
  .control :global(.swatch-input) { flex-shrink: 0; width: 1.375rem; height: 1.375rem; }
</style>
