
<svelte:options runes={true} />

<!--
  The design systems library: save the open design as a system, then manage
  what is saved. Each system shows a live thumbnail of its specimen page (an
  offline, script-free frame) or, without one, its colours. Use, rename and
  delete act on the library; "use" also copies the system into the open design.
-->

<script lang="ts">
  import IconButton from '$lib/components/ui/IconButton.svelte';

  import { untrack } from 'svelte';
  import { Check, Pencil, Trash2 } from '$lib/icons';
  import { Button, Dialog, Input } from '$lib/components/ui';
  import { copy } from '$lib/copy';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { buildPreviewHtml } from '$lib/utils/preview-builder';
  import type { DesignSystemDetail, DesignSystemSummary } from '$shared/design';
  import { designStore } from './design.svelte';
  import { designSystems } from './design-systems.svelte';
  import { cleanSystemName, SYSTEM_DESCRIPTION_MAX, SYSTEM_NAME_MAX, systemSwatches } from './design-systems';

  let { onclose }: { onclose: () => void } = $props();

  /** Thumbnails render at this width, then scale down to the row's 8.5rem preview column (1280 × 0.1 = 128px). */
  const THUMB_WIDTH = 1280;
  const THUMB_SCALE = 0.1;

  const chatId = $derived(designStore.chatId);
  const linkedId = $derived(designSystems.linked?.id ?? null);

  let name = $state('');
  let description = $state('');
  let saving = $state(false);
  let renaming = $state<string | null>(null);
  let renameValue = $state('');
  let details = $state<Record<string, DesignSystemDetail>>({});
  const requested = new Set<string>();

  // Fetch each system's files once, for its thumbnail and swatches.
  $effect(() => {
    const ids = designSystems.list.map((system) => system.id);
    untrack(() => {
      for (const id of ids) {
        if (requested.has(id)) continue;
        requested.add(id);
        designSystems.detail(id).then((detail) => { details[id] = detail; }).catch(() => { requested.delete(id); });
      }
    });
  });

  function thumb(id: string): string {
    const files = details[id]?.files.files;
    const source = files?.['components.html'];
    if (!files || source === undefined) return '';
    try { return buildPreviewHtml(source, files, 'components.html', false).html; } catch { return ''; }
  }

  const time = (ts: number) => new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const originLabel = (system: DesignSystemSummary) => (system.origin === 'folder' ? copy.design.systems.fromFolder : copy.design.systems.fromDesign);

  async function save() {
    const cleaned = cleanSystemName(name);
    if (!cleaned || !chatId || saving) return;
    saving = true;
    try {
      await designSystems.save(chatId, cleaned, description.trim().slice(0, SYSTEM_DESCRIPTION_MAX));
      name = '';
      description = '';
      toastStore.success(copy.design.systems.saved);
    } catch (cause) {
      toastStore.error(String(cause));
    } finally {
      saving = false;
    }
  }

  async function apply(system: DesignSystemSummary) {
    if (!chatId) return;
    try {
      await designSystems.apply(chatId, system.id);
      toastStore.success(copy.design.systems.applied);
    } catch (cause) {
      toastStore.error(String(cause));
    }
  }

  function startRename(system: DesignSystemSummary) {
    renaming = system.id;
    renameValue = system.name;
  }

  async function commitRename(system: DesignSystemSummary) {
    // Enter submits and then the field unmounts, which blurs it again: only the first commit counts.
    if (renaming !== system.id) return;
    const cleaned = cleanSystemName(renameValue);
    renaming = null;
    if (!cleaned || cleaned === system.name) return;
    try {
      await designSystems.rename(system.id, cleaned);
    } catch (cause) {
      toastStore.error(String(cause));
    }
  }

  async function remove(system: DesignSystemSummary) {
    const confirmed = await confirmStore.ask({
      title: copy.design.systems.deleteTitle,
      message: copy.design.systems.deleteMessage,
      confirmLabel: copy.design.systems.deleteConfirm,
      danger: true
    });
    if (!confirmed) return;
    try {
      await designSystems.remove(system.id);
      delete details[system.id];
      requested.delete(system.id);
    } catch (cause) {
      toastStore.error(String(cause));
    }
  }
</script>

