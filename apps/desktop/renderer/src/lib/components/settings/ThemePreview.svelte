<svelte:options runes={true} />

<!--
  A theme's own miniature for Settings → Appearance: the window in small — top
  bar and sidebar on one plane, the conversation sheet with its rounded corner,
  a prompt, a reply and the message box — painted only with the app's tokens
  under `data-theme-preview`, which app.css resolves exactly as it resolves the
  theme on the window. The accent is the one in effect (it lives inline on the
  root), so the tile shows what choosing it will look like.
-->

<script lang="ts">
  import type { ThemePresetId } from '$shared/appearance';

  let { theme }: { theme: ThemePresetId } = $props();
</script>

<span class="theme-preview" data-theme-preview={theme} inert aria-hidden="true">
  <span class="tp-bar">
    <span class="tp-dot"></span><span class="tp-dot"></span>
    <span class="tp-tabs"><span class="tp-tab is-on"></span><span class="tp-tab"></span><span class="tp-tab"></span></span>
  </span>
  <span class="tp-body">
    <span class="tp-side">
      <span class="tp-row is-strong"></span>
      <span class="tp-row is-on"></span>
      <span class="tp-row"></span>
      <span class="tp-row is-short"></span>
    </span>
    <span class="tp-sheet">
      <span class="tp-bubble"></span>
      <span class="tp-line"></span>
      <span class="tp-line is-short"><span class="tp-accent"></span></span>
      <span class="tp-composer ui-composer"><span class="tp-send"></span></span>
    </span>
  </span>
</span>

<style>
  /* The accent belongs to the window, not the palette: take it from the root
     instead of the default the token block would set here. */
  .theme-preview {
    --brand-accent: inherit;
    --brand-accent-strong: inherit;
    --brand-accent-fg: inherit;
    display: flex;
    width: 100%;
    height: 4.5rem;
    flex-direction: column;
    overflow: hidden;
    background: var(--sidebar);
    color: var(--foreground);
    pointer-events: none;
  }
  .tp-bar {
    display: flex;
    height: 0.75rem;
    flex: none;
    align-items: center;
    gap: 0.1875rem;
    padding-inline: 0.375rem;
  }
  .tp-dot {
    width: 0.25rem;
    height: 0.25rem;
    border-radius: 9999px;
    background: var(--text-tertiary);
    opacity: 0.6;
  }
  .tp-tabs {
    display: flex;
    gap: 0.125rem;
    margin-left: 0.25rem;
    padding: 0.0625rem;
    border: 1px solid var(--border);
    border-radius: 0.1875rem;
  }
  .tp-tab {
    width: 0.375rem;
    height: 0.25rem;
    border-radius: 0.0625rem;
  }
  .tp-tab.is-on { background: var(--float-row-selected, var(--surface-active)); }
  .tp-body {
    display: flex;
    min-height: 0;
    flex: 1;
  }
  .tp-side {
    display: flex;
    width: 30%;
    flex: none;
    flex-direction: column;
    gap: 0.1875rem;
    padding: 0.25rem 0.3125rem;
  }
  .tp-row {
    height: 0.3125rem;
    border-radius: 0.125rem;
    background: color-mix(in srgb, var(--text-secondary) 35%, transparent);
  }
  .tp-row.is-strong { width: 80%; background: color-mix(in srgb, var(--foreground) 55%, transparent); }
  .tp-row.is-on { box-shadow: 0 0 0 0.125rem var(--float-row-selected, var(--surface-active)); background: color-mix(in srgb, var(--foreground) 45%, transparent); }
  .tp-row.is-short { width: 55%; }
  /* The content sheet: hairline on top and on the sidebar side, rounded where they meet. */
  .tp-sheet {
    position: relative;
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.3125rem 0.4375rem;
    border-top: 1px solid var(--sidebar-border);
    border-left: 1px solid var(--sidebar-border);
    border-top-left-radius: 0.3125rem;
    background: var(--background);
  }
  .tp-bubble {
    width: 45%;
    height: 0.5rem;
    align-self: flex-end;
    border-radius: 0.1875rem;
    background: var(--user-bubble);
  }
  .tp-line {
    display: flex;
    width: 80%;
    height: 0.1875rem;
    border-radius: 9999px;
    background: color-mix(in srgb, var(--prose-ink, var(--foreground)) 55%, transparent);
  }
  .tp-line.is-short { width: 50%; }
  .tp-accent {
    width: 30%;
    border-radius: 9999px;
    background: var(--brand-accent);
  }
  /* The real message-box frame (`.ui-composer`: surface, ring, radius), small. */
  .tp-composer {
    --composer-radius: 0.3125rem;
    display: flex;
    height: 0.9375rem;
    margin-top: auto;
    align-items: center;
    justify-content: flex-end;
    padding-inline: 0.1875rem;
  }
  .tp-composer::after { display: none; }
  .tp-send {
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 0.125rem;
    background: color-mix(in srgb, var(--foreground) 18%, transparent);
  }
</style>
