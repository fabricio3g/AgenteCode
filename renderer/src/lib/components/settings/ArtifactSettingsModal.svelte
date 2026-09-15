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
    Workflow,
    X
  } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import Switch from '$lib/components/ui/Switch.svelte';
  import { motionFade, flyAndScale } from '$lib/utils/transitions';
  import {
    getAllArtifacts,
    type ArtifactCategory,
    type ArtifactIconName,
    type ArtifactTypeEntry
  } from '$lib/services/artifact-registry';

  const artifacts = getAllArtifacts();
  const toggles = $derived(appStore.getArtifactToggles());
  let pendingIds = $state<Set<string>>(new Set());
  let bulkPending = $state(false);

  const enabledCount = $derived(artifacts.filter((artifact) => isEnabled(artifact)).length);

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
    if (pendingIds.has(artifact.id) || bulkPending) return;
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

  async function setAllArtifacts(enabled: boolean) {
    if (bulkPending) return;
    bulkPending = true;
    try {
      const next: Record<string, boolean> = {};
      for (const artifact of artifacts) next[artifact.id] = enabled;
      await appStore.updateArtifactToggles(next);
    } catch (error) {
      toastStore.error(`Could not update artifacts: ${String((error as Error)?.message || error)}`);
    } finally {
      bulkPending = false;
    }
  }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && close()} />

<div
  role="presentation"
  class="fixed inset-0 z-[63] flex items-center justify-center overflow-hidden bg-[var(--overlay)] p-2 sm:p-4"
  transition:motionFade={{ duration: 220 }}
  onclick={(e) => { if (e.target === e.currentTarget) close(); }}
>
  <div
    role="dialog"
    aria-modal="true"
    aria-label="Artifact settings"
    tabindex="-1"
    class="relative flex h-[min(640px,calc(100vh-2rem))] w-[min(672px,calc(100vw-2rem))] max-w-none flex-col overflow-hidden rounded-[var(--radius-2xl)] bg-popover text-foreground shadow-[shadow:var(--shadow-xl)] max-sm:h-[calc(100vh-1rem)] max-sm:w-[calc(100vw-1rem)]"
    transition:flyAndScale={{ y: 8, start: 0.98, duration: 240 }}
  >
    <div class="flex items-start justify-between gap-3 px-4 pt-4 sm:px-5">
      <div class="min-w-0 px-1 pt-1">
        <h3 class="text-lg font-semibold tracking-[-0.02em] text-foreground">Artifacts</h3>
        <p class="mt-1 text-sm text-muted-foreground">Choose the deliverables and visual formats available to the agent.</p>
      </div>
      <button
        type="button"
        class="aui-icon-button size-8 shrink-0 hover:text-[var(--error)]"
        onclick={close}
        aria-label="Close"
      >
        <X class="size-3.5" />
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-5">
      <div class="mb-3 flex items-center justify-between gap-3 px-1 pt-2">
        <span class="text-xs text-muted-foreground">{enabledCount} of {artifacts.length} enabled</span>
        <div class="flex items-center gap-1">
            <button
              type="button"
              class="rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:bg-[var(--surface-hover)] hover:text-foreground disabled:opacity-40"
              onclick={() => void setAllArtifacts(true)}
              disabled={bulkPending || enabledCount === artifacts.length}
            >Enable all</button>
            <button
              type="button"
              class="rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground transition hover:bg-[var(--surface-hover)] hover:text-foreground disabled:opacity-40"
              onclick={() => void setAllArtifacts(false)}
              disabled={bulkPending || enabledCount === 0}
            >Disable all</button>
        </div>
      </div>

      {#each categories as category (category.id)}
        <section class="mb-4 last:mb-1">
          <h4 class="mb-1.5 px-1 text-[11px] font-semibold text-muted-foreground">{category.label}</h4>
          <div class="space-y-0.5">
            {#each artifacts.filter((artifact) => artifact.category === category.id) as artifact (artifact.id)}
              {@const Icon = iconComponents[artifact.icon]}
              {@const enabled = isEnabled(artifact)}
              <div class="flex items-center justify-between gap-4 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-[var(--surface-hover)]">
                <div class="flex min-w-0 items-center gap-3">
                  <span class:enabled class="artifact-setting-icon"><Icon class="size-4" /></span>
                  <span class="min-w-0">
                    <span class="block text-sm font-medium text-foreground">{artifact.name}</span>
                    <span class="block text-xs text-muted-foreground">{artifact.description}</span>
                  </span>
                </div>
                <Switch checked={enabled} disabled={bulkPending || pendingIds.has(artifact.id)} label={`${enabled ? 'Disable' : 'Enable'} ${artifact.name}`} onchange={(checked) => toggleArtifact(artifact, checked)} />
              </div>
            {/each}
          </div>
        </section>
      {/each}
    </div>
  </div>
</div>

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
