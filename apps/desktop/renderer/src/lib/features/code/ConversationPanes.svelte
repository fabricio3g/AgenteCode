<svelte:options runes={true} />

<!-- Conversation geometry lives in workspace-layout. Each leaf hosts a complete
     workspace with its own tools, panels and composer. Focus only updates the
     sidebar and the window's keyboard commands.

     The Code space stays mounted while another space is shown (AppShell's
     SpaceLayer), and the layout store then points at that space's centre. So
     the panes render from a snapshot of Code's own centre, taken only while
     Code is live, and every effect that writes the shared layout waits until
     it is live again: a hidden Code space neither rebuilds nor rewrites. -->

<script lang="ts">
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { workspaceLayout } from '$lib/stores/workspace-layout.svelte';
  import { measurePanes, panes as leavesOf, type Rect } from '$lib/components/layout/workspace-layout';
  import { spaceVisible } from '$lib/components/layout/space-visibility';
  import { displayChatTitle } from '$lib/features/shared/session-title';
  import ResizeHandle from '$lib/components/ui/ResizeHandle.svelte';
  import Menu from '$lib/components/ui/Menu.svelte';
  import MenuItem from '$lib/components/ui/MenuItem.svelte';
  import { copy } from '$lib/copy';
  import { openConversationWindow } from '$lib/features/shared/conversation-window';
  import { codeStore } from './code.svelte';
  import { codeWorkspace } from './workspace.svelte';
  import CodeSurface from './CodeSurface.svelte';
  import ConversationWorkspace from './ConversationWorkspace.svelte';

  let dividerRatio = 0.5;
  let dividerSnapshot: typeof workspaceLayout.centre = null;
  let menuChatId = $state('');
  let menuOpen = $state(false);
  let anchorPoint = $state<{ x: number; y: number } | null>(null);
  let width = $state(0);
  let height = $state(0);
  const shown = spaceVisible();
  /** On screen, with the layout store pointed at Code's centre (AppShell moves it per space). */
  const live = $derived(shown() && workspaceLayout.spaceScope.startsWith('space:code'));
  let view = $state.raw({ centre: workspaceLayout.centre, focused: workspaceLayout.focusedPane });
  let area = $state.raw<Rect>({ x: 0, y: 0, width: 0, height: 0 });
  $effect.pre(() => {
    if (!live) return;
    const next = { centre: workspaceLayout.centre, focused: workspaceLayout.focusedPane };
    untrack(() => { view = next; });
  });
  // Hidden measures 0×0: keep the last real size so no pane collapses.
  $effect.pre(() => {
    if (width > 0 && height > 0) { const next = { x: 0, y: 0, width, height }; untrack(() => { area = next; }); }
  });
  const leaves = $derived(leavesOf(view.centre));
  const measured = $derived(measurePanes(view.centre, area, view.focused));
  const placements = $derived(leaves.map(leaf => {
    const placement = measured.panes.find(item => item.id === leaf.id);
    return {...leaf,visible:!!placement,rect:placement?.rect ?? {x:0,y:0,width:0,height:0}};
  }));
  const many = $derived(leaves.length > 1);

  /* The window always shows a conversation: the first pane opens on whatever the
     app would have shown with no split at all, and picking another one in the
     sidebar swaps the focused pane rather than replacing the window's contents. */
  $effect(() => {
    const current = appStore.currentChatId;
    if (!live || !current) return;
    untrack(() => workspaceLayout.showConversation(current));
  });

  /* A split can show a chat that was never selected: load every pane's transcript. */
  $effect(() => {
    for (const leaf of placements) void appStore.ensureChatMessages(leaf.chatId);
  });

  $effect(() => {
    if (!live) return;
    const chatIds = new Set(appStore.chats.map((chat) => chat.id));
    untrack(() => workspaceLayout.pruneConversations(chatIds));
  });

  /* A split is refused against the centre, not the window. */
  $effect(() => {
    if (live && width > 0 && height > 0) workspaceLayout.centreSize = { width, height };
  });

  /**
   * Clicking a pane makes it the app's conversation too: the sidebar's
   * highlight, the strip's chips and every panel that reads "current" follow the
   * keyboard, and one rule keeps them from disagreeing.
   */
  function focus(placement: { id: string; chatId: string }) {
    if (workspaceLayout.focusedPane === placement.id && appStore.currentChatId === placement.chatId) return;
    workspaceLayout.focusPane(placement.id);
    if (appStore.currentChatId !== placement.chatId) codeStore.openConversation(placement.chatId);
  }

  /*
   * The Changes pane — and every other panel that reads a target — follows the
   * conversation the keyboard is in. One writer, so two mounted surfaces cannot
   * take turns overwriting it; `CodeSurface` deliberately does not do this.
   */
  $effect(() => {
    if (!live) return;
    const id = workspaceLayout.centreChatId;
    const chat = id ? appStore.chats.find((item) => item.id === id) ?? null : null;
    const project = codeStore.projectById(chat?.projectId ?? null);
    const sessionId = chat?.codeAgent?.sessionId;
    codeWorkspace.changesTarget = chat && project
      ? { chatId: chat.id, projectRoot: project.rootPath, ...(sessionId ? { sessionId } : {}) }
      : null;
    return () => { codeWorkspace.changesTarget = null; };
  });

  function title(chatId: string): string {
    const chat = appStore.chats.find((item) => item.id === chatId);
    return chat ? displayChatTitle(chat) : '';
  }

