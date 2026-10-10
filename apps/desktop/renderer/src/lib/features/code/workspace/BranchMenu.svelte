<svelte:options runes={true} />

<!--
  The project's branch, and the way to leave it.

  A chip in the pane strip names the branch HEAD points at (the short commit
  when detached, a warning dot when the worktree has uncommitted changes). The
  menu lists the local branches with their upstream and ahead/behind counts,
  and offers to create one. Switching is an action on the checkout, so a
  failure (a dirty file git refuses to overwrite) is shown as git's own
  message rather than swallowed.
-->

<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { t } from 'svelte-i18n';
  import { Check, ChevronDown, GitBranch, Plus } from 'lucide-svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { codeWorkspace } from '../workspace.svelte';
  import BranchDialog from './BranchDialog.svelte';

  let { projectRoot }: { projectRoot: string } = $props();

  let open = $state(false);
  let createOpen = $state(false);
  /** Branch being switched to, so a second click cannot start a second switch. */
  let busy = $state<string | null>(null);

  const info = $derived(codeWorkspace.branchFor(projectRoot));
  const branches = $derived(info?.branches ?? []);
  const isRepo = $derived(info?.source === 'git');

  $effect(() => {
    const root = projectRoot;
    if (root) void codeWorkspace.loadBranches(root);
  });

  function toggle(next: boolean) {
    open = next;
    if (next) void codeWorkspace.loadBranches(projectRoot);
  }

  async function choose(name: string, create = false): Promise<void> {
    if (busy || !name.trim()) return;
    busy = name;
    try {
      const result = await codeWorkspace.switchBranch(projectRoot, name.trim(), create);
      if (result.ok) {
        open = false;
        createOpen = false;
        toastStore.success($t('codeWs.switched', { values: { name: result.branch ?? name } }));
      } else {
        toastStore.error(result.error || $t('codeWs.switchFailed'));
      }
    } finally {
      busy = null;
    }
  }

  /** `main · origin/main ↑2↓1`, the numbers git already knows. */
  function track(branch: { upstream?: string; ahead: number; behind: number }): string {
    const parts: string[] = [];
    if (branch.upstream) parts.push(branch.upstream);
    if (branch.ahead) parts.push(`↑${branch.ahead}`);
    if (branch.behind) parts.push(`↓${branch.behind}`);
    return parts.join(' ');
  }
</script>

{#if isRepo && info?.current}
  <Menu bind:open placement="bottom-start" minWidth="16rem" label={$t('codeWs.branch')} onclose={() => (open = false)}>
    {#snippet trigger(props)}
      <Tooltip label={$t('codeWs.branchHint')} position="bottom">
        <UiButton variant="plain"
          type="button"
          class={uiClass("branch-chip titlebar-no-drag", "ui-local-4a309ef6", {"is-dirty": info.dirty})}

          aria-label={$t('codeWs.branch')}
          {...props}
        >
          <GitBranch class="size-3.5 shrink-0" aria-hidden="true" />
          <span class="branch-name">{info.current}</span>
          {#if info.dirty}<span class="branch-dot" aria-hidden="true"></span>{/if}
          <ChevronDown class="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </UiButton>
      </Tooltip>
    {/snippet}

    <div class="branch-menu max-h-72 overflow-y-auto">
      {#each branches as branch (branch.name)}
        <MenuItem onselect={() => void choose(branch.name)}>
          <span class="branch-row">
            <Check class="size-3.5 shrink-0 {branch.current ? '' : 'invisible'}" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate" class:font-medium={branch.current} class:text-foreground={branch.current}>{branch.name}</span>
            <span class="branch-track">{track(branch)}</span>
          </span>
        </MenuItem>
      {:else}
        <p class="branch-empty">{$t('codeWs.noBranches')}</p>
      {/each}
    </div>

    <div class="branch-divider" role="separator"></div>
    <MenuItem onselect={() => (createOpen = true)}>
      <span class="branch-row"><Plus class="size-3.5 shrink-0" aria-hidden="true" /><span class="min-w-0 flex-1 truncate">{$t('codeWs.newBranch')}</span></span>
    </MenuItem>
  </Menu>

  {#if createOpen}
    <BranchDialog
      {projectRoot}
      busy={busy !== null}
      oncreate={(name) => void choose(name, true)}
      onclose={() => (createOpen = false)}
    />
  {/if}
{/if}

<style>
  :global(.branch-chip.ui-local-4a309ef6) {
    display: inline-flex;
    max-width: 14rem;
    align-items: center;
    gap: 0.3rem;
    height: 1.5rem;
    padding-inline: 0.5rem;
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    color: var(--muted-foreground);
    transition: background-color var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease);
  }
  :global(.branch-chip:hover.ui-local-4a309ef6), :global(.branch-chip[aria-expanded='true'].ui-local-4a309ef6) { background: var(--surface-hover); color: var(--foreground); }
  .branch-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .branch-dot { width: 5px; height: 5px; flex-shrink: 0; border-radius: 999px; background: var(--warning); }
  .branch-menu { min-width: 0; }
  .branch-row { display: flex; min-width: 0; align-items: center; gap: 0.4rem; }
  .branch-track { flex-shrink: 0; font-size: var(--text-xs); font-variant-numeric: tabular-nums; color: var(--muted-foreground); }
  .branch-empty { padding: 0.5rem 0.625rem; font-size: var(--text-xs); color: var(--muted-foreground); }
  .branch-divider { height: 1px; margin: 0.25rem 0; background: var(--border-subtle); }

  @media (prefers-reduced-motion: reduce) {
    :global(.branch-chip.ui-local-4a309ef6) { transition: none; }
  }
</style>
