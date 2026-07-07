<svelte:options runes={true} />

<script lang="ts">
  import { ChevronDown, ChevronRight, FileCode2, Folder } from 'lucide-svelte';
  import type { CodeAgentDiffStat } from '$lib/types/chat';

  interface Props { stats: CodeAgentDiffStat[] }

  let { stats }: Props = $props();
  let expanded = $state<Set<string>>(new Set());

  const adds = $derived(stats.reduce((s, d) => s + d.additions, 0));
  const dels = $derived(stats.reduce((s, d) => s + d.deletions, 0));

  type Node = { name: string; path: string; isDir: boolean; children: Node[]; stat?: CodeAgentDiffStat; ca: number; cd: number; cf: number };

  const root = $derived.by(() => {
    const r: Node = { name: '', path: '', isDir: true, children: [], ca: 0, cd: 0, cf: 0 };
    for (const s of stats) {
      const parts = s.path.split('/').filter(Boolean);
      let cur = r, dir = '';
      for (let i = 0; i < parts.length; i++) {
        const last = i === parts.length - 1;
        dir = dir ? `${dir}/${parts[i]}` : parts[i];
        if (last) {
          let n = cur.children.find((c) => c.path === dir && !c.isDir);
          if (n) { n.stat = s; } else { cur.children.push({ name: parts[i], path: dir, isDir: false, children: [], stat: s, ca: 0, cd: 0, cf: 0 }); }
        } else {
          let n = cur.children.find((c) => c.path === dir && c.isDir);
          if (!n) { n = { name: parts[i], path: dir, isDir: true, children: [], ca: 0, cd: 0, cf: 0 }; cur.children.push(n); }
          cur = n;
        }
      }
    }
    function agg(n: Node): void {
      if (!n.isDir) return;
      for (const c of n.children) { if (c.isDir) agg(c); n.ca += c.ca + (c.stat?.additions || 0); n.cd += c.cd + (c.stat?.deletions || 0); n.cf += c.cf + (c.stat ? 1 : 0); }
    }
    agg(r);
    return r;
  });

  const allExpanded = $derived(stats.every((s) => expanded.has(s.path)));

  function depth(d: number): string {
    return `depth-${Math.min(d, 6)}`;
  }

  function toggle(p: string) {
    const next = new Set(expanded);
    next.has(p) ? next.delete(p) : next.add(p);
    expanded = next;
  }
</script>

<section class="card">
  <header class="hdr">
    <span class="title">{stats.length} file{stats.length === 1 ? '' : 's'}</span>
    <span class="cnt"><span class="a">+{adds}</span><span class="d">-{dels}</span></span>
    <button class="exp" onclick={() => expanded = allExpanded ? new Set() : new Set(stats.map((s) => s.path))}>
      {allExpanded ? 'Collapse' : 'Expand'}
    </button>
  </header>
  {#snippet tree(n: Node, d: number)}
    {#each n.children as c (c.path)}
      {#if c.isDir}
        <div class="nr">
          <button class="tr {depth(d)}" onclick={() => toggle(c.path)}>
            {#if expanded.has(c.path)}<ChevronDown class="ci" />{:else}<ChevronRight class="ci" />{/if}
            <Folder class="ci" /><span class="nm">{c.name}</span>
            {#if c.ca || c.cd}<span class="cnt"><span class="a">+{c.ca}</span><span class="d">-{c.cd}</span></span>{/if}
          </button>
          {#if expanded.has(c.path)}{@render tree(c, d + 1)}{/if}
        </div>
      {:else}
        <div class="nr">
          <button class="tr {depth(d)}" onclick={() => toggle(c.path)}>
            <FileCode2 class="ci" /><span class="nm">{c.name}</span>
            <span class="kind {c.stat?.kind}">{c.stat?.kind}</span>
            {#if c.stat}<span class="cnt"><span class="a">+{c.stat.additions}</span><span class="d">-{c.stat.deletions}</span></span>{/if}
          </button>
          {#if expanded.has(c.path) && c.stat}
            <pre class="diff">{c.stat.kind === 'deleted' ? (c.stat.before || '') : (c.stat.after || '')}</pre>
          {/if}
        </div>
      {/if}
    {/each}
  {/snippet}
  <div class="list">{@render tree(root, 0)}</div>
</section>

<style>
  .card { margin-top: 0.5rem; width: min(46rem, 100%); border: 1px solid var(--border); border-radius: 12px; background: color-mix(in srgb, var(--surface-hover) 30%, transparent); overflow: hidden; }
  .hdr { display: flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.6rem; font-size: 0.72rem; font-weight: 680; color: var(--text-muted); }
  .title { flex: 1; }
  .cnt { display: inline-flex; gap: 0.25rem; font-family: var(--font-mono); font-size: 0.68rem; font-weight: 720; }
  .a { color: #16a34a; }
  .d { color: #dc2626; }
  .exp { border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--text-secondary); padding: 0.2rem 0.45rem; font-size: 0.65rem; font-weight: 700; cursor: pointer; }
  .exp:hover { border-color: var(--border-hover); color: var(--text); }
  .list { max-height: 28rem; overflow-y: auto; }
  .nr { border-top: 1px solid color-mix(in srgb, var(--border) 30%, transparent); }
  .tr { display: flex; align-items: center; gap: 0.3rem; width: 100%; border: 0; background: transparent; color: var(--text-secondary); padding: 0.3rem 0.5rem; text-align: left; font-size: 0.74rem; cursor: pointer; }
  .tr:hover { background: var(--surface-hover); color: var(--text); }
  .ci { width: 0.85rem; height: 0.85rem; flex-shrink: 0; }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 0.74rem; flex: 1; }
  .kind { border-radius: 999px; background: var(--surface); padding: 0.1rem 0.3rem; font-size: 0.55rem; font-weight: 780; text-transform: uppercase; }
  .kind.created { color: #16a34a; }
  .kind.modified { color: var(--primary); }
  .kind.deleted { color: #dc2626; }
  .diff { margin: 0; max-height: 16rem; overflow: auto; border-top: 1px solid color-mix(in srgb, var(--border) 45%, transparent); background: color-mix(in srgb, var(--surface) 60%, transparent); color: var(--text-secondary); padding: 0.45rem 0.6rem; font-family: var(--font-mono); font-size: 0.68rem; line-height: 1.5; white-space: pre-wrap; }
  .depth-1 { padding-left: 1rem; }
  .depth-2 { padding-left: 1.6rem; }
  .depth-3 { padding-left: 2.2rem; }
  .depth-4 { padding-left: 2.8rem; }
  .depth-5 { padding-left: 3.4rem; }
  .depth-6 { padding-left: 4rem; }
</style>