<Dialog size="lg" title={copy.design.systems.title} {onclose}>
  <div class="body">
    {#if chatId}
      <form class="save" onsubmit={(event) => { event.preventDefault(); void save(); }}>
        <h3>{copy.design.systems.saveTitle}</h3>
        <div class="save-fields">
          <label class="save-name">
            <span class="sr-only">{copy.design.systems.nameLabel}</span>
            <Input bind:value={name} maxlength={SYSTEM_NAME_MAX} placeholder={copy.design.systems.namePlaceholder} aria-label={copy.design.systems.nameLabel} />
          </label>
          <label class="save-description">
            <span class="sr-only">{copy.design.systems.descriptionLabel}</span>
            <Input bind:value={description} maxlength={SYSTEM_DESCRIPTION_MAX} placeholder={copy.design.systems.descriptionPlaceholder} aria-label={copy.design.systems.descriptionLabel} />
          </label>
          <Button type="submit" size="sm" disabled={!cleanSystemName(name) || saving}>{copy.design.systems.save}</Button>
        </div>
      </form>
    {:else}
      <p class="hint">{copy.design.systems.noSave}</p>
    {/if}

    <section class="library" aria-label={copy.design.systems.listTitle}>
      <h3>{copy.design.systems.listTitle}</h3>
      {#if designSystems.list.length === 0}
        <p class="empty" title={copy.design.systems.emptyHint}>{copy.design.systems.empty}</p>
      {:else}
        <ul>
          {#each designSystems.list as system (system.id)}
            {@const preview = thumb(system.id)}
            {@const swatches = systemSwatches(details[system.id]?.files.files['tokens.css'] ?? '')}
            <li class="row" class:linked={linkedId === system.id}>
              <div class="preview" aria-hidden="true">
                {#if preview}
                  <span class="thumb" style:width="{THUMB_WIDTH * THUMB_SCALE}px" style:height="{THUMB_WIDTH * THUMB_SCALE * 0.62}px">
                    <iframe srcdoc={preview} sandbox="" tabindex="-1" title="" style:width="{THUMB_WIDTH}px" style:height="{THUMB_WIDTH * 0.62}px" style:transform="scale({THUMB_SCALE})"></iframe>
                  </span>
                {:else}
                  <span class="swatches">
                    {#each swatches as color, index (index)}<span class="swatch" style:background={color}></span>{:else}<span class="none">{copy.design.systems.noSpecimen}</span>{/each}
                  </span>
                {/if}
              </div>

              <div class="meta">
                {#if renaming === system.id}
                  <form class="rename" onsubmit={(event) => { event.preventDefault(); void commitRename(system); }}>
                    <Input bind:value={renameValue} maxlength={SYSTEM_NAME_MAX} aria-label={copy.design.systems.nameLabel} onblur={() => void commitRename(system)} />
                  </form>
                {:else}
                  <span class="name">{system.name}</span>
                {/if}
                <span class="sub">
                  {originLabel(system)} · {time(system.updatedAt)}{system.hasTokens ? ` · ${copy.design.systems.tokens}` : ''}{system.hasSpecimen ? ` · ${copy.design.systems.specimen}` : ''}
                </span>
                {#if system.description}<span class="desc">{system.description}</span>{/if}
              </div>

              <div class="actions">
                {#if chatId}
                  {#if linkedId === system.id}
                    <span class="in-use"><Check aria-hidden="true" />{copy.design.systems.inUse}</span>
                  {:else}
                    <Button size="xs" variant="ghost" onclick={() => void apply(system)}>{copy.design.systems.apply}</Button>
                  {/if}
                {/if}
                <IconButton label={copy.design.systems.rename} size="sm" variant="ghost"  title={copy.design.systems.rename} onclick={() => startRename(system)}><Pencil aria-hidden="true" /></IconButton>
                <IconButton label={copy.design.systems.delete} size="sm" variant="ghost"  title={copy.design.systems.delete} onclick={() => void remove(system)}><Trash2 aria-hidden="true" /></IconButton>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</Dialog>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    padding: 1rem 1.25rem 1.25rem;
  }

  /* Section labels read like the app's menu labels: small, muted, not capitalised. */
  h3 {
    margin: 0 0 0.5rem;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--muted-foreground);
  }

  .save-fields {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;
    align-items: center;
    gap: 0.5rem;
  }

  .hint,
  .empty {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--muted-foreground);
  }

  .empty { color: var(--foreground); }

  ul {
    display: flex;
    margin: 0;
    padding: 0;
    flex-direction: column;
    gap: 0.5rem;
    list-style: none;
  }

  .row {
    display: grid;
    grid-template-columns: 8.5rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.875rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border-subtle);
  }

  .row.linked { background: var(--muted); }

  /* The preview is artwork: a scaled-down page in a frame that never takes input. */
  .preview { min-width: 0; }

  .thumb {
    position: relative;
    display: block;
    overflow: hidden;
    border-radius: 0.375rem;
    background: #fff;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
  }

  .thumb iframe {
    position: absolute;
    inset: 0 auto auto 0;
    border: 0;
    pointer-events: none;
    transform-origin: top left;
  }

  .swatches {
    display: flex;
    height: 2.25rem;
    align-items: center;
    gap: 0.25rem;
    flex-wrap: wrap;
  }

  .swatch {
    width: 1.25rem;
    height: 1.25rem;
    border-radius: var(--radius-full);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--foreground) 12%, transparent);
  }

  .none {
    font-size: var(--text-xs);
    color: var(--muted-foreground);
  }

  .meta {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.125rem;
  }

  .name {
    overflow: hidden;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--foreground);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sub,
  .desc {
    overflow: hidden;
    font-size: var(--text-xs);
    color: var(--muted-foreground);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rename { margin: 0; }

  .actions {
    display: flex;
    align-items: center;
    gap: 0.125rem;
  }

  .in-use {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0 0.5rem;
    font-size: var(--text-xs);
    color: var(--brand-accent);
  }

  .in-use :global(svg) { width: 0.75rem; height: 0.75rem; }

  @media (max-width: 560px) {
    .save-fields { grid-template-columns: minmax(0, 1fr); }
    .row { grid-template-columns: minmax(0, 1fr); }
    .preview { max-width: 12rem; }
  }
</style>
