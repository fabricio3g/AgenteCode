<svelte:options runes={true} />
<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Button } from '$lib/components/ui';
  import { domainsStore } from './domains.svelte';
  import type { MediaAssetRef } from '$shared/domains';
  const project = $derived(domainsStore.project!);
  const enabled = $derived(domainsStore.packs.find(p => p.id === project.domain)?.enabled ?? false);
  let asset = $state<MediaAssetRef | null>(null); let url = $state(''); let result = $state(''); let busy = $state(false);
  let width = $state(1024); let height = $state(768); let start = $state(0); let duration = $state(10); let captions = $state(''); let vector = $state(''); let preview = $state('');
  let scene = $state(JSON.stringify({ objects: [{ name: 'Object', type: 'cube', location: [0,0,0], scale: [1,1,1], color: [0.3,0.4,0.5,1] }], camera: { location: [5,-5,4], rotation: [1.1,0,0.8] }, lights: [{ type: 'AREA', location: [2,-3,5], energy: 500 }], width: 1024, height: 768 }, null, 2));
  function perform(action: () => Promise<unknown>) { busy = true; void action().catch(error => { domainsStore.error = (error as Error).message; }).finally(() => { busy = false; }); }
  onDestroy(() => { if (url.startsWith('blob:')) URL.revokeObjectURL(url); if (preview.startsWith('blob:')) URL.revokeObjectURL(preview); });
  async function choose(next: MediaAssetRef) { asset = next; if (url.startsWith('blob:')) URL.revokeObjectURL(url); if (next.kind !== 'scene') url = await domainsStore.url(next); else url = ''; if (next.name.endsWith('.svg')) { const svg = await domainsStore.call<{ svg: string }>('design', 'svg_read', { assetId: next.id }); vector = svg.svg; } }
  async function add(next: MediaAssetRef) { await domainsStore.patch({ assets: [...project.assets.filter(a => a.id !== next.id), next] }, `Add ${next.name}`); await choose(next); }
  async function inspect() { if (!asset) return; result = JSON.stringify(await domainsStore.call(project.domain, 'inspect', { assetId: asset.id }), null, 2); }
  async function transform() { if (!asset) return; await add(await domainsStore.call<MediaAssetRef>('design', 'transform', { assetId: asset.id, width, height, format: 'png' }, 'write')); }
  async function svg() { const created = await domainsStore.call<{ asset: MediaAssetRef; preview: MediaAssetRef }>('design', 'svg_write', { svg: vector }, 'write'); await add(created.asset); preview = await domainsStore.url(created.preview); }
  async function editVideo() { if (!asset) return; await add(await domainsStore.call<MediaAssetRef>('video', 'edit', { assetId: asset.id, start, duration, ...(captions ? { captionsSrt: captions } : {}) }, 'write')); }
  async function renderScene() { const definition = JSON.parse(scene); await domainsStore.patch({ scene: definition }, 'Update scene'); const rendered = await domainsStore.call<{ scene: MediaAssetRef; preview: MediaAssetRef }>('3d', 'render', definition, 'write'); await add(rendered.scene); preview = await domainsStore.url(rendered.preview); }
