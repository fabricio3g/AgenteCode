/**
 * One roleplay generation, from request to stored reply.
 *
 * A turn carries everything a character reply needs beyond the system
 * prompt — speaker attribution, sampling, stop strings, a queued story turn —
 * and knows how to clean the model's output: strip the echoed `Name:` prefix,
 * lift adventure choices and handed props into their own fields, and trim a
 * stop string that leaked past a dying stream.
 *
 * Non-roleplay chats get `PASSTHROUGH_TURN`, so the send path can apply a
 * turn unconditionally.
 */

import type { ChatMessage, RoleplayTurnSnapshot } from '$lib/types/chat';
import type { RequestMessage } from '$lib/services/chat-api';
import type { RoleplaySampling } from '$lib/services/roleplay-prompts';
import {
  appendRoleplayNudge,
  appendRoleplayStoryTurn,
  type RoleplayAttribution
} from '$lib/stores/app-message-pipeline';
import { stripTrailingPartialStop } from './roleplay-output';
import { extractRoleplayChoices } from './roleplay-choices';
import { extractRoleplayProps } from './roleplay-props';
import type { StoryTurn } from './roleplay-twists';
import { extractScene, parseContributions, stripSceneBlock } from './roleplay-scene';

export interface RoleplayTurn {
  /** Whose reply this is; stamped on the assistant message. */
  speakerId: string | null;
  attribution?: RoleplayAttribution;
  sampling: RoleplaySampling;
  stop: string[];
  snapshot?: RoleplayTurnSnapshot;
  /** Live display cleaner for streamed text; undefined when nothing to clean. */
  sanitize?: (content: string) => string;
  /** Add the story turn and the group speaker nudge to the outbound request. */
  decorate(messages: RequestMessage[]): RequestMessage[];
  /** Keep the raw stream: the only faithful source for choices and props. */
  record(chunk: string): void;
  /** Settle the stored reply from the final content. */
  finalize(target: Pick<ChatMessage, 'content' | 'choices' | 'props' | 'storyTurn' | 'metadata'>): void;
}

export function createRoleplayTurn(parts: {
  speakerId: string | null;
  attribution?: RoleplayAttribution;
  sampling: RoleplaySampling;
  stop: string[];
  sanitize?: (content: string) => string;
  choices: boolean;
  storyTurn?: StoryTurn;
  snapshot?: RoleplayTurnSnapshot;
}): RoleplayTurn {
  let raw = '';
  const { sanitize, stop, storyTurn } = parts;
  return {
    speakerId: parts.speakerId,
    attribution: parts.attribution,
    sampling: parts.sampling,
    stop,
    snapshot: parts.snapshot,
    sanitize,
    decorate: (messages) => appendRoleplayNudge(
      appendRoleplayStoryTurn(messages, [storyTurn?.instruction, parts.snapshot?.instruction].filter(Boolean).join('\n\n')),
      parts.attribution
    ),
    record(chunk) {
      if (stop.length || parts.snapshot) raw += chunk;
    },
    finalize(target) {
      if (!sanitize && !stop.length && !parts.snapshot) return;
      const source = raw || target.content;
      const parsed = parts.choices ? extractRoleplayChoices(source) : { text: source, choices: [] as string[] };
      if (parsed.choices.length) target.choices = parsed.choices;
      const handed = extractRoleplayProps(parsed.text);
      if (handed.props.length) target.props = handed.props;
      const trimmed = stripTrailingPartialStop(handed.text, stop);
      target.content = stripSceneBlock(sanitize ? sanitize(trimmed) : trimmed);
      if (parts.snapshot) {
        target.choices = parsed.choices.slice(0, parts.snapshot.settings.choiceMax ?? 4);
        target.props = parts.snapshot.settings.props ? handed.props : [];
        const snapshot = JSON.parse(JSON.stringify(parts.snapshot)) as RoleplayTurnSnapshot;
        snapshot.settled = true;
        try {
          const block = /\[scene\]\s*([\s\S]*?)\s*\[\/scene\]/i.exec(source);
          snapshot.outcomeApplied = !!snapshot.outcome && !!block && JSON.parse(block[1]).outcomeApplied === true;
        } catch { snapshot.outcomeApplied = false; }
        snapshot.sceneAfter = extractScene(source, snapshot, [...(parts.attribution?.names.keys() ?? [])].filter((id) => !id.startsWith('npc-')));
        const names = new Map(parts.attribution?.names);
        for (const npc of snapshot.sceneAfter.npcs) names.set(npc.id, npc.name);
        snapshot.contributions = parseContributions(target.content, names, parts.speakerId);
        snapshot.choices = target.choices;
        snapshot.props = target.props;
        target.metadata = { ...target.metadata, roleplay: snapshot };
      }
      if (storyTurn) {
        target.storyTurn = {
          label: storyTurn.label,
          ...(storyTurn.kind ? { kind: storyTurn.kind } : {}),
          ...(storyTurn.intensity ? { intensity: storyTurn.intensity } : {})
        };
      }
      if (parts.snapshot && target.metadata?.roleplay) {
        target.storyTurn = storyTurn ? target.storyTurn : parts.snapshot.storyTurn;
        target.metadata.roleplay.storyTurn = target.storyTurn;
      }
    }
  };
}

/** The turn for chats outside the roleplay space: changes nothing. */
export const PASSTHROUGH_TURN: RoleplayTurn = createRoleplayTurn({
  speakerId: null,
  sampling: {},
  stop: [],
  choices: false
});
