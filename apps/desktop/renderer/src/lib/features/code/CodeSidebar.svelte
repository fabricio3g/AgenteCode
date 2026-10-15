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
  import UiListRow from '$lib/components/ui/ListRow.svelte';

  import UiButton from '$lib/components/ui/Button.svelte';
  import UiInput from '$lib/components/ui/Input.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { onMount, tick } from 'svelte';
  import { slide } from 'svelte/transition';
  import {
    ArrowUp,
    ArrowDown,
    FolderPlus,
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
  import ProjectConversations from './ProjectConversations.svelte';
  import { sidebarOrganization as organization } from './sidebar-organization.svelte';
  import SessionRow from '$lib/features/shared/SessionRow.svelte';
  import { codeStore } from './code.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { workspaceLayout } from '$lib/stores/workspace-layout.svelte';
  import { approvalsStore } from '$lib/stores/approvals.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import { copy, say } from '$lib/copy';
  import type { ChatSession, CodeProject } from '$lib/types/chat';

  onMount(() => {
    void codeStore.load();
  });

  /**
   * The project whose folder this sidebar opened by itself, once.
   *
   * The reveal must not run on every write to `expandedProjects`: an effect
   * that re-opens the current conversation's folder whenever that record
   * changes makes the one folder the user is most likely to close the one
   * folder that never closes. It runs when the current conversation's
   * project changes instead, so a restored or switched conversation still
   * finds its folder open — and a folder the user collapsed stays closed.
   */
  let revealed = $state<string | null>(null);

  $effect(() => {
    const projectId = appStore.currentChat?.projectId;
    if (!projectId || revealed === projectId) return;
    // Projects load asynchronously: wait for the folder to exist before
    // marking it revealed, or a conversation restored before the list lands
    // would never open its folder.
    if (!codeStore.projects.some((p) => p.id === projectId)) return;
    revealed = projectId;
    if (!codeStore.expandedProjects[projectId]) codeStore.expandedProjects[projectId] = true;
    if (codeStore.activeProjectId !== projectId) codeStore.activeProjectId = projectId;
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
  /**
   * Open a conversation beside the one being read. The centre measures itself, so
   * the refusal is honest: two columns that cannot hold a sentence are worse than
   * no split, and the reader gets told why instead of watching it squeeze.
   */
  function splitWith(chatId: string, edge: 'right' | 'bottom') {
    const { width, height } = workspaceLayout.centreSize;
    if (!workspaceLayout.splitWith(chatId, edge, { x: 0, y: 0, width, height })) {
      toastStore.error($t('code.pane.tooNarrow'));
      return;
    }
    // The new pane is already focused; say so to everything that reads "current".
    codeStore.openConversation(chatId);
  }
</script>

<div class="flex flex-col gap-0.5 pb-2">
  <span class="sidebar-section">{$t('code.projects')}</span>

  {#if !codeStore.loading && !codeStore.projects.length}
    <p class="px-2.5 py-2 text-[length:var(--text-sm)] leading-relaxed text-[var(--text-muted)]">
      {$t('code.noProjects')}
    </p>
    <UiListRow
      type="button"
      class={uiClass("sidebar-row is-emphasis")}
      onclick={() => void codeStore.addProject()}
    >
      <Plus class="sidebar-row-icon" />
      <span class="sidebar-row-label">{$t('code.addProject')}</span>
    </UiListRow>
  {:else}
    {#each organization.list('projects',codeStore.projects) as project (project.id)}
      {@const expanded = !!codeStore.expandedProjects[project.id]}
      {@const sessions = sessionsFor(project.id)}
      {@const missing = !!codeStore.missingProjects[project.id]}
      <div class="project" data-sidebar-project={project.id}>
        <div
          class="sidebar-row is-strong group relative"
          class:is-drop-target={organization.hover===`project:${project.id}`}
          draggable={renamingId!==project.id}
          ondragstart={(event)=>organization.start(event,{kind:'project',id:project.id})}
          ondragend={()=>organization.end()}
          ondragover={(event)=>organization.over(event,{kind:'project',id:project.id})}
          ondrop={(event)=>{
            if(!organization.over(event,{kind:'project',id:project.id}))return;
            const source=organization.dragging!;
            if(source.kind==='project')organization.reorder('projects',organization.list('projects',codeStore.projects).map(project=>project.id),source.id,project.id);
            else if(source.kind==='chat'){const chat=appStore.chats.find(chat=>chat.id===source.id);if(chat)organization.moveChat(chat,null);}
            organization.end();
          }}
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
            <TriangleAlert class="sidebar-row-icon text-[var(--warning)]" />
          {:else if expanded}
            <FolderOpen class="sidebar-row-icon" />
          {:else}
            <Folder class="sidebar-row-icon" />
          {/if}

          {#if renamingId === project.id}
            <UiInput
              bind:ref={renameInput}
              class={uiClass("chat-rename-input sidebar-row-label")}
              bind:value={renameValue}
              maxlength={80}
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
              onclick={(event) => {
                // The row toggles the folder; the "+" opens a conversation in
                // it and must not also close it again.
                event.stopPropagation();
                codeStore.newConversation(project);
              }}
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
              <MenuItem icon={FolderPlus} label={$t('sidebarOrganize.newFolder')} onselect={()=>{organization.creatingIn=project.id;codeStore.expandedProjects[project.id]=true;}} />
              <MenuItem icon={ArrowUp} label={$t('sidebarOrganize.moveUp')} onselect={()=>organization.move('projects',organization.list('projects',codeStore.projects).map(project=>project.id),project.id,-1)} />
              <MenuItem icon={ArrowDown} label={$t('sidebarOrganize.moveDown')} onselect={()=>organization.move('projects',organization.list('projects',codeStore.projects).map(project=>project.id),project.id,1)} />
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
              <UiListRow
                type="button"
                class={uiClass("sidebar-row is-warning")}
                onclick={() => void codeStore.locateProject(project.id)}
              >
                <FolderSearch class="sidebar-row-icon" />
                <span class="sidebar-row-label">{$t('code.locateFolder')}</span>
              </UiListRow>
            {/if}
            <ProjectConversations {project} {sessions} {missing} {statusFor} onsplit={splitWith} />
          </div>
        {/if}
      </div>
    {/each}
  {/if}

  {#if unlinked.length}
    <div class="mt-3">
      <div class="flex items-center gap-1">
        <UiButton variant="plain"
          type="button"
          class={uiClass("sidebar-section min-w-0 flex-1")}
          aria-expanded={unlinkedOpen}
          title={$t('code.unlinkedHint')}
          onclick={() => (unlinkedOpen = !unlinkedOpen)}
        >
          <ChevronRight class={`size-3 shrink-0 transition-transform duration-150${unlinkedOpen ? ' rotate-90' : ''}`} />
          <span class="truncate">{$t('code.unlinked')} · {unlinked.length}</span>
        </UiButton>
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
              open={!!workspaceLayout.paneForChat(chat.id)}
              onselect={() => appStore.selectChat(chat.id)}
              onsplit={(edge) => splitWith(chat.id, edge)}
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