</script>
<div class="creative">
  <div class="toolbar"><label>Import<input type="file" disabled={!enabled || busy} onchange={event => { const file = event.currentTarget.files?.[0]; if (file) perform(async () => { const next = await domainsStore.importFile(file); if (next) await choose(next); }); }} /></label><Button size="sm" variant="ghost" disabled={!enabled || busy} onclick={() => perform(() => domainsStore.history('undo'))}>Undo</Button><Button size="sm" variant="ghost" disabled={!enabled || busy} onclick={() => perform(() => domainsStore.history('redo'))}>Redo</Button><Button size="sm" variant="ghost" disabled={!enabled || !asset || busy} onclick={() => perform(inspect)}>Inspect</Button></div>
  {#if domainsStore.error}<p role="alert">{domainsStore.error}</p>{/if}
  {#if !enabled}<p>This domain is disabled. Saved assets and previews remain available.</p>{/if}
  <div class="content"><aside><h3>Assets & layers</h3>{#each project.assets as next}<button class="asset" class:selected={asset?.id === next.id} onclick={() => perform(() => choose(next))}>{next.name}<small>{next.kind} · {(next.bytes / 1024).toFixed(0)} KB</small></button>{/each}</aside><main>
    {#if url && asset?.kind === 'image'}<div class="canvas"><img src={url} alt={asset.name} /></div>{:else if url && asset?.kind === 'video'}<video src={url} controls><track kind="captions" label="Captions" /></video>{/if}
    {#if preview}<img class="preview" src={preview} alt="Rendered preview" />{/if}
    {#if project.domain === 'design'}
      <div class="toolbar"><label>Width<input aria-label="Image width" type="number" min="1" max="16384" bind:value={width} /></label><label>Height<input aria-label="Image height" type="number" min="1" max="16384" bind:value={height} /></label><Button size="sm" disabled={!enabled || !asset || busy} onclick={() => perform(transform)}>Create variant</Button><Button size="sm" variant="ghost" disabled={!enabled || !asset || busy} onclick={() => perform(async () => { result = JSON.stringify(await domainsStore.call('design', 'palette', { assetId: asset!.id }), null, 2); })}>Extract palette</Button></div>
      <details><summary>Vector source</summary><textarea aria-label="SVG vector source" rows="10" bind:value={vector} placeholder="Self-contained SVG"></textarea><Button size="sm" disabled={!enabled || !vector || busy} onclick={() => perform(svg)}>Create vector asset</Button></details>
    {:else if project.domain === 'video'}
      <div class="toolbar"><label>Start<input aria-label="Video start" type="number" min="0" step="0.1" bind:value={start} /></label><label>Length<input aria-label="Video length" type="number" min="0.1" step="0.1" bind:value={duration} /></label><Button size="sm" disabled={!enabled || !asset || busy} onclick={() => perform(editVideo)}>Render selection</Button><Button size="sm" variant="ghost" disabled={!enabled || !asset || busy} onclick={() => perform(async () => { const frames = await domainsStore.call<{ asset: MediaAssetRef }>('video', 'frames', { assetId: asset!.id, start, duration, count: 12 }); preview = await domainsStore.url(frames.asset); })}>Contact sheet</Button><Button size="sm" variant="ghost" disabled={!enabled || project.assets.filter(a => a.kind === 'video').length < 2 || busy} onclick={() => perform(async () => { await add(await domainsStore.call<MediaAssetRef>('video', 'assemble', { assetIds: project.assets.filter(a => a.kind === 'video').map(a => a.id) }, 'write')); })}>Assemble videos</Button></div>
      <label>Captions (SRT)<textarea aria-label="SRT captions" rows="8" bind:value={captions}></textarea></label>
    {:else if project.domain === '3d'}
      <label>Scene definition<textarea aria-label="Scene geometry, materials, camera and lights" rows="18" bind:value={scene}></textarea></label><Button size="sm" disabled={!enabled || busy} onclick={() => perform(renderScene)}>Render scene</Button>
    {/if}
    {#if result}<details open><summary>Inspection</summary><pre>{result}</pre></details>{/if}
  </main></div>
</div>
<style>
  .creative { display:flex; flex-direction:column; padding:1rem; gap:0.75rem; height:100%; min-height:0; }.toolbar { display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap; } label,p,summary { font-size:var(--text-sm); } .toolbar label { display:flex; gap:0.35rem; align-items:center; }.toolbar input[type=number] { width:5rem; } .content { display:grid; grid-template-columns:12rem minmax(0,1fr); overflow:hidden; flex:1; } aside,main { overflow:auto; padding:0.5rem; } h3 { font-size:var(--text-sm); font-weight:600; }.asset { display:block; padding:0.5rem; width:100%; text-align:left; border-radius:var(--radius-sm); font-size:var(--text-sm); }.asset.selected { background:var(--muted); } small { display:block; font-size:var(--text-xs); color:var(--muted-foreground); }.canvas { padding:1rem; background:var(--muted); border-radius:var(--radius-lg); }.canvas img,.preview,video { max-width:100%; max-height:26rem; display:block; margin:0.5rem auto; } textarea,input { color:var(--foreground); background:var(--background); border:1px solid var(--border-subtle); border-radius:var(--radius-sm); padding:0.4rem; font-size:var(--text-code); } textarea { display:block; width:100%; margin:0.5rem 0; font-family:var(--font-mono); } pre { max-height:20rem; overflow:auto; font-size:var(--text-code); } @media(max-width:700px) { .content { grid-template-columns:1fr; } aside { max-height:8rem; } }
</style>
