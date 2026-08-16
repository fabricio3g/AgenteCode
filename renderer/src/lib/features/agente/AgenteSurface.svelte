<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { FolderPlus, Terminal } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { agenteStore } from './agente.svelte';

  onMount(() => {
    void agenteStore.load();
  });

  const activeProject = $derived(agenteStore.projectById(agenteStore.activeProjectId));
</script>

<div class="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
  {#if !agenteStore.loaded && agenteStore.loading}
    <!-- Loading projects: quiet blank beat, same as the chat empty state. -->
    <div class="flex flex-1 items-center justify-center"></div>
  {:else if !agenteStore.projects.length}
    <div class="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <div class="flex size-12 items-center justify-center rounded-2xl border border-border bg-muted">
        <Terminal class="size-6 text-muted-foreground" />
      </div>
      <div class="max-w-md space-y-1">
        <h1 class="text-xl font-semibold tracking-tight text-foreground">{$t('agente.surfaceTitle')}</h1>
        <p class="text-sm leading-relaxed text-muted-foreground">{$t('agente.noProjectsHint')}</p>
      </div>
      <button
        type="button"
        class="aui-button-primary inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium"
        onclick={() => void agenteStore.addProject()}
      >
        <FolderPlus class="size-4" />
        {$t('agente.addProject')}
      </button>
    </div>
  {:else if activeProject}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div class="flex size-12 items-center justify-center rounded-2xl border border-border bg-muted">
        <Terminal class="size-6 text-muted-foreground" />
      </div>
      <h1 class="text-lg font-semibold tracking-tight text-foreground">{activeProject.rootName}</h1>
      <p class="max-w-md text-sm leading-relaxed text-muted-foreground">
        {$t('agente.enginePending')}
      </p>
      <p class="font-mono text-xs text-muted-foreground/80">{activeProject.rootPath}</p>
    </div>
  {:else}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <div class="flex size-12 items-center justify-center rounded-2xl border border-border bg-muted">
        <Terminal class="size-6 text-muted-foreground" />
      </div>
      <p class="max-w-md text-sm leading-relaxed text-muted-foreground">{$t('agente.surfacePickProject')}</p>
    </div>
  {/if}
</div>
