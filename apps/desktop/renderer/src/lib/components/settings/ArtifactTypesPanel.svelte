<svelte:options runes={true} />

<!-- Which artifact types the agent may produce, grouped by category. -->

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
    Sparkles,
    Table,
    Workflow
  } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { get } from 'svelte/store';
  import { appStore } from '$lib/stores/app.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
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
  let bulkPending = $state(false);

  const enabledCount = $derived(artifacts.filter((artifact) => isEnabled(artifact)).length);

  const categories: ArtifactCategory[] = ['documents', 'visuals', 'cards'];

  /** Built-in types read in the UI language; unknown ones keep their own text. */
  function typeText(artifact: ArtifactTypeEntry, field: 'name' | 'description'): string {
    const id = `artifacts.types.${artifact.id}.${field}`;
    const text = get(t)(id);
    return text === id ? artifact[field] : text;
  }

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
    library: Library,
    sparkles: Sparkles
  };

  function isEnabled(artifact: ArtifactTypeEntry): boolean {
    return toggles[artifact.id] ?? artifact.defaultEnabled;
  }

  async function toggleArtifact(artifact: ArtifactTypeEntry, enabled: boolean) {
    if (pendingIds.has(artifact.id) || bulkPending) return;
    pendingIds = new Set([...pendingIds, artifact.id]);
    try {
      await appStore.updateArtifactToggles({ [artifact.id]: enabled });
    } catch (error) {
      toastStore.error(get(t)('artifacts.typesUpdateFailed', { values: { reason: String((error as Error)?.message || error) } }));
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
      toastStore.error(get(t)('artifacts.typesUpdateFailed', { values: { reason: String((error as Error)?.message || error) } }));
    } finally {
      bulkPending = false;
    }
  }
</script>

<div class="space-y-5">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <p class="text-sm text-muted-foreground">{$t('artifacts.typesHint')}</p>
    <div class="flex items-center gap-1">
      <span class="mr-2 text-xs tabular-nums text-muted-foreground">{$t('artifacts.typesEnabled', { values: { n: enabledCount, total: artifacts.length } })}</span>
      <button type="button" class="bulk-btn" onclick={() => void setAllArtifacts(true)} disabled={bulkPending || enabledCount === artifacts.length}>{$t('artifacts.enableAll')}</button>
      <button type="button" class="bulk-btn" onclick={() => void setAllArtifacts(false)} disabled={bulkPending || enabledCount === 0}>{$t('artifacts.disableAll')}</button>
    </div>
  </div>

  {#each categories as category (category)}
    <section>
      <h4 class="px-1 pb-2 text-[13px] font-semibold text-foreground">{$t(`artifacts.category.${category}`)}</h4>
      <div class="type-rows overflow-hidden rounded-[0.875rem] border border-[var(--border)] bg-[var(--card)] px-2 py-1">
        {#each artifacts.filter((artifact) => artifact.category === category) as artifact (artifact.id)}
          {@const Icon = iconComponents[artifact.icon]}
          {@const enabled = isEnabled(artifact)}
          <div class="flex items-center justify-between gap-4 rounded-xl px-2.5 py-2.5">
            <div class="flex min-w-0 items-center gap-3">
              <span class:enabled class="artifact-setting-icon"><Icon class="size-4" /></span>
              <span class="min-w-0">
                <span class="block text-sm font-medium text-foreground">{typeText(artifact, 'name')}</span>
                <span class="block text-xs text-muted-foreground">{typeText(artifact, 'description')}</span>
              </span>
            </div>
            <Switch checked={enabled} disabled={bulkPending || pendingIds.has(artifact.id)} label={typeText(artifact, 'name')} onchange={(checked) => toggleArtifact(artifact, checked)} />
          </div>
        {/each}
      </div>
    </section>
  {/each}
</div>

<style>
  .type-rows > :global(* + *) {
    border-top: 1px solid var(--border-subtle);
  }

  .bulk-btn {
    border-radius: 9999px;
    padding: 0.25rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--muted-foreground);
  }
  .bulk-btn:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--foreground);
  }
  .bulk-btn:disabled {
    opacity: 0.4;
  }

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
