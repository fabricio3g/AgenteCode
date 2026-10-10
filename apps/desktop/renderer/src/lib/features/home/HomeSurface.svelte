<svelte:options runes={true} />

<script lang="ts">
  import { motionFly } from '$lib/utils/transitions';
  import Thread from '$lib/features/chat/thread/Thread.svelte';
  import Composer from '$lib/features/chat/Composer.svelte';
  import ActivityDrawer from '$lib/components/agent/ActivityDrawer.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import GreetingTiles from './GreetingTiles.svelte';

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
      <div class="greeting-stage"><GreetingTiles /><h1 class="empty-greeting">{copy.emptyState.greeting}</h1></div>
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
  /* Anchors the centred empty state. Sized to lead the composer without
     competing with it — the composer is still where the eye should land. */
  /* The tiles sit behind the heading, not inside it: the heading's text is a
     clipped gradient, and anything inside it would paint over the letters. */
  .greeting-stage {
    position: relative;
    isolation: isolate;
  }

  .empty-greeting {
    position: relative;
    z-index: 1;
    margin: 0 auto 1.5rem;
    padding: 0 1rem;
    max-width: 48rem;
    /* The text itself carries a faint top-to-bottom tone, not a flat fill. */
    background: linear-gradient(180deg, var(--foreground) 35%, color-mix(in srgb, var(--foreground) 62%, var(--brand-accent)));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
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
    border: 1px solid var(--float-border);
    border-radius: var(--radius-2xl);
    background: var(--float-bg);
    box-shadow: var(--float-shadow);
    transform-origin: right center;
    will-change: transform, opacity;
  }
</style>
