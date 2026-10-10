<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { cn } from '$lib/utils/cn';
  import { reducedMotion } from '$lib/utils/motion.svelte';

  export type SegmentOption = {
    value: string;
    label: string;
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
    class: className = '',
  }: {
    value: string;
    options: SegmentOption[];
    label: string;
    onchange?: (value: string) => void;
    variant?: 'segmented' | 'tabs';
    shape?: 'pill' | 'rect';
    id?: string;
    class?: string;
  } = $props();

  let containerEl = $state<HTMLDivElement>();
  let indicatorLeft = $state(0);
  let indicatorWidth = $state(0);
  let indicatorReady = $state(false);

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
    indicatorLeft = button.offsetLeft;
    indicatorWidth = button.offsetWidth;
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
    'relative inline-flex flex-wrap p-[2px]',
    variant === 'tabs' && 'flex-nowrap',
    // Same hairline track as .ui-segmented: on a dialog the --muted fill alone vanishes.
    shape === 'rect'
      ? 'rounded-[var(--radius-sm)] border border-[var(--border-hover)] bg-[var(--card)]'
      : 'rounded-full border border-[var(--border)] bg-[var(--muted)]',
    className,
  )}
  role={variant === 'tabs' ? 'tablist' : 'radiogroup'}
  aria-label={label}
>
  {#if variant === 'tabs'}
    <span
      aria-hidden="true"
      class={cn(
        'pointer-events-none absolute bottom-[2px] top-[2px]',
        shape === 'rect'
          ? 'rounded-[var(--radius-sm)] bg-primary'
          : 'rounded-full bg-[var(--segment-active-bg)] shadow-[var(--segment-active-shadow)]',
        indicatorReady && !reducedMotion.value && 'transition-[left,width] duration-200 ease-[var(--motion-ease)]',
      )}
      style={`left:${indicatorLeft}px;width:${indicatorWidth}px;opacity:${indicatorReady ? 1 : 0};`}
    ></span>
  {/if}
  {#each options as option, index (option.value)}
    <button
      type="button"
      id={variant === 'tabs' ? tabId(option.value) : undefined}
      role={variant === 'tabs' ? 'tab' : 'radio'}
      aria-selected={variant === 'tabs' ? value === option.value : undefined}
      aria-checked={variant === 'tabs' ? undefined : value === option.value}
      aria-controls={variant === 'tabs' ? panelId(option.value) : undefined}
      tabindex={variant === 'tabs' ? (value === option.value ? 0 : -1) : undefined}
      disabled={option.disabled}
      title={option.title}
      class={cn(
        // One control height for the whole settings screen: the 26px segment
        // inside a 2px track and its hairline lands on 32px, level with Input and Select.
        'relative z-10 inline-flex h-[26px] items-center px-3 font-medium outline-none transition-[color,box-shadow,transform] duration-[var(--motion-fast)] ease-[var(--motion-ease)] focus-visible:ring-[3px] focus-visible:ring-ring/20 active:scale-[0.98] disabled:opacity-50',
        shape === 'rect' ? 'rounded-[var(--radius-sm)] text-[length:var(--text-sm)]' : 'rounded-full text-[length:var(--text-xs)]',
        value === option.value
          ? shape === 'rect'
            ? variant === 'tabs' ? 'text-primary-fg' : 'bg-primary text-primary-fg'
            : variant === 'tabs' ? 'text-foreground' : 'bg-[var(--segment-active-bg)] shadow-[var(--segment-active-shadow)] text-foreground'
          : 'text-muted-foreground hover:text-foreground',
      )}
      onclick={() => select(option.value)}
      onkeydown={(event) => handleTabKeydown(event, index)}
    >
      {option.label}
    </button>
  {/each}
</div>
