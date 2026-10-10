<svelte:options runes={true} />
<script lang="ts">
  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import { cn as uiClass } from '$lib/utils/cn';

  import { onMount } from 'svelte';
  import { Button, Switch } from '$lib/components/ui';
  import SettingsPage from './SettingsPage.svelte';
  import { domainsStore } from '$lib/features/domains/domains.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  async function change(id: string, enabled: boolean) { try { await domainsStore.enable(id, enabled); } catch (error) { toastStore.error((error as Error).message); } }
  function size(bytes: number) { return bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
  onMount(() => { void domainsStore.load(); });
</script>
<SettingsPage title="Domains" description="Optional professional tools for Home and Coding. Media processing stays on this computer; your selected agent model stays the same.">
  <div class="domains">
    {#if domainsStore.error}<p role="alert" class="text-sm text-muted-foreground">{domainsStore.error}</p>{/if}
    {#if domainsStore.loading && !domainsStore.packs.length}<p class="text-sm text-muted-foreground">Loading local domains…</p>{/if}
    {#each domainsStore.packs as pack (pack.id)}
      <section class="domain">
        <div class="head"><div><h3>{pack.name}</h3><p>{pack.description}</p></div><Switch checked={pack.enabled} onchange={(enabled) => void change(pack.id, enabled)} label={`Enable ${pack.name}`} /></div>
        <div class="capabilities">{pack.capabilities.join(' · ')}</div>
        <details><summary>{pack.tools.length} operations · {size(pack.storageBytes)} saved media</summary>
          <ul>{#each pack.tools as tool}<li><strong>{tool.name}</strong><span>{tool.policy} · {tool.description}</span></li>{/each}</ul>
        </details>
        <div class="dependencies">
          {#each pack.dependencies as dependency}
            <div class="dependency"><div><span>{dependency.label}</span><small>{pack.availability[dependency.id]?.available ? 'Ready on this computer' : dependency.optional ? 'Optional · not installed' : 'Not installed'}</small></div><Button variant="ghost" size="sm" onclick={() => void domainsStore.pickRuntime(dependency.id)}>Choose executable</Button><a class="ui-link text-xs" href={dependency.docsUrl} target="_blank" rel="noreferrer">Install instructions</a></div>
          {/each}
        </div>
        <div class="actions"><Button variant="outline" size="sm" disabled={!pack.enabled} onclick={() => void domainsStore.create(pack.id, `Untitled ${pack.name}`)}>New project</Button><span>Disabling preserves projects and finished results.</span></div>
      </section>
    {/each}
    {#if domainsStore.projects.length}<section class="domain"><h3>Saved projects</h3>{#each domainsStore.projects as project}<UiListRow  class={uiClass("project ui-row", "ui-local-ddac653d")} onclick={() => void domainsStore.select(project)}><span>{project.title}</span><small>{domainsStore.packs.find(p => p.id === project.domain)?.name ?? project.domain} · revision {project.revision}</small></UiListRow>{/each}</section>{/if}
    {#if domainsStore.jobs.length}<section class="domain"><h3>Local processing</h3>{#each [...domainsStore.jobs].reverse().slice(0, 10) as job}<div class="dependency"><div><span>{job.domain} · {job.operation}</span><small>{job.phase}{job.progress !== undefined ? ` · ${Math.round(job.progress * 100)}%` : ''}</small></div>{#if job.state === 'running' || job.state === 'queued'}<Button variant="ghost" size="sm" onclick={() => void domainsStore.cancel(job)}>Stop</Button>{/if}</div>{/each}</section>{/if}
  </div>
</SettingsPage>
<style>
  .domains { display: flex; flex-direction: column; gap: 1rem; }
  .domain { padding: 1rem; border-radius: var(--radius-xl); background: var(--muted); }
  .head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  h3 { font-size: var(--text-base); font-weight: 600; margin: 0; }
  p, .capabilities, summary { font-size: var(--text-sm); color: var(--muted-foreground); }
  p { margin: 0.35rem 0; }
  .capabilities { margin: 0.5rem 0; }
  summary { cursor: pointer; }
  ul { padding: 0; list-style: none; } li { display: flex; flex-direction: column; gap: 0.15rem; padding: 0.35rem 0; font-size: var(--text-xs); } li span { color: var(--muted-foreground); }
  .dependencies { margin: 0.75rem 0; }.dependency { display: flex; gap: 0.75rem; align-items: center; padding: 0.35rem 0; flex-wrap: wrap; } .dependency > div { flex: 1; min-width: 10rem; display: flex; flex-direction: column; font-size: var(--text-sm); }
  small, .actions span { font-size: var(--text-xs); color: var(--muted-foreground); }
  .actions { display: flex; align-items: center; gap: 0.75rem; margin-top: 0.75rem; flex-wrap: wrap; }:global(.project.ui-local-ddac653d) { display: flex; width: 100%; justify-content: space-between; gap: 0.75rem; }
</style>
