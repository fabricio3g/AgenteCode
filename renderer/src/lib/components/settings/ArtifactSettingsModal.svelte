<svelte:options runes={true} />

<script lang="ts">
  import {
    BarChart3,
    Briefcase,
    Code,
    File,
    FileText,
    LayoutDashboard,
    LayoutList,
    Library,
    Map,
    Presentation,
    Table,
    Workflow
  } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import {
    getAllArtifacts,
    type ArtifactCategory,
    type ArtifactIconName,
    type ArtifactTypeEntry
  } from '$lib/services/artifact-registry';

  const artifacts = getAllArtifacts();
  const toggles = $derived(appStore.getArtifactToggles());
  let pendingIds = $state<Set<string>>(new Set());

  const categories: Array<{ id: ArtifactCategory; label: string }> = [
    { id: 'documents', label: 'Documents' },
    { id: 'visuals', label: 'Data and visuals' },
    { id: 'cards', label: 'Compact cards' },
    { id: 'research', label: 'Research' }
  ];

  const iconComponents: Record<ArtifactIconName, typeof File> = {
    'file-text': FileText,
    briefcase: Briefcase,
    table: Table,
    presentation: Presentation,
    file: File,
    'bar-chart': BarChart3,
    workflow: Workflow,
    map: Map,
    'layout-dashboard': LayoutDashboard,
    'layout-list': LayoutList,
    code: Code,
    library: Library
  };

  function close() {
    appStore.artifactSettingsOpen = false;
  }

  function isEnabled(artifact: ArtifactTypeEntry): boolean {
    return toggles[artifact.id] ?? artifact.defaultEnabled;
  }

  async function toggleArtifact(artifact: ArtifactTypeEntry, enabled: boolean) {
    if (pendingIds.has(artifact.id)) return;
    pendingIds = new Set([...pendingIds, artifact.id]);
    try {
      await appStore.updateArtifactToggles({ [artifact.id]: enabled });
    } catch (error) {
      toastStore.error(`Could not update ${artifact.name}: ${String((error as Error)?.message || error)}`);
    } finally {
      const next = new Set(pendingIds);
      next.delete(artifact.id);
      pendingIds = next;
    }
  }
</script>

<Dialog title="Artifacts" description="Choose the deliverables and visual formats available to the agent." onclose={close} class="max-w-lg">
  <div class="min-h-0 flex-1 overflow-auto px-4 py-3 sm:px-5">
    {#each categories as category (category.id)}
      <section class="mb-4 last:mb-1">
        <h3 class="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{category.label}</h3>
        <div class="space-y-0.5">
          {#each artifacts.filter((artifact) => artifact.category === category.id) as artifact (artifact.id)}
            {@const Icon = iconComponents[artifact.icon]}
            {@const enabled = isEnabled(artifact)}
            <div class="flex items-center justify-between gap-4 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-[var(--surface-hover)]">
              <div class="flex min-w-0 items-center gap-3">
                <span class:enabled class="artifact-setting-icon"><Icon class="size-4" /></span>
                <span class="min-w-0">
                  <span class="block text-sm font-medium text-foreground">{artifact.name}</span>
                  <span class="block truncate text-xs text-muted-foreground">{artifact.description}</span>
                </span>
              </div>
              <Switch checked={enabled} disabled={pendingIds.has(artifact.id)} label={`${enabled ? 'Disable' : 'Enable'} ${artifact.name}`} onchange={(checked) => toggleArtifact(artifact, checked)} />
            </div>
          {/each}
        </div>
      </section>
    {/each}
  </div>
</Dialog>

<style>
  .artifact-setting-icon {
    display: inline-flex;
    width: 2.25rem;
    height: 2.25rem;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-full);
    background: var(--muted);
    color: var(--muted-foreground);
    opacity: 0.7;
    transition:
      opacity var(--motion-fast) var(--motion-ease),
      background-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease),
      box-shadow var(--motion-fast) var(--motion-ease);
  }

  /*
   * The switch already states on/off unambiguously, so the icon only needs to
   * lift — filling it with --primary put a hard black (or white) disc against
   * every enabled row and turned the list into a column of blobs.
   *
   * --surface-active rather than --card: in dark mode --card and --muted are
   * the same #212121, which would have left enabled and disabled separated by
   * nothing but a hairline.
   */
  .artifact-setting-icon.enabled {
    background: var(--surface-active);
    color: var(--foreground);
    opacity: 1;
  }
</style>
