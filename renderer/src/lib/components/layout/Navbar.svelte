<svelte:options runes={true} />

<script lang="ts">
  import { Code2 } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';

  const hasArtifact = $derived(!!appStore.currentArtifact);
</script>

<header class="navbar sticky top-0 z-30 w-full">
  <div class="navbar-inner relative flex h-11 items-center px-2 md:px-3">
    <div class="flex items-center gap-0.5">
      {#if hasArtifact}
        <Tooltip label="Toggle code sandbox" position="left">
          <button
            class="nav-btn flex h-8 w-8 items-center justify-center {appStore.artifactStudioOpen ? 'is-active' : ''}"
            onclick={() => (appStore.artifactStudioOpen = !appStore.artifactStudioOpen)}
            aria-label="Toggle code sandbox"
          >
            <Code2 class="h-4 w-4" />
          </button>
        </Tooltip>
      {/if}
    </div>
    <div class="flex-1"></div>
  </div>
</header>

<style>
  .navbar {
    background: var(--background);
    border-radius: var(--radius-2xl) 0 0 0;
  }

  .nav-btn {
    color: var(--text);
    background: transparent;
    border: none;
    border-radius: 4px;
    transition: background 0.15s ease;
  }

  .nav-btn:hover {
    background: var(--surface-hover);
  }

  .nav-btn.is-active {
    background: var(--surface-hover);
  }

  .nav-btn svg {
    color: #0D2F5D;
    transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  :global(.dark) .nav-btn svg {
    color: #ffffff;
  }

  .nav-btn:hover svg {
    transform: rotate(-8deg);
  }
</style>
