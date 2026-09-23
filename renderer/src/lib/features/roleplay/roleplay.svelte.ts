/**
 * The Roleplay space's scene state: who speaks next, the cast, auto mode,
 * story turns, the scene journal and how a scene starts.
 *
 * Chats themselves stay in the app store (one list, one persistence path);
 * this store reads and writes the `roleplay` slice of a chat through the
 * host it is bound to, and hands the send path a `RoleplayTurn` for each
 * generation. The app store binds itself at construction.
 */

import type {
  CharacterCard,
  ChatContextMode,
  ChatMessage,
  ChatSession,
  LorebookEntry,
  RoleplayJournalEntry,
  RoleplaySettings,
  RoleplayWorld
} from '$lib/types/chat';
import type { RoleplayAttribution } from '$lib/stores/app-message-pipeline';
import {
  buildRoleplaySystemPrompt as composeRoleplayPrompt,
  resolveLorebooks,
  resolveRoleplaySampling,
  type RoleplaySampling
} from '$lib/services/roleplay-prompts';
import { toastStore } from '$lib/stores/toast.svelte';
import { createId } from '$lib/utils/id';
import { charactersStore, greetingsFor } from './characters.svelte';
import { worldsStore } from './worlds.svelte';
import { selectNextSpeaker } from './group-turn';
import { buildRoleplayStopStrings, stripSpeakerPrefix } from './roleplay-output';
import { stripRoleplayChoiceBlock } from './roleplay-choices';
import { makeSilenceTurn, makeTwistTurn, pickTwist, type StoryTurn } from './roleplay-twists';
import { createRoleplayTurn, PASSTHROUGH_TURN, type RoleplayTurn } from './roleplay-turn';

/** What the roleplay store needs from the app store. */
interface RoleplayHost {
  readonly currentChat: ChatSession | null;
  readonly currentChatId: string | null;
  readonly currentChatGenerating: boolean;
  readonly userName: string;
  composer: string;
  findChat(chatId: string | null | undefined): ChatSession | null;
  createChat(mode: ChatContextMode): ChatSession;
  appendMessageToChat(chatId: string, message: ChatMessage): unknown;
  touchChats(): void;
  persist(): void;
  sendCurrentMessage(options?: { silent?: boolean }): Promise<void>;
}

/** The journal rides on the chat's roleplay JSON, so it stays bounded. */
const MAX_JOURNAL_ENTRIES = 200;

function isRoleplay(chat: ChatSession | null | undefined): chat is ChatSession {
  return chat?.contextMode === 'roleplay';
}

class RoleplayStore {
  private host!: RoleplayHost;

  /**
   * Group scenes: who speaks next. Transient (never persisted) and defaults to
   * the primary character, so 1:1 chats are unaffected.
   */
  private speakerOverrides: Record<string, string> = {};
  /**
   * A turn the user did not write, queued for the next generation: a thrown
   * twist, or the silence of a choice that ran out with nothing said.
   */
  private pendingStoryTurns: Record<string, StoryTurn> = {};
  /** Auto mode: consecutive character turns and the pending continuation. */
  private autoTurns: Record<string, number> = {};
  private autoTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  /** Wall-clock deadline of the pending auto turn, for the header countdown. */
  autoDeadlines = $state<Record<string, number>>({});

  bind(host: RoleplayHost) {
    this.host = host;
  }

  /** The current chat when it is a roleplay scene. */
  private get scene(): ChatSession | null {
    const chat = this.host.currentChat;
    return isRoleplay(chat) ? chat : null;
  }

  private save() {
    this.host.touchChats();
    this.host.persist();
  }

  private patchSettings(chat: ChatSession, patch: Partial<RoleplaySettings>) {
    chat.roleplay = { ...(chat.roleplay || {}), ...patch } as RoleplaySettings;
  }

  // ── Cast and speakers ─────────────────────────────────────────────────

  /** The character whose turn it is in a scene. */
  private speakerId(chat: ChatSession | null): string | null {
    if (!chat) return null;
    return this.speakerOverrides[chat.id] || chat.characterId || null;
  }

  /** The scene's cast ids in roster order (the primary alone for 1:1). */
  private castIds(chat: ChatSession): string[] {
    if (chat.roleplay?.characterIds?.length) return chat.roleplay.characterIds;
    return chat.characterId ? [chat.characterId] : [];
  }

  /** The scene's cast in roster order. */
  private cast(chat: ChatSession | null): CharacterCard[] {
    if (!chat) return [];
    return this.castIds(chat)
      .map((id) => charactersStore.getById(id))
      .filter((card): card is CharacterCard => !!card);
  }

