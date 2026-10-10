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
  PromptTrim,
  RoleplayJournalEntry,
  RoleplayRecall,
  RoleplaySettings,
  RoleplaySceneState,
  RoleplayTurnSnapshot,
  RoleplayWorld
} from '$lib/types/chat';
import type { RoleplayAttribution } from '$lib/stores/app-message-pipeline';
import {
  buildRoleplayPromptParts,
  resolveLorebooks,
  resolveRoleplaySampling,
  type RoleplayPromptParts,
  type RoleplaySampling
} from '$lib/services/roleplay-prompts';
import { resolveMacros, type MacroContext } from '$lib/services/roleplay-macros';
import { getMessageRequestContent } from '$lib/stores/app-store-helpers';
import { toastStore } from '$lib/stores/toast.svelte';
import { get } from 'svelte/store';
import { t } from 'svelte-i18n';
import { createId } from '$lib/utils/id';
import { charactersStore, emptyCharacter, greetingsFor } from './characters.svelte';
import { worldsStore } from './worlds.svelte';
import { selectNextSpeaker, selectTurnParticipants } from './group-turn';
import { buildRoleplayStopStrings, stripSpeakerPrefix } from './roleplay-output';
import { stripRoleplayChoiceBlock } from './roleplay-choices';
import { makeSilenceTurn, makeTwistTurn, pickTwist, type StoryTurn } from './roleplay-twists';
import { createRoleplayTurn, PASSTHROUGH_TURN, type RoleplayTurn } from './roleplay-turn';
import { ensembleEnabled, resolveRoleplaySettings, sceneOverrides, sceneState } from './roleplay-settings';
import { copyScene, decideTurn, sceneForChat, seededRandom, stripSceneBlock, turnSnapshot, restrictContributions } from './roleplay-scene';
import { roleplayPreferences } from './roleplay-presets.svelte';
import { cleanDraft, impersonationMessages, summaryDue, summaryMessages, transcript, unsummarized } from './roleplay-steer';
import type { RequestMessage } from '$lib/services/chat/types';

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
  /** One non-streamed completion on the active model; the reply text. */
  completeText(messages: RequestMessage[], options?: { maxTokens?: number }): Promise<string>;
  /** How full the current context is, 0–1. */
  readonly contextRatio: number;
  /** The active model runs locally: side calls are rare there, so they wait for a full context. */
  readonly localBackend: boolean;
}

/** Completion caps for the side calls, in tokens. */
const IMPERSONATE_MAX_TOKENS = 220;

/** The journal rides on the chat's roleplay JSON, so it stays bounded. */
const MAX_JOURNAL_ENTRIES = 200;

