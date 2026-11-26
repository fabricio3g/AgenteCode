<svelte:options runes={true} />

<!--
  Code sidebar: a tree of project folders, each holding its conversations.
  The header's folder-plus adds a project; the rail's New conversation starts
  one whose folder the composer's project picker chooses.

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
    Check,
    FolderPlus,
    Copy as CopyIcon,
    Folder,
    FolderOpen,
    FolderSearch,
    FolderTree,
    LayoutList,
    MoreHorizontal,
    Pencil,
    Pin,
    PinOff,
    Plus,
    SlidersHorizontal,
    Trash2,
    TriangleAlert,
    X
  } from '$lib/icons';
  import { t } from 'svelte-i18n';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import IconButton from '$lib/components/ui/IconButton.svelte';
  import StatusDot from '$lib/components/ui/StatusDot.svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import ProjectConversations from './ProjectConversations.svelte';
  import { sidebarOrganization as organization } from './sidebar-organization.svelte';
  import SessionRow from '$lib/features/shared/SessionRow.svelte';
  import { codeStore } from './code.svelte';
  import { driversStore, sessionBadgeFor } from './drivers.svelte';
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
    void driversStore.load(false);
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

  const SIDEBAR_MODE_KEY = 'agente_code_sidebar_mode';
  type CodeSidebarMode = 'projects' | 'threads';
  type CodeSidebarFilter = 'all' | 'active' | 'pinned';

  let sidebarMode = $state<CodeSidebarMode>(
    typeof localStorage !== 'undefined' && localStorage.getItem(SIDEBAR_MODE_KEY) === 'threads'
      ? 'threads'
      : 'projects'
  );
  let filterKind = $state<CodeSidebarFilter>('all');

  const hasFilter = $derived(filterKind !== 'all');

  function setSidebarMode(next: CodeSidebarMode) {
    if (sidebarMode === next) return;
    sidebarMode = next;
    try {
      localStorage.setItem(SIDEBAR_MODE_KEY, next);
    } catch {
      /* private mode */
    }
  }

  function clearFilters() {
    filterKind = 'all';
  }

  function startOfDay(ms: number): number {
    const date = new Date(ms);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  const projectNames = $derived(new Map(codeStore.projects.map((project) => [project.id, project.rootName])));

  function matchesChat(chat: ChatSession): boolean {
    if (filterKind === 'active') return tree.status.has(chat.id);
    if (filterKind === 'pinned') return organization.isPinned('chats', chat.id);
    return true;
  }

  const visibleProjects = $derived.by(() => {
    const ordered = organization.pinnedFirst('projects', organization.list('projects', codeStore.projects));
    if (!hasFilter) {
      return ordered.map((project) => ({ project, sessions: sessionsFor(project.id) }));
    }
    return ordered.flatMap((project) => {
      const all = sessionsFor(project.id);
      const matchedSessions = all.filter((chat) => matchesChat(chat));
      if (filterKind === 'pinned') {
        if (organization.isPinned('projects', project.id)) return [{ project, sessions: all }];
        return matchedSessions.length ? [{ project, sessions: matchedSessions }] : [];
      }
      return matchedSessions.length ? [{ project, sessions: matchedSessions }] : [];
    });
  });

  const threadGroups = $derived.by(() => {
    type ThreadGroup = { key: number; label: string; chats: ChatSession[] };
    const map = new Map<number, ThreadGroup>();
    const now = startOfDay(Date.now());
    const sorted = [...appStore.visibleCodeChats]
      .filter((chat) => matchesChat(chat))
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    const labelFor = (bucket: number) => {
      switch (bucket) {
        case -2: return $t('code.activeThreads');
        case -1: return $t('code.pinned');
        case 0: return $t('sidebar.today');
        case 1: return $t('sidebar.yesterday');
        case 2: return $t('sidebar.previous7Days');
        case 3: return $t('sidebar.previous30Days');
        default: return $t('sidebar.older');
      }
    };
    for (const chat of sorted) {
      const live = tree.status.has(chat.id);
      const pinned = organization.isPinned('chats', chat.id);
      const day = startOfDay(chat.updatedAt || chat.createdAt);
      const diff = Math.floor((now - day) / 86400000);
      const bucket = live ? -2 : pinned ? -1 : diff <= 0 ? 0 : diff === 1 ? 1 : diff <= 6 ? 2 : diff <= 29 ? 3 : 4;
      let group = map.get(bucket);
      if (!group) {
        group = { key: bucket, label: labelFor(bucket), chats: [] };
        map.set(bucket, group);
      }
      group.chats.push(chat);
    }
    return Array.from(map.values()).sort((a, b) => a.key - b.key);
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
  <div class="sidebar-section-row">
    <span class="sidebar-section">{$t(sidebarMode === 'threads' ? 'code.threads' : 'code.projects')}</span>
    <div class="sidebar-header-controls">
      <Tooltip label={$t('code.addProject')} position="bottom">
        <button type="button" class="mode-btn" aria-label={$t('code.addProject')} onclick={() => void codeStore.addProject()}>
          <FolderPlus class="size-3.5" />
        </button>
      </Tooltip>
      <Menu placement="bottom-end" label={$t('code.filterToggle')}>
        {#snippet trigger(props)}
          <Tooltip label={$t('code.filterToggle')} position="bottom">
            <button
              {...props}
              type="button"
              class="mode-btn filter-btn"
              class:is-active={hasFilter}
              class:has-filter={hasFilter}
              aria-label={$t('code.filterToggle')}
            >
              <SlidersHorizontal class="size-3.5" />
            </button>
          </Tooltip>
        {/snippet}
        <MenuItem icon={filterKind === 'all' ? Check : undefined} label={$t('code.filterAll')} onselect={() => (filterKind = 'all')} />
        <MenuItem icon={filterKind === 'active' ? Check : undefined} label={$t('code.filterActive')} onselect={() => (filterKind = 'active')} />
        <MenuItem icon={filterKind === 'pinned' ? Check : undefined} label={$t('code.filterPinned')} onselect={() => (filterKind = 'pinned')} />
      </Menu>
      <div class="sidebar-mode-toggle" role="group" aria-label={$t('code.threads')}>
        <Tooltip label={$t('code.viewProjects')} position="bottom">
          <button
            type="button"
            class="mode-btn"
            class:is-active={sidebarMode === 'projects'}
            aria-pressed={sidebarMode === 'projects'}
            aria-label={$t('code.viewProjects')}
            onclick={() => setSidebarMode('projects')}
          >
            <FolderTree class="size-3.5" />
          </button>
        </Tooltip>
        <Tooltip label={$t('code.viewThreads')} position="bottom">
          <button
            type="button"
            class="mode-btn"
            class:is-active={sidebarMode === 'threads'}
            aria-pressed={sidebarMode === 'threads'}
            aria-label={$t('code.viewThreads')}
            onclick={() => setSidebarMode('threads')}
          >
            <LayoutList class="size-3.5" />
          </button>
        </Tooltip>
      </div>
    </div>
  </div>

  {#if sidebarMode === 'threads'}
    {#if !codeStore.loading && !threadGroups.length}
      <p class="px-2.5 py-2 text-[length:var(--text-sm)] leading-relaxed text-[var(--text-muted)]">
        {$t(hasFilter ? 'code.noFilterMatches' : codeStore.projects.length ? 'code.noThreads' : 'code.noProjects')}
      </p>
      {#if hasFilter}
        <UiListRow type="button" class={uiClass("sidebar-row is-emphasis")} onclick={clearFilters}>
          <X class="sidebar-row-icon" />
          <span class="sidebar-row-label">{$t('code.clearFilters')}</span>
        </UiListRow>
      {:else}
        <UiListRow
          type="button"
          class={uiClass("sidebar-row is-emphasis")}
          onclick={() => {
            const target = codeStore.projects.find((p) => p.id === codeStore.activeProjectId) ?? codeStore.projects[0];
            if (target) codeStore.newConversation(target);
            else void codeStore.addProject();
          }}
        >
          <Plus class="sidebar-row-icon" />
          <span class="sidebar-row-label">{$t(codeStore.projects.length ? 'code.newConversation' : 'code.addProject')}</span>
        </UiListRow>
      {/if}
    {:else}
      {#each threadGroups as group (group.key)}
        <div class="mt-1 first:mt-0">
          <span class="sidebar-section thread-group-label">{group.label}</span>
          <div class="space-y-0.5">
            {#each group.chats as chat (chat.id)}
              <SessionRow
                {chat}
                active={appStore.currentChatId === chat.id}
                open={!!workspaceLayout.paneForChat(chat.id)}
                status={statusFor(chat.id)}
                pinned={organization.isPinned('chats', chat.id)}
                onpin={() => organization.togglePin('chats', chat.id)}
                badge={[chat.projectId ? (projectNames.get(chat.projectId) ?? '') : '', sessionBadgeFor(chat)].filter(Boolean).join(' · ')}
                onselect={() => codeStore.openConversation(chat.id)}
                onsplit={(edge) => splitWith(chat.id, edge)}
                menuLabel={$t('code.conversationOptions')}
              />
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  {:else if !codeStore.loading && !codeStore.projects.length}
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
  {:else if hasFilter && !visibleProjects.length}
    <p class="px-2.5 py-2 text-[length:var(--text-sm)] leading-relaxed text-[var(--text-muted)]">
      {$t('code.noFilterMatches')}
    </p>
    <UiListRow type="button" class={uiClass("sidebar-row is-emphasis")} onclick={clearFilters}>
      <X class="sidebar-row-icon" />
      <span class="sidebar-row-label">{$t('code.clearFilters')}</span>
    </UiListRow>
  {:else}
    {#each visibleProjects as { project, sessions } (project.id)}
      {@const expanded = hasFilter || !!codeStore.expandedProjects[project.id]}
      {@const missing = !!codeStore.missingProjects[project.id]}
      {@const pinnedProject = organization.isPinned('projects', project.id)}
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
            {#if pinnedProject}
              <Pin class="project-pin" aria-hidden="true" />
            {/if}
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
              <MenuItem icon={pinnedProject ? PinOff : Pin} label={$t(pinnedProject ? 'code.unpin' : 'code.pin')} onselect={() => organization.togglePin('projects', project.id)} />
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

  {#if sidebarMode === 'projects' && unlinked.length}
    <div class="mt-1.5">
      <div class="sidebar-section-row">
        <UiButton variant="plain"
          type="button"
          class={uiClass("sidebar-section")}
          aria-expanded={unlinkedOpen}
          title={$t('code.unlinkedHint')}
          onclick={() => (unlinkedOpen = !unlinkedOpen)}
        >
          <span class="truncate">{$t('code.unlinked')}</span>
          <span class="pane-count">{unlinked.length}</span>
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
  .sidebar-header-controls {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .sidebar-mode-toggle {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: var(--radius-sm);
    background: var(--accent);
  }

  .mode-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.375rem;
    height: 1.375rem;
    border: 0;
    border-radius: calc(var(--radius-sm) - 1px);
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
    transition: color var(--motion-instant) var(--motion-ease),
      background-color var(--motion-instant) var(--motion-ease);
  }

  .mode-btn:hover {
    color: var(--foreground);
  }

  .mode-btn.is-active {
    background: var(--segment-active-bg);
    color: var(--foreground);
    box-shadow: var(--segment-active-shadow);
  }

  .filter-btn.has-filter {
    color: var(--brand-accent);
  }

  :global(.project-pin) {
    width: 0.72rem;
    height: 0.72rem;
    flex-shrink: 0;
    color: var(--brand-accent);
    opacity: 0.85;
  }

  .thread-group-label {
    font-size: 0.6875rem;
    opacity: 0.8;
  }

  /*
   * Conversations hang from a hairline under the folder icon: the indent puts
   * the rule at the icon's centre — the row's inset plus half the one icon
   * token — so it stays aligned when that token changes with the composer's
   * glyph scale.
   */
  .tree-children {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 1px 0 0.375rem calc(0.5rem + var(--sidebar-icon) / 2);
    padding-left: 0.25rem;
    border-left: 1px solid color-mix(in srgb, var(--sidebar-border) 70%, transparent);
  }
</style>