  /**
   * Who speaks next: a forced speaker wins, otherwise the scene's reply order
   * decides. 1:1 scenes always answer as the character; manual order answers
   * as the primary on a plain send (the user force-talks for anyone else).
   */
  private routeSpeaker(chat: ChatSession, messages: ChatMessage[] = chat.messages): string | null {
    const cast = this.cast(chat);
    if (cast.length < 2) return chat.characterId || null;
    const forced = this.speakerOverrides[chat.id];
    if (forced) return forced;
    const strategy = chat.roleplay?.replyOrder || 'list';
    if (strategy === 'manual') return chat.characterId || null;
    return selectNextSpeaker({
      strategy,
      cast,
      messages,
      mutedIds: chat.roleplay?.mutedIds || [],
      allowSelfReplies: false
    });
  }

  /** Force the next speaker in a group scene (null resets to turn order). */
  setSpeaker(characterId: string | null) {
    const chat = this.scene;
    if (!chat) return;
    if (!characterId || characterId === chat.characterId) delete this.speakerOverrides[chat.id];
    else this.speakerOverrides[chat.id] = characterId;
  }

  /** Who the roster should show as next, without forcing a turn. */
  peekSpeaker(): CharacterCard | null {
    const chat = this.scene;
    return chat ? charactersStore.getById(this.routeSpeaker(chat)) : null;
  }

  /** Replace the scene's cast mid-chat (add, remove, reorder). */
  setCast(characterIds: string[]) {
    const chat = this.scene;
    if (!chat) return;
    const cast = [...new Set(characterIds)].filter((id) => !!charactersStore.getById(id));
    if (!cast.length) return;
    const muted = (chat.roleplay?.mutedIds || []).filter((id) => cast.includes(id));
    this.patchSettings(chat, { characterIds: cast, mutedIds: muted });
    // The primary must be a member; removing it promotes the new first member.
    if (!chat.characterId || !cast.includes(chat.characterId)) chat.characterId = cast[0];
    delete this.speakerOverrides[chat.id];
    this.save();
  }

  /** Mute or unmute a group member for this scene. */
  toggleMute(characterId: string) {
    const chat = this.scene;
    if (!chat) return;
    const muted = new Set(chat.roleplay?.mutedIds || []);
    if (muted.has(characterId)) muted.delete(characterId);
    else muted.add(characterId);
    this.patchSettings(chat, { mutedIds: [...muted] });
    this.save();
  }

  /** Change the scene's speaker order. */
  setReplyOrder(order: RoleplaySettings['replyOrder']) {
    const chat = this.scene;
    if (!chat || !order) return;
    this.patchSettings(chat, { replyOrder: order });
    this.save();
  }

  /** Scene settings: one option at a time (order, delay, toggles). */
  setOption<K extends keyof RoleplaySettings>(key: K, value: RoleplaySettings[K]) {
    const chat = this.scene;
    if (!chat) return;
    this.patchSettings(chat, { [key]: value } as Partial<RoleplaySettings>);
    this.save();
  }

  /** Bind the current scene to a user persona (null = none). */
  setPersona(personaId: string | null) {
    const chat = this.scene;
    if (!chat) return;
    chat.personaId = personaId;
    this.save();
  }

  // ── Turns ─────────────────────────────────────────────────────────────

  /** Generate a character turn with no user message (force talk, auto mode). */
  async speakNow(characterId?: string | null) {
    if (!this.scene) return;
    if (characterId) this.setSpeaker(characterId);
    await this.host.sendCurrentMessage({ silent: true });
  }

  /** Adventure choices: clicking one sends it as the user's turn. */
  async sendChoice(choice: string) {
    if (!this.scene) return;
    const text = String(choice || '').trim();
    if (!text) return;
    this.host.composer = text;
    await this.host.sendCurrentMessage();
  }

  /** Throw a story twist at the scene: a GM move, never a user turn. */
  async throwTwist() {
    const chat = this.scene;
    if (!chat || this.host.currentChatGenerating) return;
    this.pendingStoryTurns = { ...this.pendingStoryTurns, [chat.id]: makeTwistTurn(pickTwist(), this.names(chat)) };
    await this.speakNow();
  }

