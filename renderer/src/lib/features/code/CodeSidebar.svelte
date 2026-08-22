<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { slide } from 'svelte/transition';
  import { ChevronRight, Folder, MessageSquare, Plus, Trash2 } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import { codeStore } from './code.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';

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

  function confirmRemoveProject(projectId: string, name: string) {
    confirmStore.show({
      title: $t('code.removeProjectTitle'),
      message: $t('code.removeProjectMessage', { values: { name } }),
      danger: true,
      confirmLabel: $t('code.removeProject'),
      onConfirm: () => {
        void codeStore.removeProject(projectId);
      }
    });
  }
</script>

<div class="flex flex-col gap-0.5 pb-2 pt-3">
  <span class="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
    {$t('code.projects')}
  </span>

  {#if !codeStore.loading && !codeStore.projects.length}
    <p class="px-2.5 py-2 text-[13px] leading-relaxed text-[var(--text-muted)]">
      {$t('code.noProjects')}
    </p>
    <button
      type="button"
      class="session-item flex w-full items-center gap-2 px-2.5 py-[5px] text-left text-[14px]"
      onclick={() => void codeStore.addProject()}
    >
      <Plus class="size-3.5 shrink-0" />
      <span class="truncate">{$t('code.addProject')}</span>
    </button>
  {:else}
    {#each codeStore.projects as project (project.id)}
      {@const expanded = !!codeStore.expandedProjects[project.id]}
      {@const sessions = codeStore.sessionsFor(project.id)}
      <div class="project group/project">
        <div
          class="session-item project-row group/projrow relative flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-[5px] text-left"
          class:is-active={codeStore.activeProjectId === project.id}
          role="button"
          tabindex="0"
          onclick={() => {
            codeStore.toggleExpanded(project.id);
            codeStore.activeProjectId = project.id;
          }}
          onkeydown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              codeStore.toggleExpanded(project.id);
              codeStore.activeProjectId = project.id;
            }
          }}
        >
          <ChevronRight
            class={`size-3 shrink-0 text-[var(--text-muted)] transition-transform duration-150${expanded ? ' rotate-90' : ''}`}
          />
          <Folder class="size-3.5 shrink-0" />
          <span class="min-w-0 flex-1 truncate text-[14px]">{project.rootName}</span>
          <button
            type="button"
            class="menu-btn rounded-[var(--radius-sm)] p-1 opacity-0 transition group-hover/projrow:opacity-100"
            onclick={(e) => {
              e.stopPropagation();
              confirmRemoveProject(project.id, project.rootName);
            }}
            aria-label={$t('code.removeProject')}
          >
            <Trash2 class="h-3.5 w-3.5" />
          </button>
        </div>

        {#if expanded}
          <div class="ml-4 mt-1 space-y-0.5 border-l border-[var(--sidebar-border)] pl-1 pb-1" transition:slide={{ duration: 140 }}>
            {#each sessions as session (session.id)}
              <button
                type="button"
                class="session-item flex w-full items-center gap-2 px-2.5 py-[5px] text-left"
                class:is-active={appStore.currentChatId === session.id}
                onclick={() => codeStore.openConversation(session.id)}
              >
                <MessageSquare class="size-3.5 shrink-0" />
                <span class="min-w-0 flex-1 truncate text-[14px]">{session.title}</span>
              </button>
            {/each}
            <button
              type="button"
              class="session-item flex w-full items-center gap-2 px-2.5 py-[5px] text-left text-[14px] text-[var(--text-muted)]"
              onclick={() => codeStore.newConversation(project)}
            >
              <Plus class="size-3.5 shrink-0" />
              <span class="truncate">{$t('code.newConversation')}</span>
            </button>
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .session-item {
    color: var(--muted-foreground);
    background: transparent;
    border: none;
    border-radius: var(--radius-full);
    transition:
      background-color var(--motion-fast) var(--motion-ease),
      color var(--motion-fast) var(--motion-ease);
  }

  .session-item:hover {
    background: var(--sidebar-accent);
    color: var(--sidebar-accent-foreground);
  }

  .session-item.is-active {
    background: var(--sidebar-accent);
    color: var(--foreground);
  }

  .menu-btn {
    color: var(--muted-foreground);
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .menu-btn:hover {
    color: var(--sidebar-foreground);
    background: var(--sidebar-accent);
  }
</style>
