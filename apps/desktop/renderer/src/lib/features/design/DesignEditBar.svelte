<svelte:options runes={true} />

<!--
  The edit toolbar that sits just above a selected element (Select tool, one
  element): text size, bold, text and background colour, corner radius and
  padding, and a menu for the selector and the source. Every button writes
  straight to the page's source (designStore.applyStyleEdit) without a model
  turn; Versions is the undo, with a version saved before a burst of edits.
  When an element cannot be found exactly once in the source, the change
  becomes a comment for the agent, as a text edit does.
-->

<script lang="ts">
  import { AArrowDown, AArrowUp, Baseline, Bold, Ellipsis, Minus, PaintBucket, Plus, Space, SquareRoundCorner, Code, Copy } from '$lib/icons';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { copy } from '$lib/copy';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import type { DesignSelection } from '$shared/design';
  import DesignToolButton from './DesignToolButton.svelte';
  import { designStore, TOKENS_FILE } from './design.svelte';
  import { boldEdit, fontSizeEdit, paddingEdit, radiusEdit, swatchesFor, type Swatch } from './design-edit-ops';

  let { pick }: { pick: DesignSelection } = $props();

  let colorMenu = $state(false);
  let fillMenu = $state(false);
  let moreMenu = $state(false);

  const swatches = $derived(swatchesFor(designStore.data.files[TOKENS_FILE]));
  const bold = $derived(Number(pick.styles['font-weight']) >= 600);

  const edit = (set: Record<string, string | null>) => void designStore.applyStyleEdit(pick, set);

  async function copySelector() {
    try { await writeToClipboard(pick.selector); } catch { /* the selector is still shown in the inspector */ }
  }
</script>

{#snippet colors(prop: 'color' | 'background-color', close: () => void)}
  {#if swatches.fromDesign.length}
    <div class="ui-menu-label">{copy.design.edit.designColors}</div>
  {/if}
  {#each [...swatches.fromDesign, ...swatches.fallback] as swatch (swatch.css)}
    {@render swatchItem(swatch, prop, close)}
  {/each}
  <MenuItem label={copy.design.edit.reset} onselect={() => { edit({ [prop]: null }); close(); }} />
{/snippet}

{#snippet swatchItem(swatch: Swatch, prop: 'color' | 'background-color', close: () => void)}
  <MenuItem onselect={() => { edit({ [prop]: swatch.css }); close(); }}>
    <span class="dot" style:background={swatch.show} aria-hidden="true"></span>
    <span class="swatch-name">{swatch.label}</span>
  </MenuItem>
{/snippet}

<div class="edit-bar ui-float" role="toolbar" aria-label={copy.design.edit.label}>
  <DesignToolButton icon={AArrowDown} label={copy.design.edit.smaller} position="top" onclick={() => edit(fontSizeEdit(pick.styles, -1))} />
  <DesignToolButton icon={AArrowUp} label={copy.design.edit.larger} position="top" onclick={() => edit(fontSizeEdit(pick.styles, 1))} />
  <DesignToolButton icon={Bold} label={copy.design.edit.bold} position="top" pressed={bold} onclick={() => edit(boldEdit(pick.styles))} />

  <span class="sep" aria-hidden="true"></span>
  <Menu bind:open={colorMenu} placement="top-start" minWidth="10rem" label={copy.design.edit.textColor}>
    {#snippet trigger(props)}
      <IconButton label={copy.design.edit.textColor} class="design-tool" {...props}><Baseline aria-hidden="true" /></IconButton>
    {/snippet}
    {@render colors('color', () => (colorMenu = false))}
  </Menu>
  <Menu bind:open={fillMenu} placement="top-start" minWidth="10rem" label={copy.design.edit.background}>
    {#snippet trigger(props)}
      <IconButton label={copy.design.edit.background} class="design-tool" {...props}><PaintBucket aria-hidden="true" /></IconButton>
    {/snippet}
    {@render colors('background-color', () => (fillMenu = false))}
  </Menu>

  <span class="sep" aria-hidden="true"></span>
  <SquareRoundCorner class="kind" aria-hidden="true" />
  <DesignToolButton icon={Minus} label={copy.design.edit.radiusLess} position="top" onclick={() => edit(radiusEdit(pick.styles, -1))} />
  <DesignToolButton icon={Plus} label={copy.design.edit.radiusMore} position="top" onclick={() => edit(radiusEdit(pick.styles, 1))} />
  <Space class="kind" aria-hidden="true" />
  <DesignToolButton icon={Minus} label={copy.design.edit.paddingLess} position="top" onclick={() => edit(paddingEdit(pick.styles, -1))} />
  <DesignToolButton icon={Plus} label={copy.design.edit.paddingMore} position="top" onclick={() => edit(paddingEdit(pick.styles, 1))} />

  <span class="sep" aria-hidden="true"></span>
  <Menu bind:open={moreMenu} placement="top-end" minWidth="11rem" label={copy.design.edit.more}>
    {#snippet trigger(props)}
      <IconButton label={copy.design.edit.more} class="design-tool" {...props}><Ellipsis aria-hidden="true" /></IconButton>
    {/snippet}
    <MenuItem icon={Copy} label={copy.design.edit.copySelector} onselect={() => void copySelector()} />
    <MenuItem icon={Code} label={copy.design.edit.openCode} onselect={() => designStore.showInInspector('code')} />
  </Menu>
</div>

<style>
  .edit-bar {
    display: inline-flex;
    align-items: center;
    gap: 0.0625rem;
    padding: 0.1875rem;
    border-radius: var(--radius-lg, 0.75rem);
    white-space: nowrap;
  }

  .sep {
    align-self: stretch;
    width: 1px;
    margin: 0.3125rem 0.25rem;
    background: var(--border);
  }

  /* The property a −/+ pair changes, quiet between the pairs. */
  .edit-bar :global(.kind) {
    width: 14px;
    height: 14px;
    margin: 0 0.125rem 0 0.25rem;
    flex-shrink: 0;
    color: var(--muted-foreground);
  }

  .dot {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
    border-radius: var(--radius-full);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--foreground) 14%, transparent);
  }
  .swatch-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
