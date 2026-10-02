<svelte:options runes={true} />
<script lang="ts">
  import { Globe, SquareTerminal, GitBranch } from 'lucide-svelte';
  import WorkspaceHost from '../WorkspaceHost.svelte';
  import TerminalView from '$lib/features/code/workspace/TerminalView.svelte';
  import { workspaceLayout } from '$lib/stores/workspace-layout.svelte';
  import type { PanelRenderState, WorkspacePanel } from '../workspace-panel';
  const panels = $derived<WorkspacePanel[]>([
    { id: 'browser', title: 'Browser', icon: Globe, content, region: 'right', available: true, open: workspaceLayout.isOpen('browser'), onhide: () => workspaceLayout.hide('browser') },
    { id: 'changes', title: 'Changes', icon: GitBranch, content, region: 'right', available: true, open: workspaceLayout.isOpen('changes'), onhide: () => workspaceLayout.hide('changes') },
    { id: 'terminal:test', title: 'Terminal', icon: SquareTerminal, content, region: 'bottom', available: true, open: workspaceLayout.isOpen('terminal:test'), onhide: () => workspaceLayout.hide('terminal:test') }
  ]);
</script>
{#snippet content(state: PanelRenderState)}
  {#if state.id === 'terminal:test'}<TerminalView id="test" active={state.exposed} focused={state.focused} />{:else}<div>Browser content</div>{/if}
{/snippet}
<WorkspaceHost {panels}><input aria-label="Chat" /></WorkspaceHost>