  /**
   * A clocked choice ran out with nothing said. Saying nothing is the turn —
   * never a random pick from the panel.
   */
  async expireChoice() {
    const chat = this.scene;
    if (!chat || this.host.currentChatGenerating) return;
    this.pendingStoryTurns = { ...this.pendingStoryTurns, [chat.id]: makeSilenceTurn(this.names(chat)) };
    await this.speakNow();
  }

  private takeStoryTurn(chatId: string): StoryTurn | undefined {
    const turn = this.pendingStoryTurns[chatId];
    if (!turn) return undefined;
    const next = { ...this.pendingStoryTurns };
    delete next[chatId];
    this.pendingStoryTurns = next;
    return turn;
  }

  /**
   * Gate and route a scene turn before it is sent. `messages` is the history
   * including the user's new message, so mentions inside it are seen. A scene
   * without a character, or where everyone is muted, cannot be answered.
   */
  routeTurn(chat: ChatSession, messages: ChatMessage[]): boolean {
    if (!isRoleplay(chat)) return true;
    const cast = this.cast(chat);
    if (!cast.length) {
      toastStore.info('This scene has no character. Choose one to continue.', 4000);
      return false;
    }
    const speaker = this.routeSpeaker(chat, messages);
    if (!speaker && cast.length > 1) {
      toastStore.info('Everyone is muted — unmute a character to continue.', 4000);
      return false;
    }
    if (speaker) this.speakerOverrides[chat.id] = speaker;
    else delete this.speakerOverrides[chat.id];
    return true;
  }

  /**
   * Everything one generation carries besides its prompt. Consumes the queued
   * story turn — one turn, one generation. `consumeRouting` also spends the
   * routed speaker (a fresh send); a regenerate keeps it for the next send.
   */
  prepareTurn(chat: ChatSession, options: { speakerId?: string | null; consumeRouting?: boolean } = {}): RoleplayTurn {
    if (!isRoleplay(chat)) return PASSTHROUGH_TURN;
    const speakerId = options.speakerId ?? this.speakerId(chat);
    const parts = this.promptParts(chat, speakerId);
    const turn = createRoleplayTurn({
      speakerId,
      attribution: this.attribution(chat, speakerId),
      sampling: parts.sampling,
      stop: parts.stop,
      sanitize: this.outputSanitizer(chat),
      choices: !!chat.roleplay?.adventureChoices,
      storyTurn: this.takeStoryTurn(chat.id)
    });
    if (options.consumeRouting) delete this.speakerOverrides[chat.id];
    return turn;
  }

  /** Speaker attribution for the request pipeline (group scenes only). */
  attribution(chat: ChatSession | null, speakerId?: string | null): RoleplayAttribution | undefined {
    if (!isRoleplay(chat)) return undefined;
    const ids = this.castIds(chat);
    const names = new Map<string, string>();
    for (const id of ids) {
      const card = charactersStore.getById(id);
      if (card?.name) names.set(id, card.name);
    }
    const speaker = charactersStore.getById(speakerId ?? this.speakerId(chat));
    return {
      names,
      userName: charactersStore.getPersonaById(chat.personaId)?.name || this.host.userName || 'User',
      group: ids.length > 1,
      speakerName: speaker?.name
    };
  }

  /**
   * Replies mimic the `Name:` attribution we send for group scenes. Strip it
   * at ingest unless the scene explicitly wants speaker labels.
   */
  private outputSanitizer(chat: ChatSession): ((content: string) => string) | undefined {
    const labels = !!chat.roleplay?.showSpeakerLabels || !!chat.roleplay?.allowMultiSpeaker;
    const hideChoices = !!chat.roleplay?.adventureChoices;

    const names = new Set<string>();
    if (!labels) {
      for (const card of this.cast(chat)) {
        if (card.name) names.add(card.name);
        if (card.nickname) names.add(card.nickname);
      }
      const persona = charactersStore.getPersonaById(chat.personaId) ?? charactersStore.defaultPersona;
      if (persona?.name) names.add(persona.name);
    }
    // Nothing to clean: no prefixes to strip and no choices block to lift.
    if (!hideChoices && !names.size) return undefined;

    return (content: string) => {
      const visible = hideChoices ? stripRoleplayChoiceBlock(content) : content;
      return names.size ? stripSpeakerPrefix(visible, names) : visible;
    };
  }

  // ── Auto mode ─────────────────────────────────────────────────────────

