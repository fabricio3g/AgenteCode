<svelte:options runes={true} />

<!--
  Code sidebar: a tree of project folders, each holding its conversations.

  Every project row has a hover "+" (new conversation) and a "…" menu that a
  right-click also opens: New conversation, Rename, Show in folder, Copy path,
  Locate folder (when it went missing) and Delete project. Deleting a project
  removes it and its conversations from Agente; the folder on disk is never
  touched. Conversation rows are the shared SessionRow (rename, export,
  delete, live status).
-->

<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { slide } from 'svelte/transition';
  import {
    ChevronRight,
    Copy as CopyIcon,
    Folder,
    FolderOpen,
    FolderSearch,
    MoreHorizontal,
    Pencil,
    Plus,
    Trash2,
    TriangleAlert
  } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import SessionRow from '$lib/features/shared/SessionRow.svelte';
  import { codeStore } from './code.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { copy, say } from '$lib/copy';
  import type { CodeProject } from '$lib/types/chat';

  onMount(() => {
    void codeStore.load();
  });

  // A restored conversation (restart, space switch) should find its folder
  // open and highlighted — not require the user to re-navigate the tree.
  $effect(() => {
    const projectId = appStore.currentChat?.projectId;
    if (projectId && codeStore.projects.some((p) => p.id === projectId)) {
      if (!codeStore.expandedProjects[projectId]) codeStore.expandedProjects[projectId] = true;
      if (codeStore.activeProjectId !== projectId) codeStore.activeProjectId = projectId;
    }
  });

  let menuFor = $state<string | null>(null);
  let menuPoint = $state<{ x: number; y: number } | null>(null);
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');
  let renameInput = $state<HTMLInputElement | undefined>(undefined);
  let unlinkedOpen = $state(true);

  function statusFor(chatId: string): 'running' | 'approval' | null {
    if (approvalsStore.forChat(chatId).length) return 'approval';
    return codeStore.runFor(chatId)?.running ? 'running' : null;
  }

  function projectRunning(projectId: string): boolean {
    return codeStore.sessionsFor(projectId).some((chat) => statusFor(chat.id) !== null);
  }

  function toggle(project: CodeProject) {
    codeStore.toggleExpanded(project.id);
    codeStore.activeProjectId = project.id;
  }

  async function startRename(project: CodeProject) {
    renamingId = project.id;
    renameValue = project.rootName;
    await tick();
    renameInput?.focus();
    renameInput?.select();
  }

  function commitRename() {
    if (renamingId) void codeStore.renameProject(renamingId, renameValue);
    renamingId = null;
  }

  async function copyPath(project: CodeProject) {
    if (await writeToClipboard(project.rootPath)) toastStore.success($t('code.pathCopied'), 2000);
  }

  function confirmDeleteProject(project: CodeProject) {
    const count = codeStore.sessionsFor(project.id).length;
    confirmStore.show({
      title: $t('code.deleteProjectTitle', { values: { name: project.rootName } }),
      message: $t('code.deleteProjectMessage', { values: { conversations: say.conversations(count) } }),
      details: [project.rootPath],
      confirmLabel: $t('code.deleteProject'),
      danger: true,
      onConfirm: () => void codeStore.deleteProject(project.id)
    });
  }

  function confirmDeleteUnlinked() {
    const chats = codeStore.unlinkedConversations;
    confirmStore.show({
      title: $t('code.deleteUnlinkedTitle', { values: { conversations: say.conversations(chats.length) } }),
      message: copy.confirm.deleteChat.message,
      confirmLabel: $t('code.deleteAll'),
      danger: true,
      onConfirm: () => {
        for (const chat of chats) appStore.deleteChat(chat.id, { silent: true });
      }
    });
  }

  function openProjectMenu(event: MouseEvent, projectId: string) {
    event.preventDefault();
    menuPoint = { x: event.clientX, y: event.clientY };
    menuFor = projectId;
  }
</script>

