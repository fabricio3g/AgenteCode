<svelte:options runes={true} />

<!--
  A menu row that opens a side panel: hover (after a short pause, so a pointer
  crossing the row on its way down does not flicker it open), click, → or
  Enter. ← or Escape steps back to the row. Siblings share one `SubMenuGroup`
  (`submenuGroup()` in the parent menu) so only one side panel is open at a
  time, and hovering a plain row closes it.

    <SubMenu group={group} key="effort" label="Effort" value="Medium">
      <MenuItem … />
    </SubMenu>
-->

<script module lang="ts">
  export type SubMenuGroup = { active: string | null };

  /** One per parent menu: which side panel is open. */
  export function submenuGroup(): SubMenuGroup {
    let active = $state<string | null>(null);
    return {
      get active() { return active; },
      set active(value) { active = value; }
    };
  }
</script>

<script lang="ts">
  import type { ComponentType, Snippet } from 'svelte';
  import type { Icon as LucideIcon } from 'lucide-svelte';
  import { ChevronRight } from 'lucide-svelte';
  import { tick } from 'svelte';
  import Menu from './Menu.svelte';
  import type { MenuPlacement } from './menu';

  let {
    group,
    key,
    label,
    value = '',
    icon: Icon,
    lead,
    placement = 'right-end',
    minWidth = '14rem',
    disabled = false,
    class: className = '',
    children
  }: {
    group: SubMenuGroup;
    key: string;
    label: string;
    /** The current choice, quiet on the right of the row. */
    value?: string;
    icon?: ComponentType<LucideIcon>;
    /** Replaces the icon: a mark of the caller's own (a slot meter, a logo). */
    lead?: Snippet;
    placement?: MenuPlacement;
    minWidth?: string;
    disabled?: boolean;
    class?: string;
    children: Snippet;
  } = $props();

  let open = $state(false);
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;

  // The group decides; this panel follows it either way.
  $effect(() => {
    const mine = group.active === key;
    if (open !== mine) open = mine;
  });

  function show(focusFirst = false) {
    if (disabled) return;
    group.active = key;
    if (focusFirst) void tick().then(() => requestAnimationFrame(() => {
      const panels = document.querySelectorAll<HTMLElement>('.ui-menu-panel');
      panels[panels.length - 1]?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
    }));
  }

  function onclose() {
    if (group.active === key) group.active = null;
  }

  function onpointerenter() {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => show(), 120);
  }

  function onpointerleave() {
    clearTimeout(hoverTimer);
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowRight' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      show(true);
    }
  }
</script>

<Menu bind:open {placement} {minWidth} label={label} {onclose}>
  {#snippet trigger()}
    <button
      type="button"
      role="menuitem"
      class="ui-menu-item ui-submenu-row {className}"
      class:is-open={open}
      aria-haspopup="menu"
      aria-expanded={open}
      data-keep-open
      {disabled}
      onclick={(event) => { event.stopPropagation(); if (open) onclose(); else show(); }}
      {onpointerenter}
      {onpointerleave}
      {onkeydown}
    >
      {#if lead}{@render lead()}{:else if Icon}<Icon class="size-4" />{/if}
      <span class="ui-menu-item-text"><span class="truncate">{label}</span></span>
      {#if value}<span class="ui-submenu-value">{value}</span>{/if}
      <ChevronRight class="ui-submenu-chevron size-3.5" />
    </button>
  {/snippet}
  {@render children()}
</Menu>

<style>
  .ui-submenu-row { width: 100%; }
  .ui-submenu-row.is-open { background: var(--float-row-hover); }
  .ui-submenu-value {
    margin-left: auto;
    flex-shrink: 0;
    color: var(--muted-foreground);
    font-size: var(--text-xs);
  }
  .ui-submenu-row :global(.ui-submenu-chevron) {
    flex-shrink: 0;
    color: var(--muted-foreground);
  }
</style>