/** What one pass of macro resolution reads from: built once, so a history resolves in linear time. */
interface MacroScene {
  chat: ChatSession;
  messages: ChatMessage[];
  /** {{user}} for this pass: the turn's persona, else the chat's active one. */
  user: string;
  /** {{char}} for a message whose speaker is unknown. */
  fallback: string;
  /** Cast names in roster order, for {{group}}. */
  roster: string[];
}

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
  /** A draft of your next line is being written. */
  impersonating = $state(false);
  /** Chats whose story summary is being updated. */
  summarizing = $state<Record<string, boolean>>({});

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

  // ── Steering and memory ───────────────────────────────────────────────

  /** How a turn is labelled in a transcript: your persona, the speaker, or the narrator. */
  private transcriptName(chat: ChatSession, message: ChatMessage): string {
    if (message.role === 'user') return charactersStore.getPersonaById(chat.personaId)?.name || this.host.userName || 'User';
    return this.cardForId(chat, message.speakerId)?.name || 'Narrator';
  }

  /** Draft your next line in your persona's voice and put it in the composer to edit. */
  async impersonate() {
    const chat = this.scene;
    if (!chat || this.impersonating || this.host.currentChatGenerating) return;
    const persona = charactersStore.getPersonaById(chat.personaId);
    const userName = persona?.name || this.host.userName || 'User';
    this.impersonating = true;
    try {
      const draft = await this.host.completeText(impersonationMessages({
        userName,
        persona: resolveMacros(persona?.description ?? '', this.chatScope(chat, userName)),
        characters: this.cast(chat).map((card) => card.name),
        transcript: transcript(this.resolveHistory(chat, chat.messages, { user: userName }), (message) => this.transcriptName(chat, message))
      }), { maxTokens: IMPERSONATE_MAX_TOKENS });
      const line = cleanDraft(draft, userName);
      if (line && this.host.currentChatId === chat.id) this.host.composer = line;
    } catch (cause) {
      toastStore.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      this.impersonating = false;
    }
  }

  /** Fold the turns since the last summary into the story so far. */
  async summarize(chatId: string) {
    const chat = this.host.findChat(chatId);
    if (!isRoleplay(chat) || this.summarizing[chatId]) return;
    const previous = chat.roleplay?.storySummary;
    const turns = unsummarized(this.resolveHistory(chat), previous);
    if (!turns.length) return;
    this.summarizing = { ...this.summarizing, [chatId]: true };
    try {
      const words = Math.max(60, Math.round((this.settings(chat).memoryBudget ?? 800) * 0.5));
      const text = (await this.host.completeText(summaryMessages({
        previous: previous?.text ? resolveMacros(previous.text, this.chatScope(chat)) : undefined,
        transcript: transcript(turns, (message) => this.transcriptName(chat, message)),
        words
      }), { maxTokens: Math.min(1500, words * 2) })).trim();
      if (text) this.patchSettings(chat, { storySummary: { text, throughId: turns.at(-1)!.id, updatedAt: Date.now() } });
    } catch {
      // Best effort: the next turn tries again.
    } finally {
      const { [chatId]: _done, ...rest } = this.summarizing;
      this.summarizing = rest;
    }
  }

  /** Edit the story so far by hand; it then continues from there. */
  setSummary(text: string) {
    const chat = this.scene;
    if (!chat) return;
    this.patchSettings(chat, { storySummary: text.trim() ? { text: text.trim(), throughId: chat.roleplay?.storySummary?.throughId ?? chat.messages.at(-1)?.id ?? null, updatedAt: Date.now() } : null });
  }

  /** After a reply settles: update the summary when it's due. */
  afterTurn(chatId: string, failed = false) {
    const chat = this.host.findChat(chatId);
    if (failed || !isRoleplay(chat)) return;
    const settings = this.settings(chat);
    // Local: a side call evicts the chat's cached prompt, so the summary waits until the window is nearly full (the trim is coming anyway).
    const due = this.host.localBackend
      ? summaryDue(chat.messages, chat.roleplay?.storySummary, settings.summaryEvery ?? 8, this.host.contextRatio, { onlyWhenFull: true })
      : summaryDue(chat.messages, chat.roleplay?.storySummary, settings.summaryEvery ?? 8, this.host.contextRatio);
    if (settings.memoryEnabled && due) void this.summarize(chatId);
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

  settings(chat: ChatSession | null = this.scene): RoleplaySettings {
    return resolveRoleplaySettings(this.inherited(chat), chat?.roleplay);
  }

  /** What a scene inherits before its own overrides: your defaults, then the world's. */
  inherited(chat: ChatSession | null = this.scene): RoleplaySettings {
    roleplayPreferences.load();
    return resolveRoleplaySettings(roleplayPreferences.defaults, worldsStore.getById(chat?.worldId)?.settings);
  }

  room(chat: ChatSession | null = this.scene): RoleplaySceneState {
    return chat ? sceneForChat(chat) : { location: '', presentIds: [], npcs: [], facts: [], goals: [], relationships: [] };
  }

  private presentCast(chat: ChatSession): CharacterCard[] {
    const room = this.room(chat);
    return [...this.cast(chat).filter((card) => room.presentIds.includes(card.id)), ...room.npcs.map((npc) => emptyCharacter({ id: npc.id, name: npc.name, description: npc.description }))];
  }

  private cardForId(chat: ChatSession | null, id: string | null | undefined): CharacterCard | null {
    const card = charactersStore.getById(id);
    if (card || !chat) return card;
    const npc = this.room(chat).npcs.find((entry) => entry.id === id);
    return npc ? emptyCharacter({ id: npc.id, name: npc.name, description: npc.description }) : null;
  }

  setScene(scene: RoleplaySceneState) {
    const chat = this.scene;
    if (!chat || this.host.currentChatGenerating) return;
    this.patchSettings(chat, { sceneOrigin: chat.roleplay?.sceneOrigin ?? chat.roleplay?.scene ?? this.room(chat), scene: copyScene(scene), sceneAnchorId: chat.messages.at(-1)?.id });
    this.save();
  }

  setSettings(settings: Partial<RoleplaySettings>) {
    const chat = this.scene;
    if (!chat) return;
    // Options are saved as overrides; the room, journal and cast stay as they
    // are now, even if they changed while the settings were open.
    chat.roleplay = { ...sceneState(chat.roleplay), ...sceneOverrides(settings, this.inherited(chat)) } as RoleplaySettings;
    if (settings.autoMode === false) this.stopAuto(chat.id);
    this.save();
  }

  /**
   * Who speaks next: a forced speaker wins, otherwise the scene's reply order
   * decides. 1:1 scenes always answer as the character; manual order answers
   * as the primary on a plain send (the user force-talks for anyone else).
   */
  private routeSpeaker(chat: ChatSession, messages: ChatMessage[] = chat.messages): string | null {
    const cast = this.presentCast(chat).filter((card) => !chat.roleplay?.mutedIds?.includes(card.id));
    if (!cast.length) return null;
    if (cast.length < 2) return cast[0].id;
    const forced = this.speakerOverrides[chat.id];
    if (forced && cast.some((card) => card.id === forced)) return forced;
    const strategy = this.settings(chat).replyOrder || 'natural';
    if (strategy === 'manual') return cast[0].id;
    return selectNextSpeaker({
      strategy,
      cast,
      // Mentions are read from the text the viewer sees, so {{char}} routes too.
      messages: this.resolveHistory(chat, messages),
      mutedIds: chat.roleplay?.mutedIds || [],
      allowSelfReplies: false,
      // Preview and send share a stable routing roll for this history boundary.
      random: seededRandom(chat.messages.reduce((hash, message) => [...message.id].reduce((value, char) => Math.imul(value, 31) + char.charCodeAt(0), hash), 1))
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
    return chat ? this.cardForId(chat, this.routeSpeaker(chat)) : null;
  }

  /** Replace the scene's cast mid-chat (add, remove, reorder). */
  setCast(characterIds: string[]) {
    const chat = this.scene;
    if (!chat) return;
    const cast = [...new Set(characterIds)].filter((id) => !!charactersStore.getById(id));
    if (!cast.length) return;
    const muted = (chat.roleplay?.mutedIds || []).filter((id) => cast.includes(id));
    const room = this.room(chat);
    room.presentIds = [...room.presentIds.filter((id) => cast.includes(id)), ...cast.filter((id) => !this.castIds(chat).includes(id))];
    this.patchSettings(chat, { characterIds: cast, mutedIds: muted, sceneOrigin: chat.roleplay?.sceneOrigin ?? chat.roleplay?.scene ?? this.room(chat), scene: room, sceneAnchorId: chat.messages.at(-1)?.id });
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

  /** Suggestions are editable drafts; only the user submits a turn. */
  async sendChoice(choice: string) {
    if (!this.scene) return;
    const text = String(choice || '').trim();
    if (!text) return;
    this.host.composer = text;
    this.pauseAuto();
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('focus-composer'));
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
    const expiry = this.settings(chat).choiceExpiry;
    if (expiry === 'pause' || this.host.composer.trim()) return;
    if (expiry === 'event') {
      await this.throwTwist();
      return;
    }
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
    const cast = [...this.cast(chat), ...this.presentCast(chat).filter((card) => card.id.startsWith('npc-'))];
    if (!cast.length) {
      toastStore.info(get(t)('roleplay.route.noCharacter'), 4000);
      return false;
    }
    const speaker = this.routeSpeaker(chat, messages);
    if (!speaker) {
      toastStore.info(get(t)('roleplay.route.noneAvailable'), 4000);
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
  prepareTurn(chat: ChatSession, options: { speakerId?: string | null; consumeRouting?: boolean; snapshot?: RoleplayTurnSnapshot; historyEnd?: number; reroll?: boolean } = {}): RoleplayTurn {
    if (!isRoleplay(chat)) return PASSTHROUGH_TURN;
    let speakerId = options.speakerId ?? this.speakerId(chat);
    const history = options.historyEnd == null ? chat : { ...chat, messages: chat.messages.slice(0, options.historyEnd) };
    const settings = options.snapshot?.settings ?? this.settings(chat);
    const selected = options.snapshot && !options.reroll ? options.snapshot : decideTurn(history, settings,
      options.snapshot?.sceneBefore ?? sceneForChat(history), Math.floor(Math.random() * 4294967296));
    const snapshot: RoleplayTurnSnapshot = { ...selected, settled: false, sceneAfter: copyScene(selected.sceneBefore), contributions: [], choices: [], props: [] };
    if (!snapshot.participantIds) {
      const available = [...this.cast(history).filter((card) => snapshot.sceneBefore.presentIds.includes(card.id)),
        ...snapshot.sceneBefore.npcs.map((npc) => emptyCharacter({ id: npc.id, name: npc.name, description: npc.description }))]
        .filter((card) => !settings.mutedIds?.includes(card.id));
      const latest = [...history.messages].reverse().find((message) => message.role === 'user');
      const latestText = latest ? this.resolveMessage(history, latest).content : '';
      snapshot.participantIds = selectTurnParticipants(latestText, available, speakerId, ensembleEnabled(settings));
    }
    speakerId = snapshot.participantIds[0] ?? speakerId;
    if (!snapshot.persona) {
      const persona = charactersStore.getPersonaById(chat.personaId) ?? charactersStore.defaultPersona;
      snapshot.persona = { id: persona?.id ?? null, name: persona?.name || this.host.userName || 'User', avatar: persona?.avatar };
    }
    const parts = this.promptParts(history, speakerId, snapshot);
    snapshot.recall = parts.recall;
    const turn = createRoleplayTurn({
      speakerId,
      attribution: this.attribution(history, speakerId, snapshot),
      sampling: parts.sampling,
      stop: parts.stop,
      prompt: parts.build,
      sanitize: this.outputSanitizer(chat, settings, snapshot.sceneBefore, snapshot.participantIds, speakerId),
      choices: !!settings.adventureChoices,
      storyTurn: this.takeStoryTurn(chat.id),
      snapshot
    });
    if (options.consumeRouting) delete this.speakerOverrides[chat.id];
    return turn;
  }

  /** Speaker attribution for the request pipeline (group scenes only). */
  attribution(chat: ChatSession | null, speakerId?: string | null, snapshot?: RoleplayTurnSnapshot): RoleplayAttribution | undefined {
    if (!isRoleplay(chat)) return undefined;
    const ids = snapshot?.settings.characterIds ?? this.castIds(chat);
    const names = new Map<string, string>();
    for (const id of ids) {
      const card = charactersStore.getById(id);
      if (card?.name) names.set(id, card.name);
    }
    const settings = snapshot?.settings ?? this.settings(chat);
    const room = snapshot?.sceneBefore ?? this.room(chat);
    for (const npc of room.npcs) names.set(npc.id, npc.name);
    const speaker = this.cardForId(chat, speakerId ?? this.speakerId(chat));
    return {
      names,
      userName: snapshot?.persona?.name || charactersStore.getPersonaById(chat.personaId)?.name || this.host.userName || 'User',
      group: ids.length + room.npcs.length > 1,
      speakerName: names.get(speakerId ?? this.speakerId(chat) ?? '') || speaker?.name,
      allowMultiSpeaker: snapshot?.participantIds ? snapshot.participantIds.length > 1 : ensembleEnabled(settings),
      maxExchangeLines: settings.maxExchangeLines,
      participantIds: snapshot?.participantIds,
      mode: settings.interactionMode
    };
  }

  /**
   * Replies mimic the `Name:` attribution we send for group scenes. Strip it
   * at ingest unless the scene explicitly wants speaker labels.
   */
  private outputSanitizer(chat: ChatSession, settings = this.settings(chat), room = this.room(chat), participantIds?: string[], speakerId?: string | null): ((content: string) => string) | undefined {
    const cast = this.cast({ ...chat, roleplay: { ...chat.roleplay, ...settings } });
    const labels = settings.interactionMode !== 'chat' || !!settings.showSpeakerLabels || (ensembleEnabled(settings) && cast.length + room.npcs.length > 1);
    const hideChoices = !!settings.adventureChoices;

    const names = new Set<string>();
    if (!labels) {
      for (const card of cast) {
        if (card.name) names.add(card.name);
        if (card.nickname) names.add(card.nickname);
      }
      for (const npc of room.npcs) names.add(npc.name);
      const persona = charactersStore.getPersonaById(chat.personaId) ?? charactersStore.defaultPersona;
      if (persona?.name) names.add(persona.name);
      // Replies are stored raw, so a label the model wrote as a macro is stripped too.
      names.add('{{char}}');
      names.add('{{user}}');
    }
    // Nothing to clean: no prefixes to strip and no choices block to lift.
    return (content: string) => {
      const sceneText = stripSceneBlock(content);
      const visible = hideChoices ? stripRoleplayChoiceBlock(sceneText) : sceneText;
      const restricted = participantIds ? restrictContributions(visible, new Map([...cast.map((card) => [card.id, card.name] as [string, string]), ...room.npcs.map((npc) => [npc.id, npc.name] as [string, string])]), participantIds, speakerId ?? null, settings) : visible;
      return names.size ? stripSpeakerPrefix(restricted, names) : restricted;
    };
  }

  // ── Auto mode ─────────────────────────────────────────────────────────

  /** Enable or pause auto mode for the current scene. */
  setAutoMode(enabled: boolean) {
    const chat = this.scene;
    if (!chat) return;
    if (enabled && this.settings(chat).replyOrder === 'manual') {
      toastStore.info(get(t)('roleplay.route.autoNeedsOrder'), 4000);
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
    const settings = this.settings(chat);
    const castCount = this.presentCast(chat).length;
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

  /** Pin a message's text as a key memory for this scene. The text is stored raw, so macros resolve as usual. */
  pinToMemory(text: string) {
    const body = text.trim();
    if (!body) return;
    // A title is a plain label: the markdown of the line it came from is dropped, the body keeps it.
    const firstLine = (body.split('\n').find((line) => line.trim())?.trim() || body).replace(/[*_`#>~]+/g, '').replace(/\s+/g, ' ').trim() || body;
    const title = firstLine.length > 60 ? `${firstLine.slice(0, 57).trimEnd()}…` : firstLine;
    this.addJournalEntry({ kind: 'note', title, body, pinned: true });
  }

  editJournalEntry(entryId: string, patch: { title?: string; body?: string }) {
    this.patchJournal((journal) => journal.map((entry) => (entry.id === entryId ? { ...entry, ...patch } : entry)));
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
    const speaker = this.cardForId(chat, this.speakerId(chat)) || charactersStore.getById(chat.characterId);
    const persona = charactersStore.getPersonaById(chat.personaId) ?? charactersStore.defaultPersona;
    return {
      char: speaker?.name?.trim() || 'the character',
      user: persona?.name?.trim() || this.host.userName?.trim() || 'User'
    };
  }

  // ── Macros ────────────────────────────────────────────────────────────
  // Stored text stays raw. These resolve it in the context it is read in; the
  // policy and the grammar live in services/roleplay-macros.

  /** The pieces one resolution pass reads from. Cheap: no history scan. */
  private macroScene(chat: ChatSession, messages: ChatMessage[] = chat.messages, user?: string): MacroScene {
    const current = this.names(chat);
    return {
      chat,
      messages,
      user: user?.trim() || current.user,
      fallback: current.char,
      roster: this.cast(chat).map((card) => card.name)
    };
  }

  /** A speaker's name: a card, else the scene NPC the turn that spoke it recorded, else the room. */
  private speakerName(chat: ChatSession, speakerId: string | null | undefined, near?: ChatMessage): string | undefined {
    if (!speakerId) return undefined;
    const card = charactersStore.getById(speakerId);
    if (card?.name) return card.name;
    const npc = near ? turnSnapshot(near)?.sceneAfter?.npcs?.find((entry) => entry.id === speakerId) : undefined;
    return npc?.name || this.cardForId(chat, speakerId)?.name || undefined;
  }

  /**
   * The line a user message is spoken to: the next reply that has a speaker.
   * Nothing answered yet (a turn being written) falls back to the routed speaker.
   */
  private answererOf(messages: ChatMessage[], index: number): ChatMessage | undefined {
    for (let next = index + 1; next < messages.length; next += 1) {
      const message = messages[next];
      if (message?.role === 'assistant' && message.speakerId) return message;
    }
    return undefined;
  }

  /** The context one stored message resolves in, without {{lastMessage}}. */
  private baseScope(scene: MacroScene, index: number): MacroContext {
    const message = scene.messages[index]!;
    const speaker = message.role === 'assistant' ? message : this.answererOf(scene.messages, index);
    const scope: MacroContext = {
      char: this.speakerName(scene.chat, speaker?.speakerId, speaker) ?? scene.fallback,
      user: scene.user,
      group: scene.roster,
      seed: message.id
    };
    if (Number.isFinite(message.createdAt)) scope.now = new Date(message.createdAt);
    return scope;
  }

  /** A stored message's text as the viewer reads it, for use as another message's {{lastMessage}}. */
  private readMessage(scene: MacroScene, index: number): string {
    const message = scene.messages[index];
    return message ? resolveMacros(getMessageRequestContent(message), this.baseScope(scene, index)) : '';
  }

  /** The full context one stored message resolves in: its base scope plus the message before it. */
  private messageScope(scene: MacroScene, index: number): MacroContext {
    return { ...this.baseScope(scene, index), lastMessage: index > 0 ? this.readMessage(scene, index - 1) : '' };
  }

  /** The context for text that belongs to the chat, not to one message: its start, its id, its speaker. */
  private chatScope(chat: ChatSession, user?: string): MacroContext {
    const scene = this.macroScene(chat, [], user);
    return {
      char: scene.fallback,
      user: scene.user,
      group: scene.roster,
      seed: chat.id,
      ...(Number.isFinite(chat.createdAt) ? { now: new Date(chat.createdAt) } : {})
    };
  }

  /** The chat's last finished message as the model reads it: the system prompt's {{lastMessage}}. */
  private lastFinishedText(chat: ChatSession, user: string): string {
    const scene = this.macroScene(chat, chat.messages, user);
    for (let index = chat.messages.length - 1; index >= 0; index -= 1) {
      const message = chat.messages[index]!;
      if (message.done === false || !getMessageRequestContent(message).trim()) continue;
      return this.readMessage(scene, index);
    }
    return '';
  }

  /**
   * A roleplay message's text as the viewer reads it: macros resolved against
   * that message. Text outside a message (a journal note, say) takes `seed` and
   * `at` instead. Non-roleplay text passes through untouched.
   */
  displayText(text: string, anchor: { messageId?: string | null; seed?: string; at?: number } = {}): string {
    const chat = this.host.currentChat;
    if (!text || !isRoleplay(chat)) return text;
    const index = anchor.messageId ? chat.messages.findIndex((message) => message.id === anchor.messageId) : -1;
    if (index >= 0) return resolveMacros(text, this.messageScope(this.macroScene(chat), index));
    return resolveMacros(text, {
      ...this.chatScope(chat),
      ...(anchor.seed !== undefined ? { seed: anchor.seed } : {}),
      ...(anchor.at !== undefined && Number.isFinite(anchor.at) ? { now: new Date(anchor.at) } : {})
    });
  }

  /**
   * The history as the model reads it: a copy of every message whose content
   * and versions are resolved in that message's context. Stored messages are
   * untouched. `user` pins {{user}} to a turn's persona, so the history matches
   * the prompt that was built with it.
   */
  resolveHistory(chat: ChatSession, messages: ChatMessage[] = chat.messages, options: { user?: string } = {}): ChatMessage[] {
    if (!isRoleplay(chat)) return messages;
    const scene = this.macroScene(chat, messages, options.user);
    return messages.map((message, index) => {
      const scope = this.messageScope(scene, index);
      const resolve = (text: string) => resolveMacros(text, scope);
      return {
        ...message,
        content: resolve(message.content),
        ...(message.versions ? { versions: message.versions.map((version) => ({ ...version, content: resolve(version.content) })) } : {})
      };
    });
  }

  /** One message as the model reads it, for flows that hold a message rather than the thread. */
  resolveMessage(chat: ChatSession, message: ChatMessage): ChatMessage {
    const messages = chat.messages.some((entry) => entry.id === message.id) ? chat.messages : [message];
    return this.resolveHistory(chat, messages).find((entry) => entry.id === message.id) ?? message;
  }

  /** A chat as it reads on screen, for export. Only roleplay chats change. */
  forExport(chat: ChatSession): ChatSession {
    return isRoleplay(chat) ? { ...chat, messages: this.resolveHistory(chat) } : chat;
  }

  /**
   * Text shown outside any chat: a card, a world, a persona, a scene about to
   * start. {{char}} is `char`; {{user}} is the given persona, else the default.
   */
  previewText(text: string, options: { char?: string; personaId?: string | null; group?: string[]; seed?: string } = {}): string {
    if (!text) return text;
    const persona = charactersStore.getPersonaById(options.personaId) ?? charactersStore.defaultPersona;
    return resolveMacros(text, {
      char: options.char?.trim() || 'the character',
      user: persona?.name?.trim() || this.host.userName?.trim() || 'User',
      group: options.group,
      seed: options.seed,
      now: new Date()
    });
  }

  /**
   * Roleplay sessions never receive the assistant system prompt: character
   * card, persona, lorebook and author's note compose the whole instruction
   * block (see services/roleplay-prompts).
   *
   * Everything the prompt reads is resolved here once. `build(trim)` then makes
   * the stable block and the volatile tail at a budget's trim level.
   */
  private promptParts(chat: ChatSession | null, speakerId?: string | null, snapshot?: RoleplayTurnSnapshot): {
    build: (trim?: PromptTrim) => RoleplayPromptParts;
    systemPrompt: string;
    loreEntries: LorebookEntry[];
    speaker: CharacterCard | null;
    sampling: RoleplaySampling;
    stop: string[];
    recall: RoleplayRecall;
  } {
    const primary = charactersStore.getById(chat?.characterId);
    const cast = chat ? this.cast(snapshot ? { ...chat, roleplay: { ...chat.roleplay, ...snapshot.settings } } : chat) : [];
    const characters = cast.length ? cast : primary ? [primary] : [];
    const personaCard = snapshot?.persona
      ? charactersStore.getPersonaById(snapshot.persona.id)
      : charactersStore.getPersonaById(chat?.personaId) ?? charactersStore.defaultPersona;
    const persona = personaCard && snapshot?.persona ? { ...personaCard, name: snapshot.persona.name } : personaCard;
    // The same {{user}} the prompt builder uses, so every macro in one request agrees.
    const user = snapshot?.persona?.name?.trim() || persona?.name?.trim() || this.host.userName?.trim() || 'User';
    const world = worldsStore.getById(chat?.worldId);
    const settings = snapshot?.settings ?? this.settings(chat);
    const room = snapshot?.sceneBefore ?? this.room(chat);
    // Scene NPCs are per-turn: they travel in the volatile tail, not the cast.
    const npcs = room.npcs.map((npc) => emptyCharacter({ id: npc.id, name: npc.name, description: npc.description }));
    const everyone = [...characters, ...npcs];
    const memoryLimit = (settings.memoryBudget ?? 800) * 4;
    const journal = (settings.journal ?? []).filter((entry) => entry.pinned && (!entry.messageId || chat?.messages.some((message) => message.id === entry.messageId)));
    const summary = chat?.roleplay?.storySummary?.text?.trim();
    const memory = this.memoryBlock(settings, summary, journal, room, memoryLimit);
    const sceneContext = [
      `Location: ${room.location || 'as established in conversation'}`,
      ...everyone.map((card) => `${card.id}: ${card.name} — ${room.presentIds.includes(card.id) || npcs.some((npc) => npc.id === card.id) ? settings.mutedIds?.includes(card.id) ? 'present, silent' : 'present' : 'absent'}`)
    ].join('\n');

    const scanDepth = Math.max(1, primary?.book?.scanDepth || 0, world?.book?.scanDepth || 0) || 4;
    // Keys match the text the viewer and the model see, so a key can name {{user}}.
    const scanned: ChatMessage[] = chat ? this.resolveHistory(chat, chat.messages, { user }) : [];
    const scanText = scanned
      .slice(-scanDepth)
      .map((message) => message.content || '')
      .join('\n');
    // World canon first, then each cast member's own book; one shared budget.
    const loreEntries = resolveLorebooks(
      [
        { book: world?.book, source: 'world' },
        ...everyone.map((character) => ({
          book: character.book,
          source: 'character' as const,
          characterId: character.id
        }))
      ],
      scanText
    );

    const speaker = everyone.find((card) => card.id === (speakerId ?? this.speakerId(chat))) || primary || null;
    const group = characters.length > 1 || npcs.length > 0;
    const base = {
      characters,
      // The scene's primary, never the turn's speaker: the stable block must not change when the speaker does.
      primary: primary ?? characters[0] ?? null,
      speaker,
      persona,
      userName: snapshot?.persona?.name || this.host.userName,
      loreEntries,
      authorNote: settings.authorNote,
      group,
      allowMultiSpeaker: snapshot?.participantIds ? snapshot.participantIds.length > 1 : ensembleEnabled(settings),
      participantIds: snapshot?.participantIds,
      adventureChoices: !!settings.adventureChoices,
      props: !!settings.props,
      worldName: world?.name,
      worldOverview: world?.overview,
      worldScenario: world?.scenario,
      contentRating: settings.contentRating,
      settings,
      npcs,
      sceneContext,
      memoryContext: memory.text,
      memoryUsed: { memories: memory.memories, journal: memory.journal },
      // Time and random draws hold for the whole chat: the prompt stays byte-stable across turns.
      macros: {
        now: chat && Number.isFinite(chat.createdAt) ? new Date(chat.createdAt) : undefined,
        seed: chat?.id,
        lastMessage: chat ? this.lastFinishedText(chat, user) : undefined
      }
    };
    const build = (trim: PromptTrim = {}) => buildRoleplayPromptParts({ ...base, trim });
    const whole = build();

    const sampling = resolveRoleplaySampling({
      speaker: speaker || null,
      chatSettings: settings,
      worldSettings: world?.settings
    });

    /*
     * Stop strings end a reply at the first line that is not its own — the only
     * real defence against the model writing the user's turn. The name has to
     * match the one macro substitution put in the prompt, so the resolution
     * below mirrors `buildRoleplaySystemPrompt` exactly.
     */
    const stop = buildRoleplayStopStrings({
      userName: snapshot?.persona?.name || persona?.name?.trim() || this.host.userName?.trim() || 'User',
      speakerName: speaker?.name,
      allowMultiSpeaker: false,
      castNames: everyone.filter((card) => snapshot?.participantIds && !snapshot.participantIds.includes(card.id)).map((card) => card.name)
    });

    // What this prompt drew on, for the "remembered" line under the reply. Read-only: the prompt builder is untouched.
    const recall: RoleplayRecall = {
      memories: settings.memoryEnabled ? journal.map((entry) => ({ id: entry.id, title: entry.title })) : [],
      lore: loreEntries.map((entry) => ({ id: entry.id, title: entry.comment?.trim() || entry.keys[0] || '' })),
      summary: !!settings.memoryEnabled && !!summary
    };

    return {
      build,
      systemPrompt: [whole.stable, whole.volatile].filter(Boolean).join('\n\n'),
      loreEntries,
      speaker: speaker || null,
      sampling,
      stop,
      recall
    };
  }

  /**
   * The story-so-far block: whole items in priority order (summary, pinned
   * journal, facts, goals, relationships), up to the memory budget. An item that
   * does not fit ends the block, so no memory is cut in half.
   */
  private memoryBlock(
    settings: RoleplaySettings,
    summary: string | undefined,
    journal: RoleplayJournalEntry[],
    room: RoleplaySceneState,
    limit: number
  ): { text: string; memories: string[]; journal: string[] } {
    const out = { text: '', memories: [] as string[], journal: [] as string[] };
    if (!settings.memoryEnabled) return out;
    const items: Array<{ id: string; text: string; kind: 'memory' | 'journal' }> = [
      ...(summary ? [{ id: 'summary', text: `Story so far: ${summary}`, kind: 'memory' as const }] : []),
      ...journal.map((entry) => ({ id: entry.id, text: `${entry.title}: ${entry.body}`, kind: 'journal' as const })),
      ...room.facts.map((fact, index) => ({ id: `fact:${index}`, text: fact, kind: 'memory' as const })),
      ...room.goals.map((goal, index) => ({ id: `goal:${index}`, text: `Goal: ${goal}`, kind: 'memory' as const })),
      ...room.relationships.map((relationship, index) => ({ id: `relationship:${index}`, text: relationship, kind: 'memory' as const }))
    ];
    const lines: string[] = [];
    let length = 0;
    for (const item of items) {
      const cost = (lines.length ? 1 : 0) + item.text.length;
      if (length + cost > limit) {
        // The first item alone over the budget is cut short rather than dropped.
        if (!lines.length && limit > 0) {
          lines.push(item.text.slice(0, limit));
          (item.kind === 'journal' ? out.journal : out.memories).push(item.id);
        }
        break;
      }
      lines.push(item.text);
      length += cost;
      (item.kind === 'journal' ? out.journal : out.memories).push(item.id);
    }
    out.text = lines.join('\n');
    return out;
  }

  /** The composed system prompt for a scene reply. */
  systemPrompt(chat: ChatSession | null, speakerId?: string | null, snapshot?: RoleplayTurnSnapshot): string {
    return this.promptParts(chat, speakerId, snapshot).systemPrompt;
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
    const message = messageId ? chat.messages.find((entry) => entry.id === messageId) : undefined;
    return this.promptParts(chat, messageSpeakerId, message ? turnSnapshot(message) : undefined);
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
    roleplayPreferences.load();
    chat.roleplay = {
      characterIds: cast.map((card) => card.id),
      mutedIds: [],
      scene: { location: '', presentIds: cast.map((card) => card.id), npcs: [], facts: [], goals: [], relationships: [] },
      ...sceneOverrides(options.settings || {}, resolveRoleplaySettings(roleplayPreferences.defaults, worldSettings))
    };
    chat.title = world?.name || (group ? `${primary.name} +${cast.length - 1}` : primary.name) || chat.title;
    roleplayPreferences.noteLastPersona(chat.personaId);

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
      personaId: options.personaId !== undefined ? options.personaId : roleplayPreferences.lastPersonaId(charactersStore.personas),
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