<div class="flex flex-col gap-0.5 pb-2 pt-3">
  <span class="px-2 pb-1 text-[11px] font-semibold text-[var(--text-muted)]">
    {$t('code.projects')}
  </span>

  {#if !codeStore.loading && !codeStore.projects.length}
    <p class="px-2.5 py-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
      {$t('code.noProjects')}
    </p>
    <button
      type="button"
      class="tree-row flex h-7 w-full items-center gap-2 px-2.5 text-left text-[13px]"
      onclick={() => void codeStore.addProject()}
    >
      <Plus class="size-3.5 shrink-0" />
      <span class="truncate">{$t('code.addProject')}</span>
    </button>
  {:else}
    {#each codeStore.projects as project (project.id)}
      {@const expanded = !!codeStore.expandedProjects[project.id]}
      {@const sessions = codeStore.sessionsFor(project.id)}
      {@const missing = !!codeStore.missingProjects[project.id]}
      <div class="project">
        <div
          class="tree-row project-row group relative flex h-7 w-full cursor-pointer items-center gap-2 px-2.5 text-left"
          class:is-active={codeStore.activeProjectId === project.id}
          role="button"
          tabindex="0"
          aria-expanded={expanded}
          title={missing ? `${$t('code.folderMissing')} — ${project.rootPath}` : undefined}
          onclick={() => renamingId !== project.id && toggle(project)}
          ondblclick={() => void startRename(project)}
          oncontextmenu={(event) => openProjectMenu(event, project.id)}
          onkeydown={(event) => {
            if (renamingId === project.id) return;
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              toggle(project);
            } else if (event.key === 'F2') {
              event.preventDefault();
              void startRename(project);
            }
          }}
        >
          {#if missing}
            <TriangleAlert class="size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
          {:else if expanded}
            <FolderOpen class="size-3.5 shrink-0" />
          {:else}
            <Folder class="size-3.5 shrink-0" />
          {/if}

          {#if renamingId === project.id}
            <input
              bind:this={renameInput}
              class="rename-input min-w-0 flex-1"
              bind:value={renameValue}
              maxlength="80"
              aria-label={copy.actions.rename}
              onclick={(event) => event.stopPropagation()}
              onkeydown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitRename();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  renamingId = null;
                }
              }}
              onblur={commitRename}
            />
          {:else}
            <span class="min-w-0 flex-1 truncate text-[13px] text-foreground" class:line-through={missing}>{project.rootName}</span>
            {#if projectRunning(project.id) && !expanded}
              <span class="running-dot shrink-0" aria-hidden="true"></span>
            {/if}
            <button
              type="button"
              class="row-action rounded-full p-1"
              aria-label={$t('code.newConversation')}
              title={$t('code.newConversation')}
              disabled={missing}
              onclick={(event) => {
                event.stopPropagation();
                codeStore.newConversation(project);
              }}
            >
              <Plus class="size-3.5" />
            </button>
            <Menu
              open={menuFor === project.id}
              bind:anchorPoint={menuPoint}
              placement="bottom-end"
              label={$t('code.projectOptions')}
              onclose={() => (menuFor = null)}
            >
              {#snippet trigger(props)}
                <button
                  type="button"
                  class="row-action rounded-full p-1"
                  class:is-open={menuFor === project.id}
                  aria-label={$t('code.projectOptions')}
                  aria-expanded={props['aria-expanded']}
                  aria-haspopup={props['aria-haspopup']}
                  aria-controls={props['aria-controls']}
                  onclick={(event) => {
                    event.stopPropagation();
                    menuPoint = null;
                    menuFor = menuFor === project.id ? null : project.id;
                  }}
                >
                  <MoreHorizontal class="size-3.5" />
                </button>
              {/snippet}
              {#if missing}
                <MenuItem icon={FolderSearch} label={$t('code.locateFolder')} onselect={() => void codeStore.locateProject(project.id)} />
              {:else}
                <MenuItem icon={Plus} label={$t('code.newConversation')} onselect={() => codeStore.newConversation(project)} />
              {/if}
              <MenuItem icon={Pencil} label={copy.actions.rename} onselect={() => void startRename(project)} />
              <MenuItem icon={FolderOpen} label={copy.actions.reveal} disabled={missing} onselect={() => void codeStore.revealProject(project.id)} />
              <MenuItem icon={CopyIcon} label={copy.actions.copyPath} onselect={() => void copyPath(project)} />
              <MenuItem icon={Trash2} label={$t('code.deleteProject')} danger onselect={() => confirmDeleteProject(project)} />
            </Menu>
          {/if}
        </div>

        {#if expanded}
          <!-- Conversations hang from a hairline under the folder icon. -->
          <div class="tree-children" transition:slide={{ duration: 140 }}>
            {#if missing}
              <button
                type="button"
                class="tree-row flex h-7 w-full items-center gap-2 px-2.5 text-left text-[12.5px] text-[var(--warning,#d97706)]"
                onclick={() => void codeStore.locateProject(project.id)}
              >
                <FolderSearch class="size-3.5 shrink-0" />
                <span class="truncate">{$t('code.locateFolder')}</span>
              </button>
            {/if}
            {#each sessions as session (session.id)}
              {@const status = statusFor(session.id)}
              <SessionRow
                chat={session}
                active={appStore.currentChatId === session.id}
                onselect={() => codeStore.openConversation(session.id)}
                {status}
                statusLabel={status === 'approval' ? $t('code.awaitingApproval') : $t('code.running')}
                menuLabel={$t('code.conversationOptions')}
              />
            {/each}
            {#if !missing}
              <button
                type="button"
                class="tree-row new-row flex h-7 w-full items-center gap-2 px-2.5 text-left text-[12.5px]"
                onclick={() => codeStore.newConversation(project)}
              >
                <Plus class="size-3 shrink-0" />
                <span class="truncate">{$t('code.newConversation')}</span>
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  {/if}

  {#if codeStore.unlinkedConversations.length}
    {@const unlinked = codeStore.unlinkedConversations}
    <div class="mt-3">
      <div class="flex items-center gap-1 px-2 pb-1">
        <button
          type="button"
          class="group-toggle flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-semibold text-[var(--text-muted)]"
          aria-expanded={unlinkedOpen}
          title={$t('code.unlinkedHint')}
          onclick={() => (unlinkedOpen = !unlinkedOpen)}
        >
          <ChevronRight class={`size-3 shrink-0 transition-transform duration-150${unlinkedOpen ? ' rotate-90' : ''}`} />
          <span class="truncate">{$t('code.unlinked')} · {unlinked.length}</span>
        </button>
        <button
          type="button"
          class="unlinked-clear rounded-[var(--radius-sm)] p-1"
          aria-label={$t('code.deleteAll')}
          title={$t('code.deleteAll')}
          onclick={confirmDeleteUnlinked}
        >
          <Trash2 class="size-3.5" />
        </button>
      </div>
      {#if unlinkedOpen}
        <div class="space-y-0.5" transition:slide={{ duration: 140 }}>
          {#each unlinked as chat (chat.id)}
            <SessionRow
              {chat}
              active={appStore.currentChatId === chat.id}
              onselect={() => appStore.selectChat(chat.id)}
              menuLabel={$t('code.conversationOptions')}
            />
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .tree-row {
    color: var(--text-secondary);
    background: transparent;
    border: none;
    border-radius: var(--radius-full);
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  .tree-row:hover {
    background: var(--sidebar-accent);
    color: var(--sidebar-accent-foreground);
  }

  .tree-row.is-active {
    background: var(--sidebar-accent);
    color: var(--foreground);
  }

  /* One highlight at a time: the conversation carries the fill; its project
     only reads as current (stronger text), so the two never stack. */
  .project-row.is-active:not(:hover) {
    background: transparent;
    font-weight: 500;
  }

  .tree-children {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 1px 0 0.375rem 1.0625rem;
    padding-left: 0.25rem;
    border-left: 1px solid color-mix(in srgb, var(--sidebar-border) 70%, transparent);
  }

  .new-row {
    color: var(--text-muted);
  }

  .tree-row:focus-visible {
    outline: 2px solid var(--sidebar-ring);
    outline-offset: -2px;
  }

  /* Hover actions stay reachable by keyboard: focus reveals them too. */
  .row-action {
    color: var(--muted-foreground);
    background: transparent;
    border: none;
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--motion-fast) var(--motion-ease);
  }

  .project-row:hover .row-action,
  .project-row:focus-within .row-action,
  .row-action.is-open,
  .row-action:focus-visible {
    opacity: 1;
  }

  .row-action:hover {
    color: var(--sidebar-foreground);
    background: color-mix(in srgb, var(--sidebar-foreground) 10%, transparent);
  }

  .row-action:disabled {
    cursor: default;
    visibility: hidden;
  }

  .rename-input {
    background: var(--background);
    border: 1px solid var(--sidebar-ring);
    border-radius: var(--radius-sm);
    color: var(--foreground);
    font-size: 14px;
    padding: 0 0.35rem;
    outline: none;
  }

  .running-dot {
    width: 0.4rem;
    height: 0.4rem;
    border-radius: 9999px;
    background: var(--muted-foreground);
    animation: tree-pulse 1.2s ease-in-out infinite;
  }

  .group-toggle,
  .unlinked-clear {
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .group-toggle:hover {
    color: var(--sidebar-foreground);
  }

  .unlinked-clear {
    color: var(--error);
    opacity: 0.8;
  }

  .unlinked-clear:hover {
    opacity: 1;
  }

  @keyframes tree-pulse {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .running-dot { animation: none; }
  }
</style>