</script>

<div class="panes" bind:clientWidth={width} bind:clientHeight={height}>
  <!-- No panes yet (no project, nothing opened): the surface's own empty
       states, instead of a blank canvas. -->
  {#if !placements.length}<div class="pane-empty"><CodeSurface /></div>{/if}
  {#each placements as leaf (leaf.id)}
    {@const chat = appStore.chats.find((item) => item.id === leaf.chatId) ?? null}
    <section
      class="pane"
      class:is-focused={leaf.id === view.focused && many}
      style="left:{leaf.rect.x}px; top:{leaf.rect.y}px; width:{leaf.rect.width}px; height:{leaf.rect.height}px;"
      role="group"
      aria-label={title(leaf.chatId)}
      hidden={!leaf.visible}
      onpointerdown={() => focus(leaf)}
      onfocusin={() => focus(leaf)}
    >
      <div class="pane-content">
        {#if chat}{#key chat.id}<ConversationWorkspace {chat} split={many}
          onclose={() => {if(workspaceLayout.closePane(leaf.id)&&workspaceLayout.centreChatId)codeStore.openConversation(workspaceLayout.centreChatId);}}
          oncontextmenu={(event) => {event.preventDefault();menuChatId=leaf.chatId;anchorPoint={x:event.clientX,y:event.clientY};menuOpen=true;}}
        />{/key}{:else}<CodeSurface />{/if}
      </div>
    </section>
  {/each}

  {#each measured.dividers as divider (divider.id)}
    <div class="divider" style="left:{divider.rect.x}px; top:{divider.rect.y}px; width:{divider.rect.width}px; height:{divider.rect.height}px;">
      <ResizeHandle fill visible axis={divider.axis} label={$t(divider.axis === 'x' ? 'workspace.resizeWidth' : 'workspace.resizeHeight')}
        onstart={() => { dividerRatio = divider.ratio ?? 0.5; dividerSnapshot = workspaceLayout.centre; workspaceLayout.interacting = true; }}
        onresize={(delta) => workspaceLayout.resizePanes(divider.id, dividerRatio + delta / Math.max(1, divider.length))}
        onend={() => { workspaceLayout.interacting = false; workspaceLayout.save(); }}
        oncancel={() => { workspaceLayout.centre = dividerSnapshot; workspaceLayout.interacting = false; workspaceLayout.save(); }}
      />
    </div>
  {/each}
</div>
<Menu bind:open={menuOpen} bind:anchorPoint label={copy.actions.more}>
  {#snippet trigger()}<span></span>{/snippet}
  <MenuItem label={$t('code.pane.openWindow')} onselect={() => void openConversationWindow(menuChatId)} />
</Menu>

<style>
  .pane-empty { position: absolute; inset: 0; display: flex; }
  .panes {
    position: relative;
    display: block;
    min-width: 0;
    min-height: 0;
    flex: 1;
    overflow: hidden;
  }
  .pane {
    position: absolute;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    border-radius: 0.875rem;
    background: var(--chat-bg);
  }
  .pane[hidden] { display:none; }
  .pane-content {
    display: flex;
    min-width: 0;
    min-height: 0;
    flex: 1;
    padding: 0;
    overflow: hidden;
  }
  .divider { position: absolute; z-index: 2; }
</style>
