<script lang="ts" module>
  import Tooltip from './Tooltip.svelte';
  let dialogCounter = 0;
</script>

<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from '$lib/icons';
  import { cn } from '$lib/utils/cn';
  import { backdropIn, backdropOut, dialogIn, dialogOut } from '$lib/utils/transitions';
  import { copy } from '$lib/copy';
  import Button from './Button.svelte';
  import Portal from './Portal.svelte';
  import DialogFooter from './DialogFooter.svelte';
  import { modalLayer } from './modal-layer';

  type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

  const SIZE_CLASS: Record<DialogSize, string> = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-3xl',
    xl: 'max-w-5xl',
    full: 'h-[92vh] max-w-[min(96vw,80rem)]'
  };

  let {
    title,
    description,
    labelledBy = `dialog-title-${++dialogCounter}`,
    onclose,
    size,
    dismissible = true,
    beforeClose,
    class: className = '',
    children,
    headerActions,
    hideHeader = false,
    footer
  }: {
    title: string;
    description?: string;
    labelledBy?: string;
    onclose: () => void;
    /** Width preset. Omit to size through `class` (legacy callers). */
    size?: DialogSize;
    /** Backdrop click closes the dialog. Escape and the X always ask. */
    dismissible?: boolean;
    /**
     * Guard for dirty forms: return false (or a promise of false) to keep the
     * dialog open, e.g. after asking the user to discard their changes.
     */
    beforeClose?: () => boolean | Promise<boolean>;
    class?: string;
    children?: Snippet;
    headerActions?: Snippet;
    /** A reader supplies its own toolbar and close action. */
    hideHeader?: boolean;
    /** Action row pinned under the content: secondary actions first, primary last. */
    footer?: Snippet;
  } = $props();

  async function requestClose() {
    if (beforeClose && !(await beforeClose())) return;
    onclose();
  }
</script>

<Portal>
  <div
    class="ui-modal-backdrop"
    role="presentation"
    use:modalLayer={{ onclose: () => void requestClose() }}
    onclick={() => {
      if (dismissible) void requestClose();
    }}
    in:backdropIn
    out:backdropOut
  >
    <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      tabindex="-1"
      class={cn(
        'ui-modal-surface relative flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--float-border)] bg-[var(--float-bg)] text-foreground shadow-[shadow:var(--float-shadow)] outline-none',
        size ? SIZE_CLASS[size] : '',
        className
      )}
      onclick={(event) => event.stopPropagation()}
      in:dialogIn
      out:dialogOut
    >
      {#if hideHeader}<h2 id={labelledBy} class="sr-only">{title}</h2>{:else}
      <header class="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-2.5 sm:px-5">
        <div class="min-w-0">
          <h2 id={labelledBy} class="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
          {#if description}<p class="truncate text-xs text-muted-foreground">{description}</p>{/if}
        </div>
        <div class="flex items-center gap-1">
          {@render headerActions?.()}
          <Tooltip label={copy.actions.close} position="bottom"><Button variant="ghost" size="icon-sm" aria-label={copy.actions.close} onclick={() => void requestClose()}>
            <X />
          </Button></Tooltip>
        </div>
      </header>
      {/if}
      <!-- The body scrolls when the dialog is taller than the window (small
           windows, large interface sizes); bodies with their own scroller
           still get a bounded height from this flex column. -->
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {@render children?.()}
      </div>
      {#if footer}
        <DialogFooter separated>
          {@render footer()}
        </DialogFooter>
      {/if}
    </div>
  </div>
</Portal>
