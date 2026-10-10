<svelte:options runes={true} />

<script lang="ts">
  import { cn as uiClass } from '$lib/utils/cn';

  import { ChevronDown, ChevronRight, FileCode2, Folder } from 'lucide-svelte';
  import type { CodeAgentDiffStat } from '$lib/types/chat';
  import Button from '$lib/components/ui/Button.svelte';
  import { say } from '$lib/copy';

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
    <span class="title">{say.files(stats.length)}</span>
    <span class="cnt"><span class="a">+{adds}</span><span class="d">-{dels}</span></span>
    <Button
      variant="ghost"
      size="xs"
      onclick={() => (expanded = allExpanded ? new Set() : new Set(stats.map((s) => s.path)))}
    >
      {allExpanded ? 'Collapse' : 'Expand'}
    </Button>
  </header>
  {#snippet tree(n: Node, d: number)}
    {#each n.children as c (c.path)}
      {#if c.isDir}
        <div class="nr">
          <Button variant="plain" class={uiClass(`tr ${depth(d)}`, "ui-local-9cb339f3")} onclick={() => toggle(c.path)}>
            {#if expanded.has(c.path)}<ChevronDown class="ci" />{:else}<ChevronRight class="ci" />{/if}
            <Folder class="ci" /><span class="nm">{c.name}</span>
            {#if c.ca || c.cd}<span class="cnt"><span class="a">+{c.ca}</span><span class="d">-{c.cd}</span></span>{/if}
          </Button>
          {#if expanded.has(c.path)}{@render tree(c, d + 1)}{/if}
        </div>
      {:else}
        <div class="nr">
          <Button variant="plain" class={uiClass(`tr ${depth(d)}`, "ui-local-9cb339f3")} onclick={() => toggle(c.path)}>
            <FileCode2 class="ci" /><span class="nm">{c.name}</span>
            <span class="kind {c.stat?.kind}">{c.stat?.kind}</span>
            {#if c.stat}<span class="cnt"><span class="a">+{c.stat.additions}</span><span class="d">-{c.stat.deletions}</span></span>{/if}
          </Button>
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
  /*
   * Same token vocabulary as AgentBlock and ToolCallRow. This card used to run
   * on the legacy text/surface names with hardcoded #16a34a and #dc2626 — which
   * are the light values of --success and --error, so on the dark default the
   * diff counts were rendering dark-on-dark.
   */
  .card { margin-top: 0.5rem; width: var(--inline-block-width); max-width: 100%; border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: color-mix(in srgb, var(--muted) 45%, transparent); overflow: hidden; }
  .hdr { display: flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0.6rem; font-size: 0.72rem; font-weight: 680; color: var(--muted-foreground); }
  .title { flex: 1; }
  .cnt { display: inline-flex; gap: 0.25rem; font-variant-numeric: tabular-nums; font-size: var(--text-xs); font-weight: 700; }
  .a { color: var(--success); }
  :is(.d, :global(.d.ui-local-9cb339f3)) { color: var(--error); }
  .list { max-height: 28rem; overflow-y: auto; }
  .nr { border-top: 1px solid var(--border-subtle); }
  /* Not pilled: these are full-bleed rows separated by rules, so a pill would
     float free of the separators. */
  :is(.tr, :global(.tr.ui-local-9cb339f3)) { display: flex; align-items: center; gap: 0.3rem; width: 100%; border: 0; background: transparent; color: var(--muted-foreground); padding: 0.3rem 0.5rem; text-align: left; font-size: 0.74rem; cursor: pointer; transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease); }
  :is(.tr:hover, :global(.tr:hover.ui-local-9cb339f3)) { background: var(--surface-hover); color: var(--foreground); }
  .ci { width: 0.85rem; height: 0.85rem; flex-shrink: 0; }
  .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; flex: 1; }
  .kind { border-radius: var(--radius-full); background: var(--muted); padding: 0.1rem 0.35rem; font-size: var(--text-xs); font-weight: 650; letter-spacing: 0.01em; }
  .kind.created { color: var(--success); }
  .kind.modified { color: var(--primary); }
  .kind.deleted { color: var(--error); }
  /* Matches .ui-tool-fallback-args-value so agent code blocks read the same
     inline as they do in the activity drawer. */
  .diff { margin: 0; max-height: 16rem; overflow: auto; border-top: 1px solid var(--border-subtle); background: color-mix(in srgb, var(--muted) 50%, transparent); color: color-mix(in srgb, var(--foreground) 90%, transparent); border-radius: 0; padding: 0.45rem 0.6rem; font-family: var(--font-mono); font-size: var(--text-xs); line-height: 1.5; white-space: pre-wrap; }
  .depth-1 { padding-left: 1rem; }
  .depth-2 { padding-left: 1.6rem; }
  .depth-3 { padding-left: 2.2rem; }
  .depth-4 { padding-left: 2.8rem; }
  .depth-5 { padding-left: 3.4rem; }
  .depth-6 { padding-left: 4rem; }
</style>
