<svelte:options runes={true} />

<script lang="ts">
  import { cubicOut } from 'svelte/easing';
  import Thread from '$lib/features/chat/thread/Thread.svelte';
  import Composer from '$lib/features/chat/Composer.svelte';
  import ActivityDrawer from '$lib/components/agent/ActivityDrawer.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';

  const threadIsEmpty = $derived(!(appStore.currentChat?.messages?.length));

  /**
   * Slide the activity panel in from the right edge.
   *
   * Deliberately transform/opacity only. The previous version animated `width`,
   * which made the whole conversation reflow and re-wrap on every open and
   * close; the panel now floats above the thread and leaves it untouched.
   */
  function drawerSlotTransition(_node: Element) {
    return {
      duration: 260,
      easing: cubicOut,
      css: (t: number, u: number) => `
        opacity: ${t};
        transform: translateX(${u * 100}%);
      `
    };
  }
</script>

<div class="chat-panel relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
  <!-- Empty conversation: the prompt and the composer sit together in
       the middle of the panel. The composer drops to the bottom as soon
       as there is a message to read above it. -->
  <div
    class="chat-content-layer relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    class:justify-center={threadIsEmpty}
  >
    {#if threadIsEmpty}
      <h1 class="empty-greeting">{copy.emptyState.greeting}</h1>
    {/if}
    <Thread />
    <Composer />
  </div>

  <!-- Floats over the conversation: opening it must not reflow the
       thread or the composer. -->
  {#if appStore.activityDrawerOpen}
    <div class="activity-drawer-slot" transition:drawerSlotTransition>
      <ActivityDrawer />
    </div>
  {/if}
</div>

<style>
  /* Anchors the centred empty state. Sized to lead the composer without
     competing with it — the composer is still where the eye should land. */
  .empty-greeting {
    margin: 0 auto 1.5rem;
    padding: 0 1rem;
    max-width: 48rem;
    color: var(--foreground);
    font-size: 1.5rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.25;
    text-align: center;
    text-wrap: balance;
  }

  @media (max-width: 640px) {
    .empty-greeting {
      margin-bottom: 1.125rem;
      font-size: 1.25rem;
    }
  }

  .chat-panel {
    background: var(--background);
    /* No seam between the rail and the conversation — they are one surface. */
    border: 0;
    border-radius: var(--radius-2xl) 0 0 0;
  }

  /*
   * A floating panel, not a layout column. It is absolutely positioned inside
   * the chat panel and inset from the edges, so showing it never changes the
   * width of the thread or the composer — it only ever animates its own
   * transform and opacity.
   */
  .activity-drawer-slot {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    bottom: 0.75rem;
    z-index: 30;
    display: flex;
    overflow: hidden;
    border: 1px solid var(--panel-border);
    border-radius: var(--radius-2xl);
    background: var(--popover);
    box-shadow: var(--shadow-xl);
    transform-origin: right center;
    will-change: transform, opacity;
  }
</style>
