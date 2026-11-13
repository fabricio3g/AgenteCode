<script lang="ts">
  import type { Icon as AppIcon } from '$lib/icons';
  import { onMount, tick } from 'svelte';
  import { cn } from '$lib/utils/cn';
  import { reducedMotion } from '$lib/utils/motion.svelte';
  import StatusDot from './StatusDot.svelte';
  import Tooltip from './Tooltip.svelte';

  export type SegmentOption = {
    value: string;
    label: string;
    /** A glyph before the label; the label stays the accessible name. */
    icon?: AppIcon;
    /** A live dot: this segment's work keeps running in the background. */
    dot?: boolean;
    title?: string;
    disabled?: boolean;
  };

  let {
    value = $bindable(),
    options,
    label,
    onchange,
    variant = 'segmented',
    shape = 'pill',
    id,
    controlsPanels = true,
    labels = 'all',
    class: className = '',
  }: {
    value: string;
    options: SegmentOption[];
    label: string;
    onchange?: (value: string) => void;
    variant?: 'segmented' | 'tabs';
    /** `soft` squares the corners off to the app's own radius; `rect` is the settings edge-to-edge variant. */
    shape?: 'pill' | 'soft' | 'rect';
    id?: string;
    /** Off for tabs that switch a whole space and own no `tabpanel`. */
    controlsPanels?: boolean;
    /**
     * `all` names every segment, `active` names only the one in effect — the
     * rest keep their glyph and show the name on hover — `none` is glyphs only.
     */
    labels?: 'all' | 'active' | 'none';
    class?: string;
  } = $props();

  let containerEl = $state<HTMLDivElement>();
  let indicatorLeft = $state(0);
  let indicatorWidth = $state(0);
  let indicatorTop = $state(0);
  let indicatorHeight = $state(0);
  let indicatorReady = $state(false);

  /* One corner vocabulary for the three shapes: the track, then the segment
     and its sliding indicator sit one step tighter, as nested corners do. */
  const TRACK_RADIUS = {
    pill: 'rounded-full',
    soft: 'rounded-[var(--radius)]',
    rect: 'rounded-[var(--radius-sm)]',
  } as const;
  const SEGMENT_RADIUS = {
    pill: 'rounded-full',
    soft: 'rounded-[var(--radius-md)]',
    rect: 'rounded-[var(--radius-sm)]',
  } as const;

  const activeIndex = $derived(options.findIndex((option) => option.value === value));

  function tabId(optionValue: string): string | undefined {
    return id ? `${id}-tab-${optionValue}` : undefined;
  }

  function panelId(optionValue: string): string | undefined {
    return id ? `${id}-panel-${optionValue}` : undefined;
  }

  function updateIndicator() {
    if (variant !== 'tabs' || !containerEl || activeIndex < 0) return;
    const button = containerEl.querySelectorAll<HTMLButtonElement>('button')[activeIndex];
    if (!button) return;
    // Measured off the segment itself, never off the track's padding: an
    // indicator sized from the container drifted a pixel past the segment it
    // marks (visible as a white sliver over the track's edge).
    indicatorLeft = button.offsetLeft;
    indicatorWidth = button.offsetWidth;
    indicatorTop = button.offsetTop;
    indicatorHeight = button.offsetHeight;
    indicatorReady = true;
  }

  function select(nextValue: string) {
    value = nextValue;
    onchange?.(nextValue);
  }

  async function focusOption(index: number) {
    const buttons = containerEl?.querySelectorAll<HTMLButtonElement>('button');
    buttons?.[index]?.focus();
    select(options[index].value);
    await tick();
    updateIndicator();
  }

  function handleTabKeydown(event: KeyboardEvent, currentIndex: number) {
    if (variant !== 'tabs') return;
    let targetIndex = currentIndex;
    if (event.key === 'Home') targetIndex = 0;
    else if (event.key === 'End') targetIndex = options.length - 1;
    else if (event.key === 'ArrowRight') targetIndex = (currentIndex + 1) % options.length;
    else if (event.key === 'ArrowLeft') targetIndex = (currentIndex - 1 + options.length) % options.length;
    else return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' || event.key === 'End' ? -1 : 1;
    for (let attempts = 0; attempts < options.length; attempts += 1) {
      if (!options[targetIndex]?.disabled) {
        void focusOption(targetIndex);
        return;
      }
      targetIndex = (targetIndex + step + options.length) % options.length;
    }
  }

  $effect(() => {
    if (variant !== 'tabs') return;
    value;
    options.length;
    void tick().then(updateIndicator);
  });

  onMount(() => {
    if (variant !== 'tabs' || !containerEl) return;
    updateIndicator();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateIndicator);
    observer.observe(containerEl);
    return () => observer.disconnect();
  });
