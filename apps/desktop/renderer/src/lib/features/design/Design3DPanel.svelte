<script lang="ts">
  import { copy } from '$lib/copy';
  import { onMount } from 'svelte';
  import { Box, Download, ExternalLink, FolderOpen, Image, Play, Square } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import { invoke, listen } from '$lib/services/bridge';
  import { DEFAULT_SCENE, type BlenderState } from '$shared/design-3d';
  import DesignModelPreview from './DesignModelPreview.svelte';

  let { chatId }: { chatId: string } = $props();
  let engine = $state<BlenderState>({ available: false, busy: false });
  let pending = $state(false);
  let error = $state('');
  let tab = $state<'model' | 'render'>('model');
  let model = $state('');
  let image = $state('');
  let assetKey = '';
  let generation = 0;
  const busy = $derived(pending || engine.busy || engine.installing);

  async function refresh() {
    const owner = chatId, version = ++generation;
    try {
      const next = await invoke<BlenderState>('design_3d', { chatId: owner, action: 'status' });
      if (owner !== chatId || version !== generation) return;
      engine = next;
      const key = `${owner}:${next.updatedAt ?? ''}`;
      if (key === assetKey) return;
      const [glb, png] = await Promise.all([
        next.model ? invoke<{ data: string }>('design_3d', { chatId: owner, action: 'asset', asset: 'model' }) : null,
        next.render ? invoke<{ data: string }>('design_3d', { chatId: owner, action: 'asset', asset: 'render' }) : null
      ]);
      if (owner !== chatId || version !== generation) return;
      model = glb?.data ?? ''; image = png ? `data:image/png;base64,${png.data}` : ''; assetKey = key;
    } catch (reason) { if (owner === chatId && version === generation) error = String(reason); }
  }
  async function action(name: string) {
    if (pending) return;
    const owner = chatId;
    pending = true; error = '';
    try {
      await invoke('design_3d', { chatId: owner, action: name, ...(name === 'build' ? { scene: DEFAULT_SCENE, render: false } : {}), ...(name === 'export' ? { asset: tab } : {}) });
      if (owner === chatId) { await refresh(); if (name === 'render') tab = 'render'; }
    } catch (reason) { if (owner === chatId) error = String(reason); }
    finally { if (owner === chatId) pending = false; }
  }
  $effect(() => { const id = chatId; assetKey = ''; model = ''; image = ''; error = ''; pending = false; if (id) void refresh(); });
  onMount(() => {
    let stopped = false, off: (() => void) | undefined;
    void listen<{ chatId: string }>('design_3d_changed', event => { if (event.chatId === chatId) void refresh(); }).then(unlisten => { if (stopped) unlisten(); else off = unlisten; });
    const timer = setInterval(() => { if (engine.busy || engine.installing) void refresh(); }, 2500);
    return () => { stopped = true; generation++; off?.(); clearInterval(timer); };
  });
</script>

