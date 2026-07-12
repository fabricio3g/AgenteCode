<svelte:options runes={true} />

<script lang="ts">
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
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
      briefcase: Briefcase,
      table: Table,
      presentation: Presentation,
      file: File,
      'bar-chart': BarChart3,
      workflow: Workflow,
      map: Map,
      'layout-dashboard': LayoutDashboard
    };
    return map[icon] || File;
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<div
  role="presentation"
  class="aui-modal-backdrop z-[63]"
  transition:motionFade={{ duration: 200 }}
  onclick={(e) => {
    if (e.target === e.currentTarget) close();
  }}
>
  <div
    role="dialog"
    aria-modal="true"
    aria-labelledby="artifact-settings-title"
    tabindex="-1"
    class="aui-modal-surface max-w-lg"
    transition:flyAndScale={{ y: -20, start: 0.95, duration: 250 }}
  >
    <div class="aui-modal-header">
      <div class="flex min-w-0 items-center gap-2.5">
        <div class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Puzzle class="size-4 text-foreground" />
        </div>
        <div class="min-w-0">
          <h3 id="artifact-settings-title" class="aui-modal-title">Artifacts</h3>
          <p class="text-xs text-muted-foreground">Enable or disable artifact types the agent can produce</p>
        </div>
      </div>
      <button type="button" class="aui-icon-button size-8" onclick={close} aria-label="Close">
        <X class="size-3.5" />
      </button>
    </div>

    <div class="aui-modal-body !pt-0">
      <div class="space-y-0.5">
        {#each artifacts as artifact (artifact.id)}
          {@const enabled = isEnabled(artifact)}
          {@const Icon = getIconComponent(artifact.icon)}
          <div class="flex items-center justify-between gap-4 rounded-md px-2 py-2.5 transition hover:bg-muted">
            <div class="flex min-w-0 items-center gap-3">
              <div
                class="flex size-8 shrink-0 items-center justify-center rounded-md {enabled
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground'}"
              >
                <Icon class="size-4" />
              </div>
              <div class="min-w-0">
                <h4 class="text-sm font-medium text-foreground">{artifact.name}</h4>
                <p class="truncate text-xs text-muted-foreground">{artifact.description}</p>
              </div>
            </div>
            <label class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center">
              <input
                type="checkbox"
                checked={enabled}
                class="peer sr-only"
                onchange={async () => await toggleArtifact(artifact.id, !enabled)}
              />
              <span class="absolute inset-0 rounded-full bg-muted transition peer-checked:bg-primary"></span>
              <span
                class="absolute left-0.5 size-4 rounded-full bg-foreground transition peer-checked:translate-x-4 peer-checked:bg-primary-foreground"
              ></span>
            </label>
          </div>
        {/each}
      </div>
    </div>
  </div>
</div>
