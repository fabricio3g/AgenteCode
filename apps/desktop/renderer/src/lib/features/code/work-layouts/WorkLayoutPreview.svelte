<svelte:options runes={true} />

<!--
  A layout's own miniature for Settings → Appearance: the real `CodeWorkBlock`
  drawing one small sample run in the given layout, opened and shrunk to fit
  the tile. What the tile shows is what the transcript will show — no drawing
  of its own to drift from the component. It is `inert`: the tile is the button.
-->

<script lang="ts">
  import type { AgentStyleId } from '$shared/appearance';
  import type { AgentStep } from '$lib/types/chat';
  import CodeWorkBlock from '../CodeWorkBlock.svelte';
  import type { WorkItem } from '../work-blocks';

  let { layout }: { layout: AgentStyleId } = $props();

  /** One short, believable run: look around, check the web, edit, test. */
  const base = Date.now() - 60_000;
  const steps: AgentStep[] = [
    { id: 'pv-1', type: 'searching', label: 'Search', toolName: 'grep', status: 'done', detail: 'sessionTtl', output: 'src/auth/session.ts:14', startedAt: base, durationMs: 120 },
    { id: 'pv-2', type: 'reading', label: 'Read', toolName: 'read', status: 'done', detail: 'src/auth/session.ts', startedAt: base + 200, durationMs: 30 },
    { id: 'pv-3', type: 'searching', label: 'Search the web', toolName: 'web_search', status: 'done', detail: 'session timeout guidance', output: 'Session Management https://cheatsheetseries.owasp.org/\nSet-Cookie https://developer.mozilla.org/\nDigital identity https://pages.nist.gov/', startedAt: base + 300, durationMs: 1_400 },
    { id: 'pv-4', type: 'coding', label: 'Edit', toolName: 'edit_file', status: 'done', detail: 'src/auth/session.ts', diffStats: [{ path: 'src/auth/session.ts', kind: 'modified', additions: 6, deletions: 2, patch: '--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -12,2 +12,3 @@\n-export const TTL = 30 * 60_000;\n+import { config } from "../config";\n+export const TTL = config.auth.ttl;\n' }], startedAt: base + 1_800, durationMs: 60 },
    { id: 'pv-5', type: 'coding', label: 'Edit', toolName: 'edit_file', status: 'done', detail: 'tests/session.test.ts', diffStats: [{ path: 'tests/session.test.ts', kind: 'modified', additions: 3, deletions: 1 }], startedAt: base + 1_900, durationMs: 40 },
    { id: 'pv-6', type: 'executing', label: 'Run', toolName: 'bash', status: 'done', detail: 'npm test', output: '12 passing', startedAt: base + 2_000, durationMs: 3_800 }
  ];
  const items: WorkItem[] = steps.map((step) => ({ key: step.id, step }));
</script>

<span class="work-preview" inert aria-hidden="true">
  <span class="work-preview-page">
    <CodeWorkBlock {items} {layout} openByDefault chatId={`appearance-preview-${layout}`} messageId="sample" codeActions={false} />
  </span>
</span>

<style>
  /* The tile's window onto the run: a fixed height, the bottom fading out so a
     longer layout reads as "continues", never as clipped. */
  .work-preview {
    position: relative;
    display: block;
    width: 100%;
    height: 8rem;
    overflow: hidden;
    padding: 0.625rem 0.75rem 0;
    background: var(--chat-bg, var(--background));
    pointer-events: none;
    user-select: none;
    mask-image: linear-gradient(to bottom, #000 72%, transparent);
  }
  /* Laid out at a real conversation width, then shrunk: `zoom` keeps layout
     honest (text wraps where it would in the transcript), unlike a transform. */
  .work-preview-page {
    display: block;
    width: calc(100% / 0.6);
    zoom: 0.6;
  }
</style>