  /** Enable or pause auto mode for the current scene. */
  setAutoMode(enabled: boolean) {
    const chat = this.scene;
    if (!chat) return;
    if (enabled && (chat.roleplay?.replyOrder || 'list') === 'manual') {
      toastStore.info('Auto mode needs a speaker order. Switch off Manual first.', 4000);
      return;
    }
    this.patchSettings(chat, { autoMode: enabled });
    if (enabled) {
      this.autoTurns[chat.id] = 0;
      this.save();
      void this.speakNow();
    } else {
      this.stopAuto(chat.id);
      this.save();
    }
  }

  /** Typing pauses the auto chain without turning auto mode off. */
  pauseAuto() {
    const chat = this.host.currentChat;
    if (!chat) return;
    this.clearAutoTimer(chat.id);
    this.autoTurns[chat.id] = 0;
  }

  /** A user turn resets the chain; auto mode itself stays enabled. */
  resetAuto(chatId: string) {
    this.clearAutoTimer(chatId);
    this.autoTurns[chatId] = 0;
  }

  /**
   * After a settled turn: keep a group scene going while auto mode is on,
   * the limit is not reached, and the user is not typing. A failed or aborted
   * turn stops the chain instead of looping.
   */
  continueAuto(chatId: string, stopped = false) {
    const chat = this.host.findChat(chatId);
    if (!isRoleplay(chat)) return;
    const settings = chat.roleplay;
    const castCount = settings?.characterIds?.length || 0;
    if (stopped || !settings?.autoMode || castCount < 2 || (settings.replyOrder || 'list') === 'manual') {
      this.stopAuto(chatId);
      return;
    }
    const turns = (this.autoTurns[chatId] || 0) + 1;
    const limit = settings.autoModeMaxTurns ?? 4;
    if (turns > limit) {
      this.autoTurns[chatId] = 0;
      toastStore.info(`Auto mode paused after ${limit} turns.`, 4000);
      return;
    }
    this.autoTurns[chatId] = turns;
    this.clearAutoTimer(chatId);
    const delay = Math.min(20_000, Math.max(1_000, Number(settings.autoModeDelayMs) || 8000));
    this.autoDeadlines = { ...this.autoDeadlines, [chatId]: Date.now() + delay };
    this.autoTimers[chatId] = setTimeout(() => {
      delete this.autoTimers[chatId];
      this.clearAutoDeadline(chatId);
      // Typing interrupts the chain; so does another run taking the chat.
      if (this.host.currentChatId !== chatId || this.host.composer.trim() || this.host.currentChatGenerating) return;
      void this.speakNow();
    }, delay);
  }

  /** Stop auto mode for a scene and forget its turn count. */
  private stopAuto(chatId: string) {
    this.clearAutoTimer(chatId);
    delete this.autoTurns[chatId];
  }

  private clearAutoTimer(chatId: string) {
    const timer = this.autoTimers[chatId];
    if (timer) {
      clearTimeout(timer);
      delete this.autoTimers[chatId];
    }
    this.clearAutoDeadline(chatId);
  }

  private clearAutoDeadline(chatId: string) {
    if (!(chatId in this.autoDeadlines)) return;
    const next = { ...this.autoDeadlines };
    delete next[chatId];
    this.autoDeadlines = next;
  }

  // ── Scene journal ─────────────────────────────────────────────────────

  /** Keep something — a prop, a note, a lead, a bond. */
  addJournalEntry(entry: {
    kind: RoleplayJournalEntry['kind'];
    title: string;
    body: string;
    messageId?: string | null;
    pinned?: boolean;
  }) {
    const chat = this.scene;
    if (!chat) return;
    const journal = [...(chat.roleplay?.journal || [])];
    const messageId = entry.messageId ?? null;
    // Re-keeping from the viewer must not duplicate the entry.
    const duplicate = journal.some(
      (item) => item.kind === entry.kind && item.title === entry.title && (item.messageId ?? null) === messageId
    );
    if (duplicate) return;

    journal.push({
      id: createId('journal'),
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      pinned: !!entry.pinned,
      messageId,
      createdAt: Date.now()
    });
    this.patchSettings(chat, { journal: journal.slice(-MAX_JOURNAL_ENTRIES) });
    this.save();
  }

  removeJournalEntry(entryId: string) {
    this.patchJournal((journal) => journal.filter((entry) => entry.id !== entryId));
  }

  pinJournalEntry(entryId: string, pinned: boolean) {
    this.patchJournal((journal) => journal.map((entry) => (entry.id === entryId ? { ...entry, pinned } : entry)));
  }

  private patchJournal(patch: (journal: RoleplayJournalEntry[]) => RoleplayJournalEntry[]) {
    const chat = this.scene;
    if (!chat) return;
    this.patchSettings(chat, { journal: patch(chat.roleplay?.journal || []) });
    this.save();
  }

