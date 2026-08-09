<svelte:options runes={true} />

<script module lang="ts">
  let selectInstanceSequence = 0;
</script>

<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { Check, ChevronDown } from 'lucide-svelte';
  import { cn } from '$lib/utils/cn';
  import { flyAndScale } from '$lib/utils/transitions';
  import Portal from './Portal.svelte';

  export type SelectOption = {
    value: string;
    label: string;
    disabled?: boolean;
    description?: string;
  };

  type Props = {
    value?: string;
    options?: SelectOption[];
    placeholder?: string;
    variant?: 'default' | 'surface';
    id?: string;
    name?: string;
    disabled?: boolean;
    required?: boolean;
    class?: string;
    menuClass?: string;
    onchange?: (value: string) => void;
    'aria-label'?: string;
    'aria-labelledby'?: string;
  };

  let {
    value = $bindable(''),
    options = [],
    placeholder = 'Select…',
    variant = 'default',
    id,
    name,
    disabled = false,
    required = false,
    class: className = '',
    menuClass = '',
    onchange,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledby,
  }: Props = $props();

  const instanceId = `product-select-${++selectInstanceSequence}`;
  const triggerId = $derived(id || `${instanceId}-trigger`);
  const listboxId = $derived(`${triggerId}-listbox`);
  const selectedOption = $derived(options.find((option) => option.value === value));

  let triggerEl = $state<HTMLButtonElement>();
  let menuEl = $state<HTMLDivElement>();
  let open = $state(false);
  let activeIndex = $state(-1);
  let placement = $state<'top' | 'bottom'>('bottom');
  let menuStyle = $state('');
  let typeahead = '';
  let typeaheadTimer: ReturnType<typeof setTimeout> | undefined;

  function optionId(index: number): string {
    return `${listboxId}-option-${index}`;
  }

  function firstEnabledIndex(): number {
    return options.findIndex((option) => !option.disabled);
  }

  function lastEnabledIndex(): number {
    for (let index = options.length - 1; index >= 0; index -= 1) {
      if (!options[index]?.disabled) return index;
    }
    return -1;
  }

  function selectedEnabledIndex(): number {
    const index = options.findIndex((option) => option.value === value && !option.disabled);
    return index >= 0 ? index : firstEnabledIndex();
  }

  function moveActive(step: 1 | -1) {
    if (!options.length) return;
    let index = activeIndex >= 0 ? activeIndex : (step === 1 ? -1 : 0);
    for (let attempts = 0; attempts < options.length; attempts += 1) {
      index = (index + step + options.length) % options.length;
      if (!options[index]?.disabled) {
        activeIndex = index;
        void tick().then(() => {
          document.getElementById(optionId(index))?.scrollIntoView?.({ block: 'nearest' });
        });
        return;
      }
    }
  }

  function updatePosition() {
    if (!open || !triggerEl || !menuEl || typeof window === 'undefined') return;
    const viewportPadding = 8;
    const gap = 6;
    const rect = triggerEl.getBoundingClientRect();
    const naturalHeight = Math.min(menuEl.scrollHeight, 280);
    const roomBelow = window.innerHeight - rect.bottom - viewportPadding - gap;
    const roomAbove = rect.top - viewportPadding - gap;
    placement = roomBelow < naturalHeight && roomAbove > roomBelow ? 'top' : 'bottom';
    const availableHeight = Math.max(96, placement === 'bottom' ? roomBelow : roomAbove);
    const height = Math.min(naturalHeight, availableHeight);
    const width = Math.min(Math.max(rect.width, 160), window.innerWidth - viewportPadding * 2);
    const left = Math.min(
      Math.max(rect.left, viewportPadding),
      Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
    );
    const top = placement === 'bottom'
      ? rect.bottom + gap
      : Math.max(viewportPadding, rect.top - gap - height);
    menuStyle = `left:${left}px;top:${top}px;width:${width}px;max-height:${availableHeight}px;`;
  }

  async function openMenu(preferredIndex = selectedEnabledIndex()) {
    if (disabled || !options.some((option) => !option.disabled)) return;
    activeIndex = preferredIndex;
    open = true;
    await tick();
    updatePosition();
  }

  function closeMenu({ restoreFocus = false } = {}) {
    open = false;
    activeIndex = -1;
    if (restoreFocus) void tick().then(() => triggerEl?.focus());
  }

  function choose(option: SelectOption) {
    if (option.disabled) return;
    value = option.value;
    onchange?.(option.value);
    closeMenu({ restoreFocus: true });
  }

  function chooseActive() {
    const option = options[activeIndex];
    if (option) choose(option);
  }

  function handleTypeahead(key: string) {
    typeahead += key.toLocaleLowerCase();
    if (typeaheadTimer) clearTimeout(typeaheadTimer);
    typeaheadTimer = setTimeout(() => { typeahead = ''; }, 500);
    const start = activeIndex >= 0 ? activeIndex + 1 : 0;
    for (let offset = 0; offset < options.length; offset += 1) {
      const index = (start + offset) % options.length;
      const option = options[index];
      if (!option.disabled && option.label.toLocaleLowerCase().startsWith(typeahead)) {
        activeIndex = index;
        if (!open) void openMenu(index);
        return;
      }
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) void openMenu();
      else moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      if (!open) void openMenu(event.key === 'Home' ? firstEnabledIndex() : lastEnabledIndex());
      else activeIndex = event.key === 'Home' ? firstEnabledIndex() : lastEnabledIndex();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) chooseActive();
      else void openMenu();
      return;
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeMenu({ restoreFocus: true });
      return;
    }
    if (event.key === 'Tab') {
      closeMenu();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      handleTypeahead(event.key);
    }
  }

  $effect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      const path = event.composedPath();
      if (triggerEl && path.includes(triggerEl)) return;
      if (menuEl && path.includes(menuEl)) return;
      closeMenu();
    }
    function handleViewportChange() {
      updatePosition();
    }
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  });

  $effect(() => {
    if (!open) return;
    options;
    value;
    void tick().then(updatePosition);
  });

  $effect(() => {
    if (disabled && open) closeMenu();
  });

  onDestroy(() => {
    if (typeaheadTimer) clearTimeout(typeaheadTimer);
  });