<section class="three-panel" aria-label="3D studio">
  <div class="three-toolbar">
    <div class="three-tabs" role="group" aria-label="3D view">
      <Button variant="plain" type="button" class={tab === 'model' ? 'active' : ''} aria-pressed={tab === 'model'} onclick={() => tab = 'model'}><Box size={15} /> {copy.studio3d.model}</Button>
      <Button variant="plain" type="button" class={tab === 'render' ? 'active' : ''} aria-pressed={tab === 'render'} onclick={() => tab = 'render'}><Image size={15} /> {copy.studio3d.render}</Button>
    </div>
    <span class="grow"></span>
    {#if engine.available}
      <Button size="sm" variant="ghost" disabled={busy || !engine.scene} onclick={() => action('render')}><Play size={14} /> {copy.studio3d.render}</Button>
      <Button size="sm" variant="ghost" disabled={!engine.model} onclick={() => action('open')}><ExternalLink size={14} /> {copy.studio3d.open}</Button>
      <Button size="sm" variant="ghost" disabled={tab === 'model' ? !engine.model : !engine.render} onclick={() => action('export')}><Download size={14} /> {tab === 'model' ? 'GLB' : 'PNG'}</Button>
    {/if}
  </div>
  <div class="three-stage">
    {#if tab === 'model' && model}
      <DesignModelPreview data={model} scene={engine.scene} />
    {:else if tab === 'render' && image}
      <img class="render-image" src={image} alt={engine.scene?.title || 'Blender render'} />
    {:else}
      <div class="three-empty">
        <Box size={32} strokeWidth={1} />
        <h2>{engine.available ? copy.studio3d.createTitle : copy.studio3d.installTitle}</h2>
        <p>{engine.available ? copy.studio3d.createHint : copy.studio3d.installHint}</p>
        <div class="empty-actions">
          {#if engine.available}
            {#if !engine.model}<Button size="sm" disabled={busy} onclick={() => action('build')}>{copy.studio3d.createStudio}</Button>{/if}
            {#if tab === 'render' && engine.scene}<Button size="sm" disabled={busy} onclick={() => action('render')}>{copy.studio3d.renderScene}</Button>{/if}
          {:else}
            <Button size="sm" disabled={busy} onclick={() => action('install')}><Download size={14} /> {busy ? copy.studio3d.installing : copy.studio3d.download}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onclick={() => action('choose')}><FolderOpen size={14} /> {copy.studio3d.choose}</Button>
          {/if}
        </div>
        <p class="caption">{copy.studio3d.caption}</p>
      </div>
    {/if}
  </div>
  {#if busy || engine.error || error}
    <div class="job-strip" role="status">
      <span>{error || engine.error || (engine.installing ? copy.studio3d.downloadHint : engine.phase || copy.studio3d.working)}</span>
      {#if engine.busy}<Button size="sm" variant="ghost" onclick={() => { void invoke('design_3d', { chatId, action: 'cancel', jobId: engine.jobId }); }}><Square size={12} /> Stop</Button>{/if}
    </div>
  {/if}
  {#if engine.log}<details class="job-log"><summary>{copy.studio3d.output}</summary><pre>{engine.log}</pre></details>{/if}
  {#if engine.available}<div class="engine-footer"><span>{copy.studio3d.engine}</span><Button variant="plain" type="button" disabled={busy} onclick={() => action('choose')}>{copy.studio3d.change}</Button></div>{/if}
</section>

<style>
  .three-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; background: var(--background); }
  .three-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; padding: .4rem .6rem; flex-shrink: 0; }
  .three-tabs { display: flex; gap: .2rem; }
  .three-tabs :global(button) { display: flex; align-items: center; gap: .35rem; padding: .35rem .55rem; border-radius: .4rem; font-size: var(--text-xs); color: var(--muted-foreground); }
  .three-tabs :global(button.active) { background: var(--muted); color: var(--foreground); }
  .grow { flex: 1; }
  .three-stage { flex: 1; min-height: 0; overflow: hidden; position: relative; background: color-mix(in srgb, var(--muted) 35%, var(--background)); }
  .three-empty { height: 100%; overflow: auto; display: flex; align-items: center; justify-content: center; flex-direction: column; text-align: center; gap: .8rem; padding: 1.5rem; color: var(--muted-foreground); }
  h2 { font-size: var(--text-base); color: var(--foreground); font-weight: 550; }
  p { font-size: var(--text-sm); max-width: 26rem; }
  .caption { font-size: var(--text-xs); }
  .empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: .5rem; }
  .render-image { width: 100%; height: 100%; object-fit: contain; }
  .job-strip { display: flex; gap: .5rem; align-items: center; justify-content: space-between; padding: .5rem .75rem; font-size: var(--text-xs); max-height: 7rem; overflow: auto; overflow-wrap: anywhere; }
  .job-log { padding: .4rem .75rem; font-size: var(--text-xs); max-height: 8rem; overflow: auto; }
  .job-log pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .engine-footer { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: .5rem; padding: .4rem .75rem; color: var(--muted-foreground); font-size: var(--text-xs); }
  .engine-footer :global(button) { text-decoration: underline; text-underline-offset: 3px; }
</style>