  // ── Prompt ────────────────────────────────────────────────────────────

  /** The two names that macros and story turns resolve against. */
  private names(chat: ChatSession): { char: string; user: string } {
    const speaker = charactersStore.getById(this.speakerId(chat)) || charactersStore.getById(chat.characterId);
    const persona = charactersStore.getPersonaById(chat.personaId) ?? charactersStore.defaultPersona;
    return {
      char: speaker?.name?.trim() || 'the character',
      user: persona?.name?.trim() || this.host.userName?.trim() || 'User'
    };
  }

  /**
   * Roleplay sessions never receive the assistant system prompt: character
   * card, persona, lorebook and author's note compose the whole instruction
   * block (see services/roleplay-prompts).
   */
  private promptParts(chat: ChatSession | null, speakerId?: string | null): {
    systemPrompt: string;
    loreEntries: LorebookEntry[];
    speaker: CharacterCard | null;
    sampling: RoleplaySampling;
    stop: string[];
  } {
    const primary = charactersStore.getById(chat?.characterId);
    const characters = chat ? this.cast(chat) : [];
    if (!characters.length && primary) characters.push(primary);

    const persona = charactersStore.getPersonaById(chat?.personaId) ?? charactersStore.defaultPersona;
    const world = worldsStore.getById(chat?.worldId);

    const scanDepth = Math.max(1, primary?.book?.scanDepth || 0, world?.book?.scanDepth || 0) || 4;
    const scanText = (chat?.messages || [])
      .slice(-scanDepth)
      .map((message) => message.content || '')
      .join('\n');
    // World canon first, then each cast member's own book; one shared budget.
    const loreEntries = resolveLorebooks(
      [
        { book: world?.book, source: 'world' },
        ...characters.map((character) => ({
          book: character.book,
          source: 'character' as const,
          characterId: character.id
        }))
      ],
      scanText
    );

    const speaker = charactersStore.getById(speakerId ?? this.speakerId(chat)) || primary;
    const systemPrompt = composeRoleplayPrompt({
      characters,
      speaker,
      persona,
      userName: this.host.userName,
      loreEntries,
      authorNote: chat?.roleplay?.authorNote,
      group: characters.length > 1,
      allowMultiSpeaker: !!chat?.roleplay?.allowMultiSpeaker,
      adventureChoices: !!chat?.roleplay?.adventureChoices,
      props: !!chat?.roleplay?.props,
      worldName: world?.name,
      worldOverview: world?.overview,
      worldScenario: world?.scenario,
      contentRating: chat?.roleplay?.contentRating
    });

    const sampling = resolveRoleplaySampling({
      speaker: speaker || null,
      chatSettings: chat?.roleplay,
      worldSettings: world?.settings
    });

    /*
     * Stop strings end a reply at the first line that is not its own — the only
     * real defence against the model writing the user's turn. The name has to
     * match the one macro substitution put in the prompt, so the resolution
     * below mirrors `buildRoleplaySystemPrompt` exactly.
     */
    const stop = buildRoleplayStopStrings({
      userName: persona?.name?.trim() || this.host.userName?.trim() || 'User',
      speakerName: speaker?.name,
      castNames: characters.map((card) => card.name),
      allowMultiSpeaker: !!chat?.roleplay?.allowMultiSpeaker
    });

    return { systemPrompt, loreEntries, speaker: speaker || null, sampling, stop };
  }

  /** The composed system prompt for a scene reply. */
  systemPrompt(chat: ChatSession | null, speakerId?: string | null): string {
    return this.promptParts(chat, speakerId).systemPrompt;
  }

  /**
   * What a roleplay turn sends, for the prompt inspector: the composed system
   * prompt, the lore entries that fired, and the speaker.
   */
  previewPrompt(messageId?: string | null) {
    const chat = this.scene;
    if (!chat) return { systemPrompt: '', loreEntries: [] as LorebookEntry[], speaker: null as CharacterCard | null };
    const messageSpeakerId = messageId
      ? chat.messages.find((message) => message.id === messageId)?.speakerId || null
      : null;
    return this.promptParts(chat, messageSpeakerId);
  }

  // ── Starting a scene ──────────────────────────────────────────────────