</script>

<button
  bind:this={triggerEl}
  type="button"
  {disabled}
  role="combobox"
  id={triggerId}
  aria-label={ariaLabel}
  aria-labelledby={ariaLabelledby}
  aria-controls={listboxId}
  aria-expanded={open}
  aria-haspopup="listbox"
  aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
  aria-required={required || undefined}
  class={cn(
    'flex h-9 w-full items-center justify-between gap-2 rounded-md px-3 text-left text-sm text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-50',
    variant === 'surface'
      ? 'border-0 bg-[var(--card)] transition-[background-color,box-shadow] duration-[var(--motion-fast)] hover:bg-[var(--surface-hover)] focus-visible:bg-[var(--card)] focus-visible:ring-[3px] focus-visible:ring-ring/25'
      : 'border border-border bg-background transition-[border-color,box-shadow] duration-[var(--motion-fast)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20',
    className,
  )}
  onclick={() => open ? closeMenu({ restoreFocus: true }) : void openMenu()}
  onkeydown={handleKeydown}
>
  <span class={cn('min-w-0 flex-1 truncate', !selectedOption && 'text-muted-foreground')}>
    {selectedOption?.label || placeholder}
  </span>
  <ChevronDown
    class={cn(
      'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-[var(--motion-fast)] ease-[var(--motion-ease)]',
      open && 'rotate-180',
    )}
    aria-hidden="true"
  />
</button>

{#if name}
  <input type="hidden" {name} {value} />
{/if}

<Portal>
  {#if open}
    <div
      bind:this={menuEl}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      aria-labelledby={ariaLabel ? undefined : (ariaLabelledby || triggerId)}
      class={cn(
        'fixed z-[500] overflow-y-auto rounded-lg bg-[var(--card)] p-1 text-foreground shadow-[var(--shadow-lg)] ring-1 ring-black/5 dark:ring-white/10',
        placement === 'top' ? 'origin-bottom' : 'origin-top',
        menuClass,
      )}
      style={menuStyle}
      transition:flyAndScale={{ y: placement === 'top' ? 4 : -4, start: 0.97, duration: 150 }}
    >
      {#each options as option, index (option.value)}
        <button
          type="button"
          id={optionId(index)}
          role="option"
          aria-selected={option.value === value}
          aria-disabled={option.disabled || undefined}
          disabled={option.disabled}
          class={cn(
            'flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm outline-none transition-colors duration-[var(--motion-fast)] disabled:cursor-not-allowed disabled:opacity-40',
            activeIndex === index && 'bg-[var(--surface-hover)]',
            option.value === value && 'bg-[var(--surface-active)] text-foreground',
          )}
          onpointerenter={() => { if (!option.disabled) activeIndex = index; }}
          onclick={() => choose(option)}
        >
          <span class="min-w-0 flex-1">
            <span class="block truncate font-medium">{option.label}</span>
            {#if option.description}
              <span class="mt-0.5 block text-xs leading-snug text-muted-foreground">{option.description}</span>
            {/if}
          </span>
          <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
            {#if option.value === value}<Check class="h-3.5 w-3.5" aria-hidden="true" />{/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</Portal>
