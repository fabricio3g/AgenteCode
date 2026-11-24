<svelte:options runes={true} />

<!--
  What a swarm's members told each other, oldest first: the route (`c1 → c2`,
  or the lead) hard left in a column so the eye runs down who spoke, the
  finding beside it in reading ink. Shared by the transcript's swarm block and
  the Board pane, so both say it the same way.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import type { SwarmFinding } from '$shared/agente-protocol';
  import { findingRoute } from './swarm-lanes';

  let { findings }: { findings: readonly SwarmFinding[] } = $props();

  function route(finding: SwarmFinding): string {
    if (finding.from !== 'lead') return findingRoute(finding);
    const to = finding.to?.length ? ` → ${finding.to.join(', ')}` : '';
    return `${$t('code.swarm.lane.lead')}${to}`;
  }
</script>

<ol class="findings">
  {#each findings as finding (finding.id)}
    <li class:lead={finding.from === 'lead'}>
      <span class="route">{route(finding)}</span>
      <span class="text">{finding.text}</span>
    </li>
  {/each}
</ol>

<style>
  .findings { display: grid; gap: 0.25rem; font-size: var(--text-xs); color: var(--muted-foreground); }
  li { display: grid; grid-template-columns: minmax(4.5rem, max-content) minmax(0, 1fr); column-gap: 0.75rem; align-items: baseline; }
  .route { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .text { color: var(--prose-ink, var(--foreground)); line-height: 1.5; overflow-wrap: anywhere; }
  li.lead .route { color: var(--foreground); }
</style>