  /**
   * Start a roleplay scene.
   *
   * A scene is a roleplay chat bound to a cast (the first card is the primary
   * speaker) and optionally to a world. It is seeded with an opening turn:
   * either the world's chosen starter (narrator) or the primary's greeting.
   */
  startScene(options: {
    characters: CharacterCard[];
    world?: RoleplayWorld | null;
    personaId?: string | null;
    openingSource?: 'greeting' | 'starter' | 'none';
    openingIndex?: number;
    settings?: Partial<RoleplaySettings>;
  }) {
    const cast = options.characters.filter(Boolean);
    const primary = cast[0];
    if (!primary) return this.host.currentChat;

    // Picking a scene from the library must not leave the empty "New roleplay"
    // chat behind: bind the current empty roleplay chat instead.
    const current = this.scene;
    const reusable = !!current && !current.characterId && current.messages.length === 0;
    const created = reusable && current ? current : this.host.createChat('roleplay');
    // createChat returns the raw object; `$state` holds a proxy. Identity and
    // greeting fields must be written through the state view or they never
    // reach the send path (and never persist).
    const chat = this.host.findChat(created.id) || created;
    const world = options.world || null;
    const group = cast.length > 1;
    const openingSource = options.openingSource || 'greeting';
    const openings = openingSource === 'starter'
      ? (world?.starters || []).filter((entry) => entry.trim())
      : openingSource === 'greeting'
        ? greetingsFor(primary, { group })
        : [];
    const openingIndex = openings.length
      ? Math.max(0, Math.min(options.openingIndex ?? 0, openings.length - 1))
      : 0;
    const worldSettings = world?.settings || {};

    chat.characterId = primary.id;
    chat.worldId = world?.id ?? null;
    chat.personaId = options.personaId ?? null;
    chat.greetingIndex = openingIndex;
    chat.roleplay = {
      characterIds: cast.map((card) => card.id),
      replyOrder: worldSettings.replyOrder ?? 'list',
      autoMode: worldSettings.autoMode ?? false,
      autoModeMaxTurns: worldSettings.autoModeMaxTurns ?? 4,
      autoModeDelayMs: worldSettings.autoModeDelayMs ?? 8000,
      adventureChoices: worldSettings.adventureChoices ?? false,
      showSpeakerLabels: worldSettings.showSpeakerLabels ?? false,
      allowMultiSpeaker: worldSettings.allowMultiSpeaker ?? false,
      temperature: worldSettings.temperature ?? null,
      topP: worldSettings.topP ?? null,
      maxTokens: worldSettings.maxTokens ?? null,
      authorNote: worldSettings.authorNote ?? '',
      contentRating: worldSettings.contentRating ?? 'sfw',
      mutedIds: [],
      ...(options.settings || {})
    };
    chat.title = world?.name || (group ? `${primary.name} +${cast.length - 1}` : primary.name) || chat.title;

    const opening = openings[openingIndex];
    if (opening) {
      this.host.appendMessageToChat(chat.id, {
        id: createId('msg'),
        role: 'assistant',
        content: opening,
        createdAt: Date.now(),
        done: true,
        status: 'idle',
        // A world starter is narration, not the primary's line.
        model: openingSource === 'starter' ? undefined : primary.name || undefined,
        speakerId: openingSource === 'starter' ? null : primary.id,
        versions: [],
        activeVersion: 0,
        mode: 'chat'
      });
    }

    this.save();
    return chat;
  }

  /** Start a 1:1 scene with one character: the quick path from the gallery. */
  startSolo(character: CharacterCard, options: { personaId?: string | null; greetingIndex?: number } = {}) {
    return this.startScene({
      characters: [character],
      personaId: options.personaId ?? null,
      openingSource: 'greeting',
      openingIndex: options.greetingIndex ?? 0
    }) as ChatSession;
  }

  /** Replace the opening turn with another greeting from the same character. */
  setGreeting(character: CharacterCard, index: number) {
    const chat = this.scene;
    if (!chat) return;
    const group = (chat.roleplay?.characterIds?.length || 0) > 1;
    const greeting = greetingsFor(character, { group })[index];
    if (!greeting) return;

    chat.greetingIndex = index;
    const first = chat.messages[0];
    if (first && first.role === 'assistant') {
      first.content = greeting;
      first.speakerId = character.id;
    } else {
      chat.messages.unshift({
        id: createId('msg'),
        role: 'assistant',
        content: greeting,
        createdAt: Date.now(),
        done: true,
        status: 'idle',
        model: character.name || undefined,
        speakerId: character.id,
        versions: [],
        activeVersion: 0,
        mode: 'chat'
      });
    }
    this.save();
  }
}

export const roleplayStore = new RoleplayStore();
