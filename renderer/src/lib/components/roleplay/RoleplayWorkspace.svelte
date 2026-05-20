<svelte:options runes={true} />

<script lang="ts">
  import { onMount } from 'svelte';
  import { ArrowUp, Library, MessageSquarePlus, MoreHorizontal, Pencil, Plus, Search, Square, Sparkles, Trash2, X } from 'lucide-svelte';
  import Tooltip from '$lib/components/ui/Tooltip.svelte';
  import CharacterHub from '$lib/components/roleplay/CharacterHub.svelte';
  import CastSelectorModal from '$lib/components/roleplay/CastSelectorModal.svelte';
  import LorebookSelectorModal from '$lib/components/roleplay/LorebookSelectorModal.svelte';
  import SceneSettingsModal from '$lib/components/roleplay/SceneSettingsModal.svelte';
  import SelfProfileModal from '$lib/components/roleplay/SelfProfileModal.svelte';
  import ReasoningBlock from '$lib/ui/components/ReasoningBlock.svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { roleplayStore } from '$lib/stores/roleplay.svelte';
  import type { RoleplayChat, RoleplayConversationMode, RoleplayMessage } from '$lib/types/roleplay';

  let search = $state('');
  let searchFocused = $state(false);
  let debouncedSearch = $state('');
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let renamingChatId = $state<string | null>(null);
  let renamingChatTitle = $state('');
  let renameValue = $state('');
  let openMenuChatId = $state<string | null>(null);
  let renameInputEl = $state<HTMLInputElement | undefined>(undefined);
  let lorebookMenuOpen = $state(false);
  let lorebookSelectorOpen = $state(false);
  let castSelectorOpen = $state(false);
  let sceneSettingsOpen = $state(false);
  let selfModalOpen = $state(false);
  const NARRATOR_SPEAKER_ALIASES = new Set(['narrator', 'scene', 'storyteller', 'gm', 'game master']);

  type AssistantSegment = {
    id: string;
    kind: 'character' | 'narrator';
    speaker?: string;
    content: string;
  };

  function startOfDay(ts: number) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function groupLabel(ts: number): string {
    const now = startOfDay(Date.now());
    const day = startOfDay(ts);
    const diff = Math.floor((now - day) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff <= 6) return 'This week';
    return 'Older';
  }

  function castForChat(chat: RoleplayChat) {
    const ids = new Set(chat.activeCharacterIds);
    return roleplayStore.characters.filter((character) => ids.has(character.id));
  }

  const filteredChats = $derived.by(() => {
    const query = debouncedSearch.trim().toLowerCase();
    const chats = [...roleplayStore.chats].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!query) return chats;
    return chats.filter((chat) =>
      chat.title.toLowerCase().includes(query) ||
      chat.messages.some((message) => message.content.toLowerCase().includes(query)) ||
      castForChat(chat).some((character) => character.name.toLowerCase().includes(query))
    );
  });

  const groupedChats = $derived.by(() => {
    type ChatGroup = { key: number; label: string; chats: RoleplayChat[] };
    const groupMap = new Map<number, ChatGroup>();
    for (const chat of filteredChats) {
      const now = startOfDay(Date.now());
      const day = startOfDay(chat.updatedAt || chat.createdAt);
      const diff = Math.floor((now - day) / 86400000);
      const bucket = diff <= 0 ? 0 : diff === 1 ? 1 : diff <= 6 ? 2 : 3;
      if (!groupMap.has(bucket)) groupMap.set(bucket, { key: bucket, label: groupLabel(chat.updatedAt || chat.createdAt), chats: [] });
      groupMap.get(bucket)!.chats.push(chat);
    }
    return Array.from(groupMap.values()).sort((a, b) => a.key - b.key);
  });

  const isSearching = $derived(search.trim().length > 0);
  const matchCount = $derived(filteredChats.length);

  onMount(() => {
    if (!roleplayStore.ready) void roleplayStore.init();
  });

  $effect(() => {
    const current = search;
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      debouncedSearch = current;
    }, 150);
  });

  $effect(() => {
    if (!openMenuChatId) return;
    const close = () => { openMenuChatId = null; };
    const timer = setTimeout(() => {
      document.addEventListener('click', close, { once: true });
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('click', close);
    };
  });

  function send() {
    void roleplayStore.sendRoleplayMessage();
  }

  function createSceneWithSettings() {
    roleplayStore.createChat();
    sceneSettingsOpen = true;
    lorebookMenuOpen = false;
  }

  function startRename(chatId: string, title: string) {
    renamingChatId = chatId;
    renamingChatTitle = title;
    renameValue = title;
    setTimeout(() => {
      renameInputEl?.focus();
      renameInputEl?.select();
    }, 0);
  }

  function closeRename() {
    renamingChatId = null;
    renamingChatTitle = '';
    renameValue = '';
  }

  function commitRename(chatId: string) {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== renamingChatTitle) roleplayStore.renameChat(chatId, trimmed);
    closeRename();
  }

  function modeLabel(mode: RoleplayConversationMode) {
    if (mode === 'group') return 'Group';
    if (mode === 'narrative') return 'Narrative';
    return '1 to 1';
  }

  function characterForSpeaker(speaker?: string) {
    if (!speaker) return null;
    return roleplayStore.characters.find((character) => character.name.toLowerCase() === speaker.toLowerCase()) || null;
  }

  function assistantSpeaker() {
    const chat = roleplayStore.currentChat;
    if (!chat) return null;
    return roleplayStore.currentCast.find((character) => character.id === chat.settings.primaryCharacterId) || roleplayStore.currentCast[0] || null;
  }

  function messageAvatar(message: { role: 'user' | 'assistant'; speaker?: string }) {
    if (message.role === 'user') return { name: roleplayStore.selfProfile.name || 'User', image: roleplayStore.selfProfile.avatarDataUrl || '' };
    const character = characterForSpeaker(message.speaker) || assistantSpeaker();
    return { name: character?.name || message.speaker || 'Narrator', image: character?.avatarDataUrl || '' };
  }

  function normalizeSpeaker(value?: string) {
    return String(value || '').trim().toLowerCase();
  }

  function isNarratorSpeaker(value?: string) {
    return NARRATOR_SPEAKER_ALIASES.has(normalizeSpeaker(value));
  }

  function isKnownSpeaker(value?: string, fallbackSpeaker?: string) {
    const normalized = normalizeSpeaker(value);
    if (!normalized) return false;
    if (isNarratorSpeaker(normalized)) return true;
    if (characterForSpeaker(normalized)) return true;
    return normalized === normalizeSpeaker(fallbackSpeaker);
  }

  function splitAssistantMessage(message: RoleplayMessage): AssistantSegment[] {
    const raw = (message.content || (message.status === 'streaming' ? '...' : '')).trim();
    if (!raw) return [];

    const labeledSegments: { speaker?: string; content: string }[] = [];
    const lines = raw.split(/\r?\n/);
    let activeSpeaker: string | undefined;
    let activeLines: string[] = [];

    const flush = () => {
      const content = activeLines.join('\n').trim();
      if (!content) return;
      labeledSegments.push({ speaker: activeSpeaker, content });
    };

    for (const line of lines) {
      const match = line.match(/^(?:\*\*|__)?([A-Za-z][\w .'-]{0,40})(?:\*\*|__)?:\s*(.*)$/);
      if (match && isKnownSpeaker(match[1], message.speaker)) {
        flush();
        activeSpeaker = match[1].trim();
        activeLines = [match[2]];
        continue;
      }
      activeLines.push(line);
    }
    flush();

    const segments = (labeledSegments.length ? labeledSegments : [{ speaker: message.speaker, content: raw }])
      .map((entry, index) => ({
        id: `${message.id}-${index}`,
        kind: isNarratorSpeaker(entry.speaker) ? 'narrator' as const : 'character' as const,
        speaker: entry.speaker,
        content: entry.content
      }));

    const hasNarrator = segments.some((segment) => segment.kind === 'narrator');
    if (!hasNarrator) return segments;
    const narratorFirst = segments.filter((segment) => segment.kind === 'narrator');
    const characters = segments.filter((segment) => segment.kind === 'character');
    return [...narratorFirst, ...characters];
  }
</script>

<div class="roleplay-workspace flex min-h-0 flex-1 overflow-hidden rounded-[22px] border border-[var(--border)] bg-[var(--surface)]">
  <aside class="rp-sidebar-outer relative flex shrink-0 flex-col overflow-hidden" class:expanded={appStore.sidebarOpen}>
    <div class="rp-sidebar-full absolute inset-0 flex flex-col">
      <div class="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
        <div class="min-w-0">
          <h2 class="text-sm font-semibold text-[var(--text)]">Roleplay</h2>
          <p class="text-xs text-[var(--text-muted)]">Separate scenes and characters</p>
        </div>
      </div>

      <div class="space-y-2 border-b border-[var(--border)] p-3">
        <button class="action-btn flex w-full items-center gap-2 px-3 py-2 text-sm" onclick={createSceneWithSettings}>
          <span class="action-icon flex items-center justify-center"><MessageSquarePlus class="h-4 w-4" /></span>
          New scene
        </button>
        <button class="action-btn flex w-full items-center gap-2 px-3 py-2 text-sm" onclick={() => (roleplayStore.libraryOpen = true)}>
          <span class="action-icon flex items-center justify-center"><Library class="h-4 w-4" /></span>
          Character Hub
        </button>
      </div>

      <div class="border-b border-[var(--border)] p-3">
        <label class="relative block">
          <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            bind:value={search}
            onfocus={() => (searchFocused = true)}
            onblur={() => (searchFocused = false)}
            class="search-input w-full rounded-[6px] py-1.5 pl-8 pr-8 text-[13px] outline-none"
            class:focused={searchFocused}
            placeholder="Search scenes"
            type="text"
          />
          {#if isSearching}
            <button type="button" class="clear-btn absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5" onclick={() => (search = '')} aria-label="Clear search">
              <X class="h-3 w-3" />
            </button>
          {/if}
        </label>
        {#if isSearching}
          <p class="mt-1 px-0.5 text-[11px] text-[var(--text-muted)]">{matchCount} {matchCount === 1 ? 'result' : 'results'}</p>
        {/if}
      </div>

      <div class="history-list min-h-0 flex-1 overflow-y-auto p-2">
        {#if groupedChats.length}
          {#each groupedChats as group (group.key)}
            <div class="mb-1.5">
              <div class="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{group.label}</div>
              <div class="space-y-0.5">
                {#each group.chats as chat (chat.id)}
                  {@const cast = castForChat(chat)}
                  <div
                    class="scene-row group relative flex cursor-pointer items-start gap-1 rounded-[6px] px-2 py-1.5"
                    class:is-active={roleplayStore.currentChatId === chat.id}
                    role="button"
                    tabindex="0"
                    onclick={() => roleplayStore.selectChat(chat.id)}
                    ondblclick={() => startRename(chat.id, chat.title)}
                    onkeydown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        roleplayStore.selectChat(chat.id);
                      }
                    }}
                  >
                    <div class="min-w-0 flex-1 pr-1">
                      {#if renamingChatId === chat.id}
                        <input
                          bind:this={renameInputEl}
                          class="rename-input w-full"
                          bind:value={renameValue}
                          onclick={(event) => event.stopPropagation()}
                          onkeydown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              event.stopPropagation();
                              commitRename(chat.id);
                            }
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              event.stopPropagation();
                              closeRename();
                            }
                          }}
                          onblur={() => closeRename()}
                          maxlength="120"
                        />
                      {:else}
                        <span class="block truncate text-sm text-[var(--text)]">{chat.title || 'New scene'}</span>
                        <span class="block truncate text-xs text-[var(--text-muted)]">{chat.messages.length} {chat.messages.length === 1 ? 'message' : 'messages'}</span>
                        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                        <div class="cast-indicator mt-1" tabindex="0" aria-label={cast.length ? `${cast.length} active cast` : 'No cast'}>
                          <div class="cast-dots">
                            {#if cast.length}
                              <span class="cast-count">{cast.length}</span>
                              {#each cast.slice(0, 3) as character (character.id)}
                                {#if character.avatarDataUrl}
                                  <img class="cast-avatar" src={character.avatarDataUrl} alt="" />
                                {:else}
                                  <span class="cast-avatar avatar">{character.name.slice(0, 1)}</span>
                                {/if}
                              {/each}
                            {:else}
                              <span class="empty-cast-dot"></span>
                            {/if}
                          </div>
                          <div class="cast-popover">
                            {#if cast.length}
                              {#each cast as character (character.id)}
                                <div class="cast-person">
                                  {#if character.avatarDataUrl}
                                    <img class="cast-person-avatar" src={character.avatarDataUrl} alt="" />
                                  {:else}
                                    <span class="cast-person-avatar avatar">{character.name.slice(0, 1)}</span>
                                  {/if}
                                  <span class="truncate">{character.name}</span>
                                </div>
                              {/each}
                            {:else}
                              <span>No cast</span>
                            {/if}
                          </div>
                        </div>
                      {/if}
                    </div>
                    {#if renamingChatId !== chat.id}
                      <button
                        class="menu-btn mt-0.5 opacity-0 transition group-hover:opacity-100"
                        aria-label="Scene options"
                        onclick={(event) => {
                          event.stopPropagation();
                          openMenuChatId = openMenuChatId === chat.id ? null : chat.id;
                        }}
                      >
                        <MoreHorizontal class="h-3.5 w-3.5" />
                      </button>
                    {/if}
                    {#if openMenuChatId === chat.id}
                      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                      <div
                        class="scene-menu absolute right-1 top-8 z-30 w-36 rounded-[6px]"
                        role="menu"
                        tabindex="-1"
                        onclick={(event) => event.stopPropagation()}
                        onkeydown={(event) => event.stopPropagation()}
                      >
                        <button class="menu-item flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px]" onclick={(event) => { event.stopPropagation(); startRename(chat.id, chat.title); openMenuChatId = null; }}>
                          <Pencil class="h-3.5 w-3.5" />
                          Rename
                        </button>
                        <button class="menu-item danger flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px]" onclick={(event) => { event.stopPropagation(); confirmStore.show({ title: 'Delete scene?', message: 'This cannot be undone.', danger: true, onConfirm: () => roleplayStore.deleteChat(chat.id) }); openMenuChatId = null; }}>
                          <Trash2 class="h-3.5 w-3.5" />
                          Delete
                        </button>
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            </div>
          {/each}
        {:else}
          <div class="empty-state flex flex-col items-center justify-center py-12 text-center">
            <Sparkles class="mb-2 h-5 w-5 text-[var(--text-muted)]" />
            <p class="text-[13px] text-[var(--text-secondary)]">{isSearching ? 'No matches' : 'No scenes yet'}</p>
          </div>
        {/if}
      </div>

      <div class="border-t border-[var(--border)] p-3">
        <button class="action-btn flex w-full items-center justify-center gap-2 px-3 py-2 text-sm" aria-label="Exit roleplay" onclick={() => appStore.setShellMode('standard')}>
          <span class="action-icon flex items-center justify-center"><X class="h-4 w-4" /></span>
          Exit roleplay
        </button>
      </div>
    </div>

    <div class="rp-sidebar-collapsed absolute inset-0 flex flex-col items-center gap-1 py-2">
      <Tooltip label="New scene">
        <button class="collapsed-btn flex h-8 w-8 items-center justify-center" aria-label="New scene" onclick={createSceneWithSettings}>
          <Plus class="h-4 w-4" />
        </button>
      </Tooltip>
      <Tooltip label="Character Hub">
        <button class="collapsed-btn flex h-8 w-8 items-center justify-center" aria-label="Character Hub" onclick={() => (roleplayStore.libraryOpen = true)}>
          <Library class="h-4 w-4" />
        </button>
      </Tooltip>
      <div class="flex-1"></div>
      <Tooltip label="Exit roleplay">
        <button class="collapsed-btn flex h-8 w-8 items-center justify-center" aria-label="Exit roleplay" onclick={() => appStore.setShellMode('standard')}>
          <X class="h-4 w-4" />
        </button>
      </Tooltip>
    </div>
  </aside>

  <main class="flex min-w-0 flex-1 flex-col">
    {#if roleplayStore.currentChat}
      <header class="flex min-h-[64px] items-center justify-between gap-3 px-5">
        <div class="min-w-0">
          <h1 class="truncate text-base font-semibold text-[var(--text)]">{roleplayStore.currentChat.title}</h1>
          <p class="truncate text-xs text-[var(--text-muted)]">
            {modeLabel(roleplayStore.currentChat.settings.conversationMode)} · {roleplayStore.currentCast.length ? roleplayStore.currentCast.map((character) => character.name).join(', ') : 'No active character selected'}
          </p>
        </div>
        <div class="header-quick-group flex items-center">
          <div class="quick-menu">
            <button
              class="header-quick-btn group-btn rounded-l-md px-2.5 py-1.5 text-sm"
              class:is-active={sceneSettingsOpen}
              onclick={() => { sceneSettingsOpen = true; lorebookMenuOpen = false; }}
            >Scene</button>
          </div>
          <div class="quick-menu">
            <button
              class="header-quick-btn group-btn px-2.5 py-1.5 text-sm"
              class:is-active={castSelectorOpen}
              onclick={() => { castSelectorOpen = true; lorebookMenuOpen = false; }}
            >Cast</button>
          </div>
          <div class="quick-menu">
            <button
              class="header-quick-btn group-btn px-2.5 py-1.5 text-sm"
              class:is-active={lorebookSelectorOpen}
              onclick={() => { lorebookSelectorOpen = true; lorebookMenuOpen = false; }}
            >Lorebooks</button>
          </div>
          <div class="quick-menu">
            <button
              class="header-quick-btn group-btn rounded-r-md px-2.5 py-1.5 text-sm"
              class:is-active={selfModalOpen}
              onclick={() => { selfModalOpen = true; lorebookMenuOpen = false; }}
            >Self</button>
          </div>
        </div>
      </header>

      <section class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="messages min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {#if !roleplayStore.currentChat.messages.length && !roleplayStore.currentChat.settings.sceneSetupComplete}
            <div class="scene-welcome mx-auto flex min-h-full w-full max-w-md flex-col items-center justify-center py-6 text-center">
              <Sparkles class="mb-3 h-7 w-7 text-[var(--text-muted)]" />
              <p class="text-base font-semibold text-[var(--text)]">Ready for a new adventure?</p>
              <p class="mt-1 text-sm text-[var(--text-muted)]">Configure the scene, cast, lorebooks, narrator, and turn style before the first message.</p>
              <div class="welcome-art-wrap mt-6 w-full">
                <div class="welcome-art-inner">
                  <img class="welcome-art" src="/roleplay-welcome-bg.svg" alt="Roleplay scene preview background" loading="lazy" />
                </div>
              </div>
              <button class="start-adventure-btn mt-5 px-5 py-2.5 text-sm" onclick={() => (sceneSettingsOpen = true)}>
                Start adventure
              </button>
            </div>
          {:else}
            <div class="space-y-4">
              {#each roleplayStore.currentChat.messages as message (message.id)}
                {#if message.role === 'user'}
                  {@const avatar = messageAvatar(message)}
                  <article class="message is-user flex items-start gap-2">
                    <div class="bubble max-w-[78%] rounded-[8px] px-4 py-3">
                      <div class="mb-1 text-xs font-semibold text-[var(--text-muted)]">{message.speaker || avatar.name}</div>
                      <p class="whitespace-pre-wrap text-sm leading-6">{message.content || (message.status === 'streaming' ? '...' : '')}</p>
                    </div>
                    {#if avatar.image}
                      <img class="message-avatar" src={avatar.image} alt={avatar.name} />
                    {:else}
                      <span class="message-avatar avatar">{avatar.name.slice(0, 1)}</span>
                    {/if}
                  </article>
                {:else}
                  <div class="assistant-turn">
                    {#if appStore.config.ui?.enable_thinking && message.reasoning}
                      <ReasoningBlock reasoning={message.reasoning} status={message.status || 'idle'} autoOpenOnStreaming={false} />
                    {/if}
                  <div class="assistant-segments space-y-2">
                    {#each splitAssistantMessage(message) as segment (segment.id)}
                      {#if segment.kind === 'narrator'}
                        <article class="message is-narrator flex items-start gap-2">
                          <div class="bubble bubble-narrator max-w-[78%] rounded-[8px] px-4 py-3">
                            <div class="mb-1 text-xs font-semibold text-[var(--text-muted)]">{segment.speaker || 'Narrator'}</div>
                            <p class="whitespace-pre-wrap text-sm leading-6">{segment.content}</p>
                          </div>
                        </article>
                      {:else}
                        {@const avatar = messageAvatar({ role: 'assistant', speaker: segment.speaker || message.speaker })}
                        <article class="message flex items-start gap-2">
                          {#if avatar.image}
                            <img class="message-avatar" src={avatar.image} alt={avatar.name} />
                          {:else}
                            <span class="message-avatar avatar">{avatar.name.slice(0, 1)}</span>
                          {/if}
                          <div class="bubble max-w-[78%] rounded-[8px] px-4 py-3">
                            <div class="mb-1 text-xs font-semibold text-[var(--text-muted)]">{segment.speaker || avatar.name}</div>
                            <p class="whitespace-pre-wrap text-sm leading-6">{segment.content}</p>
                          </div>
                        </article>
                      {/if}
                    {/each}
                  </div>
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>

        {#if roleplayStore.currentChat.messages.length || roleplayStore.currentChat.settings.sceneSetupComplete}
        <div class="composer p-4">
          <div class="composer-shell flex items-end gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
            <textarea
              class="composer-textarea flex-1 resize-none bg-transparent text-[var(--text)] outline-none placeholder:text-[var(--text-muted)]"
              bind:value={roleplayStore.currentChat.draft}
              placeholder="Write your next turn..."
              oninput={(e) => roleplayStore.setDraft(e.currentTarget.value)}
              onkeydown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  send();
                }
              }}
            ></textarea>
              {#if roleplayStore.loading}
              <button class="send-btn send-btn-send" aria-label="Stop" onclick={() => roleplayStore.stopGeneration()}>
                <Square class="h-4 w-4 fill-current" strokeWidth={2.8} />
              </button>
            {:else}
              <button class="send-btn send-btn-send" aria-label="Send" onclick={send} disabled={!roleplayStore.currentChat.draft.trim()}>
                <span class="send-icon-wrap inline-flex">
                  <ArrowUp class="h-3.5 w-3.5 stroke-[2.75]" />
                </span>
              </button>
            {/if}
          </div>
          {#if roleplayStore.error}
            <p class="mt-2 text-xs text-[var(--error)]">{roleplayStore.error}</p>
          {/if}
        </div>
        {/if}
      </section>
    {/if}
  </main>
</div>

{#if roleplayStore.libraryOpen}
  <CharacterHub />
{/if}
{#if sceneSettingsOpen && roleplayStore.currentChat}
  <SceneSettingsModal
    chat={roleplayStore.currentChat}
    cast={roleplayStore.currentCast}
    lorebooks={roleplayStore.lorebooks}
    onClose={() => (sceneSettingsOpen = false)}
    onStart={() => (sceneSettingsOpen = false)}
    onCast={() => {
      sceneSettingsOpen = false;
      castSelectorOpen = true;
    }}
  />
{/if}
{#if castSelectorOpen}
  <CastSelectorModal
    characters={roleplayStore.characters}
    initialSelectedIds={roleplayStore.currentChat?.activeCharacterIds || []}
    onClose={() => (castSelectorOpen = false)}
    onEdit={() => {
      castSelectorOpen = false;
      roleplayStore.libraryOpen = true;
    }}
    onApply={(ids) => {
      roleplayStore.setActiveCharacters(ids);
      castSelectorOpen = false;
    }}
  />
{/if}
{#if lorebookSelectorOpen && roleplayStore.currentChat}
  <LorebookSelectorModal
    lorebooks={roleplayStore.lorebooks}
    initialSelectedIds={roleplayStore.currentChat.lorebookIds}
    onClose={() => (lorebookSelectorOpen = false)}
    onApply={(ids) => {
      roleplayStore.setAttachedLorebooks(ids);
      lorebookSelectorOpen = false;
    }}
  />
{/if}
{#if selfModalOpen}
  <SelfProfileModal
    profile={roleplayStore.selfProfile}
    onClose={() => (selfModalOpen = false)}
    onSave={(nextProfile) => roleplayStore.updateSelfProfile(nextProfile)}
    onApplySpeaker={() => roleplayStore.applySelfToCurrentChat()}
    onLoadIntoCast={() => roleplayStore.applySelfToCurrentChat({ autoLoadCast: true })}
    onReset={() => roleplayStore.resetSelfProfile()}
  />
{/if}

<style>
  .rp-sidebar-outer {
    width: 44px;
    background: var(--sidebar-bg, var(--surface));
    border-right: 1px solid var(--border);
    transition: width 0.5s cubic-bezier(0.32, 0.72, 0, 1);
    will-change: width;
  }
  .rp-sidebar-outer.expanded {
    width: 280px;
  }
  .rp-sidebar-full {
    opacity: 0;
    visibility: hidden;
    transform: translateX(-8px);
    transition: opacity 0.22s ease, transform 0.3s cubic-bezier(0.32, 0.72, 0, 1), visibility 0s linear 0.3s;
    pointer-events: none;
    overflow: hidden;
  }
  .rp-sidebar-outer.expanded .rp-sidebar-full {
    opacity: 1;
    visibility: visible;
    transform: translateX(0);
    transition-delay: 0.08s, 0.08s, 0s;
    pointer-events: auto;
  }
  .rp-sidebar-collapsed {
    opacity: 1;
    visibility: visible;
    transition: opacity 0.18s ease, transform 0.25s ease, visibility 0s linear;
  }
  .rp-sidebar-outer.expanded .rp-sidebar-collapsed {
    opacity: 0;
    visibility: hidden;
    transform: translateX(-6px);
    pointer-events: none;
  }
  .collapsed-btn {
    color: var(--text);
    border-radius: 4px;
  }
  .collapsed-btn:hover {
    background: var(--surface-hover);
  }
  .action-btn, .menu-btn {
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--text);
  }
  .action-icon {
    height: 20px;
    width: 20px;
    flex: 0 0 auto;
    border-radius: 4px;
    background: var(--surface-hover);
    color: var(--text-secondary);
  }
  .menu-btn {
    display: inline-flex;
    height: 32px;
    width: 32px;
    align-items: center;
    justify-content: center;
  }
  .action-btn:hover, .menu-btn:hover, .scene-row.is-active {
    background: var(--surface-hover);
  }
  .search-input {
    border: 1px solid var(--border);
    background: var(--surface-hover);
    color: var(--text);
  }
  .search-input.focused {
    border-color: var(--border-active);
    background: var(--surface);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .clear-btn {
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-muted);
  }
  .clear-btn:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
  .scene-row {
    border: 1px solid transparent;
    min-height: 76px;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .scene-row:hover {
    background: var(--surface-hover);
  }
  .scene-row.is-active {
    border-color: var(--border);
  }
  .rename-input {
    height: 30px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
    font-size: 13px;
    padding: 0 10px;
    outline: none;
  }
  .rename-input:focus {
    border-color: var(--border-active);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .scene-menu {
    border: 1px solid var(--border);
    background: var(--surface-overlay);
    box-shadow: var(--shadow-xl);
    padding: 4px;
  }
  .menu-item {
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text);
  }
  .menu-item:hover {
    border-color: var(--border);
    background: var(--surface-hover);
  }
  .menu-item.danger {
    color: var(--error);
  }
  .menu-item.danger:hover {
    background: var(--error-bg);
    border-color: var(--error-border);
  }
  .cast-indicator {
    position: relative;
    width: max-content;
    min-height: 20px;
    outline: none;
  }
  .cast-dots {
    display: inline-flex;
    align-items: center;
    gap: 0;
    height: 20px;
    max-width: 86px;
    border-radius: 999px;
    color: var(--text-muted);
  }
  .cast-count {
    display: inline-flex;
    height: 18px;
    min-width: 18px;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    font-size: 10px;
    font-weight: 700;
    color: var(--text-secondary);
  }
  .cast-avatar, .cast-person-avatar {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: 999px;
    border: 1px solid var(--surface);
    object-fit: cover;
    background: var(--surface-hover);
    color: var(--text);
    font-size: 10px;
    font-weight: 700;
  }
  .cast-avatar {
    width: 18px;
    height: 18px;
    margin-left: -4px;
  }
  .empty-cast-dot {
    width: 10px;
    height: 10px;
    border-radius: 999px;
    background: var(--text-muted);
    opacity: 0.45;
  }
  .cast-popover {
    position: absolute;
    left: 0;
    top: 22px;
    z-index: 20;
    display: grid;
    min-width: 148px;
    max-width: 220px;
    gap: 4px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--surface-overlay);
    box-shadow: var(--shadow-xl);
    color: var(--text);
    font-size: 12px;
    opacity: 0;
    pointer-events: none;
    transform: translateY(-2px);
    transition: opacity 0.12s ease, transform 0.12s ease;
    padding: 6px;
  }
  .cast-indicator:hover .cast-popover,
  .cast-indicator:focus .cast-popover,
  .cast-indicator:focus-within .cast-popover {
    opacity: 1;
    transform: translateY(0);
  }
  .cast-person {
    display: flex;
    min-width: 0;
    align-items: center;
    gap: 6px;
  }
  .cast-person-avatar {
    width: 22px;
    height: 22px;
    flex: 0 0 auto;
  }
  .message {
    justify-content: flex-start;
  }
  .message.is-user {
    justify-content: flex-end;
  }
  .message.is-narrator {
    justify-content: center;
  }
  .message-avatar {
    display: inline-flex;
    height: 32px;
    width: 32px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-hover);
    color: var(--text);
    object-fit: cover;
    font-size: 0.75rem;
    font-weight: 800;
  }
  .bubble {
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--text);
  }
  .message.is-user .bubble {
    background: var(--surface-hover);
  }
  .bubble.bubble-narrator {
    border-color: color-mix(in srgb, var(--border) 72%, transparent);
    background: color-mix(in srgb, var(--surface-hover) 55%, var(--surface));
  }
  .scene-welcome {
    color: var(--text);
  }
  .welcome-art-wrap {
    max-width: 560px;
    border-radius: 18px;
    padding: 1px;
    background:
      linear-gradient(135deg,
        color-mix(in srgb, #EEDABC 62%, transparent) 0%,
        color-mix(in srgb, var(--border) 45%, transparent) 45%,
        color-mix(in srgb, #E20E0F 26%, transparent) 100%);
    box-shadow: var(--shadow-sm);
  }
  .welcome-art-inner {
    position: relative;
    overflow: hidden;
    border-radius: 17px;
    background: color-mix(in srgb, var(--surface) 86%, transparent);
  }
  .welcome-art-inner::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 2;
    pointer-events: none;
    opacity: 0.42;
    mix-blend-mode: soft-light;
    background-image: radial-gradient(circle, color-mix(in srgb, #fff 72%, transparent) 1.3px, transparent 1.3px);
    background-size: 20px 20px;
    background-position: 0 0;
    transition: opacity 220ms ease;
    will-change: background-position;
  }
  .welcome-art-wrap:hover .welcome-art-inner::before {
    animation: dots-drift 3.4s linear infinite;
  }
  .welcome-art-inner::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 3;
    pointer-events: none;
    background: radial-gradient(circle at center, transparent 60%, color-mix(in srgb, var(--surface) 72%, transparent) 100%);
  }
  .welcome-art {
    display: block;
    width: 100%;
    max-height: 280px;
    object-fit: cover;
    opacity: 0.94;
  }
  @keyframes dots-drift {
    0% { background-position: 0 0; }
    25% { background-position: 5px -3px; }
    50% { background-position: 9px -6px; }
    75% { background-position: 4px -2px; }
    100% { background-position: 0 0; }
  }
  .start-adventure-btn {
    border: 1px solid #E20E0F;
    border-radius: 999px;
    background: #E20E0F;
    color: var(--primary-fg);
    font-weight: 700;
    transition: opacity 0.15s ease, transform 0.15s ease;
  }
  .start-adventure-btn:hover {
    opacity: 0.92;
  }
  .start-adventure-btn:active {
    transform: scale(0.97);
  }
  .composer-shell {
    border: 1px solid #EEDABC;
    box-shadow: var(--shadow-xs);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .composer-shell:focus-within {
    border-color: #EEDABC;
    box-shadow: 0 0 0 1px color-mix(in srgb, #EEDABC 60%, transparent), var(--shadow-sm);
  }
  .composer-textarea {
    min-height: 52px;
    max-height: 180px;
    font-size: 1rem;
    line-height: 1.6;
  }
  .send-btn {
    display: inline-flex;
    height: 32px;
    width: 32px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    background: #E20E0F;
    color: var(--primary-fg);
    transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1), opacity 150ms ease;
  }
  .send-btn-send {
    border-radius: 999px;
  }
  .send-btn:hover:not(:disabled) {
    opacity: 0.9;
  }
  .send-icon-wrap {
    transform-origin: center;
    transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
  }
  .send-btn:hover:not(:disabled) .send-icon-wrap {
    transform: rotate(35deg) translate(1px, -1px);
  }
  .send-btn:active:not(:disabled) {
    transform: scale(0.96);
  }
  .send-btn:disabled {
    opacity: 0.45;
  }
  .header-quick-group {
    border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--surface-hover) 32%, transparent);
    overflow: hidden;
  }
  .quick-menu {
    position: relative;
  }
  .group-btn {
    border-right: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  }
  .quick-menu:last-child .group-btn {
    border-right: none;
  }
  .header-quick-btn {
    border: none;
    background: transparent;
    color: var(--text-secondary);
    min-height: 34px;
    transition: background 0.15s ease, color 0.15s ease;
  }
  .header-quick-btn:hover {
    background: color-mix(in srgb, var(--surface-hover) 70%, var(--surface));
    color: var(--text);
  }
  .header-quick-btn.is-active {
    background: var(--surface);
    color: var(--text);
    font-weight: 650;
  }
</style>
