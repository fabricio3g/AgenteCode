<svelte:options runes={true} />

<!--
  The starter list: one row per action, in the look a surface asks for.

  `variant="rows"` (the default) is the full row — kind tile, label, what you
  get, the slot the prompt still needs, then the key that picks it, hard right.
  `variant="links"` is the same four actions as one quiet line of text:
  nothing to scan, nothing to compare, just the four ways in under the
  composer. Picking never sends: the consumer decides what a picked row does.
-->

<script lang="ts">
  import Button from './Button.svelte';
  import Tooltip from './Tooltip.svelte';
  import type { Starter } from './starter-list';

  interface Props {
    starters: Starter[];
    /** Names the list for assistive tech; the links look paints no heading. */
    label: string;
    onpick: (id: string) => void;
    /** `rows` is the picker look; `links` is one line of text under a composer. */
    variant?: 'rows' | 'links';
  }

  let { starters, label, onpick, variant = 'rows' }: Props = $props();
</script>

{#if variant === 'links'}
  <nav class="starter-links" aria-label={label}>
    {#each starters as starter, index (starter.id)}
      {#if index > 0}<span class="sep" aria-hidden="true">·</span>{/if}
      <!-- The hint the row look puts on screen goes in a tooltip here: it is
           portalled and absolutely positioned, so showing it never moves the
           link the pointer is already on. -->
      {#if starter.hint}
        <Tooltip label={starter.hint} position="top">
          <Button variant="plain" type="button" class="starter-link" onclick={() => onpick(starter.id)}>{starter.label}</Button>
        </Tooltip>
      {:else}
        <Button variant="plain" type="button" class="starter-link" onclick={() => onpick(starter.id)}>{starter.label}</Button>
      {/if}
    {/each}
  </nav>
{:else}
  <ul class="starters" aria-label={label}>
    {#each starters as starter (starter.id)}
      {@const Icon = starter.icon}
      <li>
        <Button variant="plain" type="button" class="starter-row" style={starter.hue === undefined ? undefined : `--hue:${starter.hue}`} onclick={() => onpick(starter.id)}>
          {#if Icon}<span class="tile"><Icon /></span>{/if}
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
{/if}

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

  /* ── Links: the composer's own sentence, not a list to scan ──────────────
     One line of text that wraps. No tile, no key, no description, and no
     heading: `label` names the group for assistive tech, while on screen the
     four labels are the whole offer and the composer above stays the thing the
     eye lands on. */
  .starter-links {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.125rem 0.4375rem;
    font-size: var(--text-sm);
  }

  /* The separator belongs to the line, not to either neighbour: it keeps the
     muted weight of body copy and never underlines. 75%, not a fainter tint —
     at 12px on white a quieter dot disappears and the four labels read as one
     run-on sentence. */
  .sep { color: color-mix(in srgb, var(--muted-foreground) 75%, transparent); font-size: var(--text-xs); }

  /* Underline at rest and full colour on hover: a link you can see is a link,
     where a band on a row here would read as another button. */
  :global(.starter-link) {
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-secondary);
    font: inherit;
    font-size: var(--text-sm);
    letter-spacing: -0.005em;
    text-align: left;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--foreground) 22%, transparent);
    text-underline-offset: 3px;
    transition: color var(--motion-instant) var(--motion-ease-out), text-decoration-color var(--motion-instant) var(--motion-ease-out);
  }

  :global(.starter-link:hover),
  :global(.starter-link:focus-visible) {
    color: var(--foreground);
    text-decoration-color: currentColor;
  }

  :global(.starter-link:focus-visible) { outline: 2px solid var(--brand-accent); outline-offset: 2px; border-radius: 3px; }

  @media (prefers-reduced-motion: reduce) {
    :global(.starter-link) { transition: none; }
  }
</style>
