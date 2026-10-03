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
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';
  import SessionRow from '$lib/features/shared/SessionRow.svelte';
  import { codeStore } from './code.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { copy, say } from '$lib/copy';
  import type { ChatSession, CodeProject } from '$lib/types/chat';

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

  /**
   * The whole tree in one pass.
   *
   * `sessionsFor()` filtered and sorted every code conversation once per
   * project, and `projectRunning()` did the same work again — so a rail with P
   * projects re-scanned the space 2P times on every chat mutation, and
   * `touchChats()` fires those from anywhere in the app. One pass now builds
   * the buckets, each conversation's live status, and the folders that carry
   * one.
   */
  const tree = $derived.by(() => {
    const byProject = new Map<string, ChatSession[]>();
    const status = new Map<string, 'running' | 'approval'>();
    const busyProjects = new Set<string>();

    for (const chat of appStore.visibleCodeChats) {
      if (chat.projectId) {
        const bucket = byProject.get(chat.projectId);
        if (bucket) bucket.push(chat);
        else byProject.set(chat.projectId, [chat]);
      }
      // A waiting approval outranks a running turn: it is the one that needs you.
      const state: 'running' | 'approval' | null = approvalsStore.forChat(chat.id).length
        ? 'approval'
        : codeStore.runFor(chat.id)?.running
          ? 'running'
          : null;
      if (state) {
        status.set(chat.id, state);
        if (chat.projectId) busyProjects.add(chat.projectId);
      }
    }

    for (const bucket of byProject.values()) {
      bucket.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    }
    return { byProject, status, busyProjects };
  });

  /** One read of the unlinked list instead of one per reference in the markup. */
  const unlinked = $derived(codeStore.unlinkedConversations);

  const sessionsFor = (projectId: string) => tree.byProject.get(projectId) ?? [];
  const statusFor = (chatId: string) => tree.status.get(chatId) ?? null;
  const projectRunning = (projectId: string) => tree.busyProjects.has(projectId);

  let menuFor = $state<string | null>(null);
  let menuPoint = $state<{ x: number; y: number } | null>(null);
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');
  let renameInput = $state<HTMLInputElement | undefined>(undefined);
  let unlinkedOpen = $state(true);

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
    const count = sessionsFor(project.id).length;
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
    const chats = unlinked;
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

  function toggleProjectMenu(projectId: string) {
    menuPoint = null;
    menuFor = menuFor === projectId ? null : projectId;
  }
</script>

<div class="flex flex-col gap-0.5 pb-2">
  <span class="sidebar-section">{$t('code.projects')}</span>

  {#if !codeStore.loading && !codeStore.projects.length}
    <p class="px-2.5 py-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
      {$t('code.noProjects')}
    </p>
    <button
      type="button"
      class="sidebar-row is-emphasis"
      onclick={() => void codeStore.addProject()}
    >
      <Plus class="size-3.5 shrink-0" />
      <span class="sidebar-row-label">{$t('code.addProject')}</span>
    </button>
  {:else}
    {#each codeStore.projects as project (project.id)}
      {@const expanded = !!codeStore.expandedProjects[project.id]}
      {@const sessions = sessionsFor(project.id)}
      {@const missing = !!codeStore.missingProjects[project.id]}
      <div class="project">
        <div
          class="sidebar-row is-strong group relative"
          class:is-ancestor={codeStore.activeProjectId === project.id}
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
            <TriangleAlert class="size-3.5 shrink-0 text-[var(--warning)]" />
          {:else if expanded}
            <FolderOpen class="size-3.5 shrink-0" />
          {:else}
            <Folder class="size-3.5 shrink-0" />
          {/if}

          {#if renamingId === project.id}
            <input
              bind:this={renameInput}
              class="chat-rename-input sidebar-row-label"
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
            <span class="sidebar-row-label" class:line-through={missing}>{project.rootName}</span>
            {#if projectRunning(project.id) && !expanded}
              <StatusDot tone="running" />
            {/if}
            <IconButton
              class="sidebar-row-action"
              label={$t('code.newConversation')}
              disabled={missing}
              onclick={() => codeStore.newConversation(project)}
            >
              <Plus />
            </IconButton>
            <!-- `open` is driven by `menuFor`, so the trigger flips it here
                 instead of using the snippet's own toggle handler. -->
            <Menu
              open={menuFor === project.id}
              bind:anchorPoint={menuPoint}
              placement="bottom-end"
              label={$t('code.projectOptions')}
              onclose={() => (menuFor = null)}
            >
              {#snippet trigger(props)}
                <IconButton
                  class="sidebar-row-action{menuFor === project.id ? ' is-open' : ''}"
                  label={$t('code.projectOptions')}
                  aria-expanded={props['aria-expanded']}
                  aria-haspopup={props['aria-haspopup']}
                  aria-controls={props['aria-controls']}
                  onclick={(event) => {
                    event.stopPropagation();
                    toggleProjectMenu(project.id);
                  }}
                >
                  <MoreHorizontal />
                </IconButton>
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
                class="sidebar-row is-warning"
                onclick={() => void codeStore.locateProject(project.id)}
              >
                <FolderSearch class="size-3.5 shrink-0" />
                <span class="sidebar-row-label">{$t('code.locateFolder')}</span>
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
                class="sidebar-row is-muted"
                onclick={() => codeStore.newConversation(project)}
              >
                <Plus class="size-3 shrink-0" />
                <span class="sidebar-row-label">{$t('code.newConversation')}</span>
              </button>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  {/if}

  {#if unlinked.length}
    <div class="mt-3">
      <div class="flex items-center gap-1">
        <button
          type="button"
          class="sidebar-section min-w-0 flex-1"
          aria-expanded={unlinkedOpen}
          title={$t('code.unlinkedHint')}
          onclick={() => (unlinkedOpen = !unlinkedOpen)}
        >
          <ChevronRight class={`size-3 shrink-0 transition-transform duration-150${unlinkedOpen ? ' rotate-90' : ''}`} />
          <span class="truncate">{$t('code.unlinked')} · {unlinked.length}</span>
        </button>
        <IconButton
          class="sidebar-row-action"
          label={$t('code.deleteAll')}
          size="xs"
          onclick={confirmDeleteUnlinked}
        >
          <Trash2 />
        </IconButton>
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
  /*
   * Conversations hang from a hairline under the folder icon: the indent puts
   * the rule at the icon's centre, which is also where the row's padding and
   * gap put the icon itself.
   */
  .tree-children {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 1px 0 0.375rem 1.0625rem;
    padding-left: 0.25rem;
    border-left: 1px solid color-mix(in srgb, var(--sidebar-border) 70%, transparent);
  }
</style>
