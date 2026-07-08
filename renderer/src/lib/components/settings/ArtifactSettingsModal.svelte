<svelte:options runes={true} />

<script lang="ts">
  import { fade } from 'svelte/transition';
  import { flyAndScale } from '$lib/utils/transitions';
  import { Briefcase, BarChart3, File, FileText, LayoutDashboard, Map, Presentation, Puzzle, Table, Workflow, X } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { getAllArtifacts, type ArtifactTypeEntry } from '$lib/services/artifact-registry';

  const artifacts = getAllArtifacts();
  const toggles = $derived(appStore.getArtifactToggles());

  function close() {
    appStore.artifactSettingsOpen = false;
  }

  async function toggleArtifact(id: string, enabled: boolean) {
    await appStore.updateArtifactToggles({ [id]: enabled });
  }

  function isEnabled(artifact: ArtifactTypeEntry): boolean {
    const toggle = toggles[artifact.id];
    return toggle === undefined ? artifact.defaultEnabled : toggle;
  }

  function getIconComponent(icon: string) {
    const map: Record<string, typeof File> = {
      'file-text': FileText,
      'briefcase': Briefcase,
      'table': Table,
      'presentation': Presentation,
      'file': File,
      'bar-chart': BarChart3,
      'workflow': Workflow,
      'map': Map,
      'layout-dashboard': LayoutDashboard,
    };
    return map[icon] || File;
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<div
  role="presentation"
  class="modal-backdrop fixed inset-0 z-[63] flex items-center justify-center overflow-hidden bg-overlay"
  transition:fade={{ duration: 200 }}
  onclick={(e) => { if (e.target === e.currentTarget) close(); }}
>
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="artifact-settings-title"
    tabindex="-1"
    class="modal-surface relative mx-3 flex max-h-[calc(100vh-2rem)] w-[calc(100vw-1.5rem)] max-w-lg flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--background)] shadow-2xl sm:mx-6 sm:max-h-[calc(100vh-4rem)]"
    transition:flyAndScale={{ y: -20, start: 0.95, duration: 250 }}
  >
    <div class="flex shrink-0 items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-5 py-3">
      <div class="flex items-center gap-2.5">
        <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-hover)]">
          <Puzzle class="h-4 w-4 text-[var(--text)]" />
        </div>
        <div>
          <h3 id="artifact-settings-title" class="text-base font-semibold text-[var(--text)]">Artifacts</h3>
          <p class="text-xs text-[var(--text-muted)]">Enable or disable artifact types the agent can produce</p>
        </div>
      </div>
      <button type="button" class="chateaui-icon-button h-7 w-7 p-0" onclick={close} aria-label="Close">
        <X class="h-3.5 w-3.5" />
      </button>
    </div>

    <div class="overflow-y-auto p-4">
      <div class="space-y-1">
        {#each artifacts as artifact (artifact.id)}
          {@const enabled = isEnabled(artifact)}
          {@const Icon = getIconComponent(artifact.icon)}
          <div
            class="flex items-center justify-between gap-4 rounded-xl px-3 py-3 transition hover:bg-[var(--surface-hover)]"
          >
            <div class="flex min-w-0 items-center gap-3">
              <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg" class:bg-[var(--surface-hover)]={!enabled} class:artifact-active-icon={enabled}>
                <span class="flex" class:text-[var(--text-muted)]={!enabled} class:text-white={enabled}>
                  <Icon class="h-4 w-4" />
                </span>
              </div>
              <div class="min-w-0">
                <h4 class="text-sm font-medium text-[var(--text)]">{artifact.name}</h4>
                <p class="truncate text-xs text-[var(--text-muted)]">{artifact.description}</p>
              </div>
            </div>
            <label class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center">
              <input
                type="checkbox"
                checked={enabled}
                class="peer sr-only"
                onchange={async () => await toggleArtifact(artifact.id, !enabled)}
              />
              <span class="absolute inset-0 rounded-full bg-[var(--surface-hover)] transition peer-checked:bg-[var(--primary)]"></span>
              <span class="absolute left-0.5 h-4 w-4 rounded-full bg-[var(--text)] transition peer-checked:translate-x-4 peer-checked:bg-[var(--primary-fg)]"></span>
            </label>
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>

<style>
  .artifact-active-icon {
    background: linear-gradient(180deg, #818af0 0%, #717CE2 52%, #626edc 100%);
  }
  .artifact-active-icon :global(svg) {
    color: #ffffff;
  }
</style>
