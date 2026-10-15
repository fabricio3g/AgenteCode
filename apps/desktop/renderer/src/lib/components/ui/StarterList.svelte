<svelte:options runes={true} />

<!--
  The starter list: one row per action, in the one look every surface uses for
  "here is something to try" — the Design dock's empty screen and the Code
  space's first conversation both render this.

  Row anatomy is fixed: kind tile, label, what you get, the slot the prompt
  still needs, then the key that picks it, hard right. Picking never sends: the
  consumer decides what a picked row does.
-->

<script lang="ts">
  import Button from './Button.svelte';
  import type { Starter } from './starter-list';

  interface Props {
    starters: Starter[];
    /** Names the list for assistive tech. */
    label: string;
    onpick: (id: string) => void;
  }

  let { starters, label, onpick }: Props = $props();
</script>

<ul class="starters" aria-label={label}>
  {#each starters as starter (starter.id)}
    {@const Icon = starter.icon}
    <li>
      <Button variant="plain" type="button" class="starter-row" style="--hue:{starter.hue}" onclick={() => onpick(starter.id)}>
        <span class="tile"><Icon /></span>
        <span class="text">
          <span class="label">{starter.label}</span>
          {#if starter.hint}<span class="hint">{starter.hint}</span>{/if}
        </span>
        {#if starter.slot}<span class="slot">{starter.slot}</span>{/if}
        {#if starter.key}<span class="key">{starter.key}</span>{/if}
      </Button>
    </li>
  {/each}
</ul>

<style>
  .starters {
    display: flex;
    width: 100%;
    margin: 0;
    padding: 0;
    flex-direction: column;
    gap: 1px;
    list-style: none;
  }

  /* A hover band on a row the user passes over dozens of times a day: `instant`
     or nothing — a 150ms fade here is the animation people feel as lag. */
  :global(.starter-row) {
    display: flex;
    width: 100%;
    min-width: 0;
    min-height: 2.75rem;
    align-items: center;
    gap: 0.625rem;
    padding: 0.4375rem 0.5rem;
    border-radius: var(--radius-lg);
    background: transparent;
    color: var(--foreground);
    text-align: left;
    transition: background-color var(--motion-instant) var(--motion-ease-out);
  }

  :global(.starter-row:hover),
  :global(.starter-row:focus-visible) { background: var(--surface-hover); }

  /* Pressed: the row answers before anything else does. */
  :global(.starter-row:active) { background: color-mix(in srgb, var(--foreground) 9%, transparent); }

  /* Overrides the primitive's ring: a row is a full-width hit area, so the
     focus mark belongs inside it, not floating two pixels outside. */
  :global(.starter-row:focus-visible) { outline: 2px solid var(--brand-accent); outline-offset: -2px; }

  /* The kind tile carries its own hue at full strength, the way the artifact
     list's glyphs do; the glyph stays white in both themes.

     One lightness and one chroma for every kind, so no kind reads as louder
     than another, and a hue set chosen so the four stay four for colour-blind
     eyes: 8 / 130 / 250 / 325, spaced 105–120° apart. Measured, white glyph on
     tile: 4.64–5.23:1 (AA at 12px+); tile on the dark page: 3.29–3.90:1. */
  .tile {
    display: inline-flex;
    width: 1.625rem;
    height: 1.625rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: 0.5rem;
    background: oklch(var(--tile-l, 0.55) var(--tile-c, 0.14) var(--hue));
    color: #fff;
  }

  .tile :global(svg) { width: 0.875rem; height: 0.875rem; }

  .text {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 0.0625rem;
  }

  .label,
  .hint {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .label {
    color: var(--foreground);
    font-size: var(--text-sm);
    font-weight: 500;
    letter-spacing: -0.005em;
  }

  .hint { color: var(--muted-foreground); font-size: var(--text-xs); }

  /* The blank a prefix prompt still needs. Dashed and mono so it reads as a
     token to fill, not as more copy. The border is decoration (2.6:1) — the
     words inside carry the meaning, and they clear AA on the hover band. */
  .slot {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 0.25rem;
    padding: 0.0625rem 0.375rem;
    border: 1px dashed color-mix(in srgb, var(--foreground) 34%, transparent);
    border-radius: 5px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .slot::before { content: "+"; opacity: 0.7; }

  /* `--text-secondary`, not `--muted-foreground`: at 12px the muted grey lands
     at 4.47:1 on a hovered row — under AA by a hair. Secondary measures 6.08:1
     there and 7.04:1 at rest. */
  .key {
    flex-shrink: 0;
    padding: 0.0625rem 0.3125rem;
    border-radius: 5px;
    background: color-mix(in srgb, var(--foreground) 7%, transparent);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    white-space: nowrap;
    transition: color var(--motion-instant) var(--motion-ease-out);
  }

  :global(.starter-row:hover) .key,
  :global(.starter-row:focus-visible) .key { color: var(--foreground); }

  /* A narrow pane drops the extra tokens before it truncates the sentence:
     the slot first, then the hint — never the label. */
  @container (max-width: 34rem) {
    .slot { display: none; }
  }

  @container (max-width: 26rem) {
    .hint { display: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.starter-row), .key { transition: none; }
  }
</style>
