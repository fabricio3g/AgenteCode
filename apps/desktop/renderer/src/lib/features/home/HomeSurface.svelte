<svelte:options runes={true} />

<script lang="ts">
  import { motionFly } from '$lib/utils/transitions';
  import Thread from '$lib/features/chat/thread/Thread.svelte';
  import Composer from '$lib/features/chat/Composer.svelte';
  import ActivityDrawer from '$lib/components/agent/ActivityDrawer.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';

  const threadIsEmpty = $derived(!(appStore.currentChat?.messages?.length));

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
      <!-- One headline on the composer's own column, the same three-row
           composition every empty surface uses: what this space is for, the
           composer, then the starter links under it. -->
      <h1 class="empty-greeting composer-column px-3 md:px-6">{copy.emptyState.greeting}</h1>
    {/if}
    <Thread />
    <Composer />
  </div>

  <!-- Floats over the conversation: opening it must not reflow the
       thread or the composer. -->
  {#if appStore.activityDrawerOpen}
    <div class="activity-drawer-slot" transition:motionFly={{ x: 24, duration: 160 }}>
      <ActivityDrawer />
    </div>
  {/if}
</div>

<style>
  /* Anchors the centred empty state, on the composer's column so the headline
     starts on the card's edge instead of floating centred above it. Same size
     and weight as the Design dock's invitation: the composer stays the largest
     thing on the screen. */
  .empty-greeting {
    position: relative;
    z-index: 1;
    margin-block: 0 0.75rem;
    color: var(--foreground);
    font-size: 1.0625rem;
    font-weight: 600;
    letter-spacing: -0.015em;
    line-height: 1.25;
    text-align: left;
    text-wrap: pretty;
  }

  @media (max-width: 640px) {
    .empty-greeting {
      margin-bottom: 0.5rem;
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
    border: 1px solid var(--float-border);
    border-radius: var(--radius-2xl);
    background: var(--float-bg);
    box-shadow: var(--float-shadow);
    transform-origin: right center;
    will-change: transform, opacity;
  }
</style>