</script>

<div
  bind:this={containerEl}
  {id}
  class={cn(
    // Wraps rather than clips: the interface-size track has seven steps, and
    // the people who need the top of it are the ones running a large text
    // scale, which is exactly when the row stops fitting.
    'relative inline-flex flex-wrap gap-[2px] p-[2px]',
    variant === 'tabs' && 'flex-nowrap',
    TRACK_RADIUS[shape],
    // Same hairline track as .ui-segmented: on a dialog the --muted fill alone vanishes.
    shape === 'rect'
      ? 'border border-[var(--border-hover)] bg-[var(--card)]'
      : 'border border-[var(--border)] bg-[var(--muted)]',
    className,
  )}
  role={variant === 'tabs' ? 'tablist' : 'radiogroup'}
  aria-label={label}
>
  {#if variant === 'tabs'}
    <span
      aria-hidden="true"
      class={cn(
        'pointer-events-none absolute',
        SEGMENT_RADIUS[shape],
        shape === 'rect' ? 'bg-primary' : 'bg-[var(--segment-active-bg)] shadow-[var(--segment-active-shadow)]',
        indicatorReady && !reducedMotion.value && 'transition-[left,top,width,height] duration-200 ease-[var(--motion-ease)]',
      )}
      style={`left:${indicatorLeft}px;top:${indicatorTop}px;width:${indicatorWidth}px;height:${indicatorHeight}px;opacity:${indicatorReady ? 1 : 0};`}
    ></span>
  {/if}
  {#each options as option, index (option.value)}
    {@const named = labels === 'all' || (labels === 'active' && value === option.value)}
    <Tooltip label={named ? '' : option.label} position="bottom">
      <button
        type="button"
        id={variant === 'tabs' ? tabId(option.value) : undefined}
        role={variant === 'tabs' ? 'tab' : 'radio'}
        aria-selected={variant === 'tabs' ? value === option.value : undefined}
        aria-checked={variant === 'tabs' ? undefined : value === option.value}
        aria-controls={variant === 'tabs' && controlsPanels ? panelId(option.value) : undefined}
        tabindex={variant === 'tabs' ? (value === option.value ? 0 : -1) : undefined}
        disabled={option.disabled}
        title={option.title}
        aria-label={named ? undefined : option.label}
        class={cn(
          // One control height for the whole settings screen: the 26px segment
          // inside a 2px track and its hairline lands on 32px, level with Input and Select.
          'relative z-10 inline-flex h-[26px] items-center gap-[0.3rem] font-medium outline-none transition-[color,box-shadow] duration-[var(--motion-fast)] ease-[var(--motion-ease)] focus-visible:ring-[3px] focus-visible:ring-ring/20 disabled:opacity-50',
          // A segment without its name is a 26px square, so the track stays a row of marks.
          named ? 'px-3' : 'w-[26px] justify-center',
          SEGMENT_RADIUS[shape],
          shape === 'rect' ? 'text-[length:var(--text-sm)]' : 'text-[length:var(--text-xs)]',
          value === option.value
            ? shape === 'rect'
              ? variant === 'tabs' ? 'text-primary-fg' : 'bg-primary text-primary-fg'
              : variant === 'tabs' ? 'text-foreground' : 'bg-[var(--segment-active-bg)] shadow-[var(--segment-active-shadow)] text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
        onclick={() => select(option.value)}
        onkeydown={(event) => handleTabKeydown(event, index)}
      >
        {#if option.icon}
          {@const Icon = option.icon}
          <Icon class="size-3.5 shrink-0" aria-hidden="true" />
        {/if}
        {#if named}{option.label}{/if}
        {#if option.dot}
          <!-- A corner mark, not a flex item: it must not push the glyph off centre. -->
          <span class="absolute right-[0.1875rem] top-[0.1875rem] flex"><StatusDot tone="running" /></span>
        {/if}
      </button>
    </Tooltip>
  {/each}
</div>
