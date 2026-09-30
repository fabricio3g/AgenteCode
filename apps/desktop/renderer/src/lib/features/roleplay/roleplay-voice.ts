import type { AppConfig, CharacterCard, ChatMessage } from '$lib/types/chat';
import type { VoiceAssignment } from '$shared/speech';
import { parseContributions, stripSceneBlock, turnSnapshot } from './roleplay-scene';
import { stripSpeakerPrefix } from './roleplay-output';

export function voiceConfig(config: AppConfig, assignment?: VoiceAssignment | null): AppConfig {
  const tts = { ...config.tts };
  if (assignment?.backend) tts.backend_mode = assignment.backend;
  if (assignment?.provider) tts.api_provider = assignment.provider;
  const provider = tts.providers?.[tts.api_provider ?? ''];
  tts.voice = assignment?.voice || (tts.backend_mode === 'api' ? provider?.voice : tts.voice);
  tts.voice_model = assignment?.model || tts.voice_model;
  if (assignment?.model && provider && tts.api_provider) tts.providers = { ...tts.providers, [tts.api_provider]: { ...provider, model: assignment.model } };
  tts.speed = assignment?.speed ?? tts.speed;
  tts.language = assignment?.language || tts.language;
  return { ...config, tts };
}

/** One complete bubble for each character; narrator passages keep their own position. */
export function characterBubbles(text: string, names: Map<string, string>, speakerId: string | null) {
  const parts = parseContributions(stripSceneBlock(text), names, speakerId);
  const seen = new Map<string, typeof parts[number]>();
  return parts.flatMap((part) => {
    if (part.speakerId === null) return [part];
    const existing = seen.get(part.speakerId);
    if (existing) { existing.content += `\n\n${part.content}`; existing.addresseeIds = [...new Set([...existing.addresseeIds, ...part.addresseeIds])]; return []; }
    const bubble = { ...part };
    seen.set(part.speakerId, bubble);
    return [bubble];
  });
}

export function messageSpeechParts(message: ChatMessage, cards: CharacterCard[], config: AppConfig) {
  const snapshot = turnSnapshot(message);
  const content = message.versions?.[message.activeVersion ?? 0]?.content || message.content;
  const names = new Map(cards.map((card) => [card.id, card.name]));
  for (const npc of snapshot?.sceneAfter.npcs ?? []) names.set(npc.id, npc.name);
  return characterBubbles(content, names, message.speakerId ?? null).map((part, index) => {
    const card = cards.find((entry) => entry.id === part.speakerId);
    return { id: `${message.id}:voice:${part.speakerId ?? `narrator-${index}`}`, text: card ? stripSpeakerPrefix(part.content, [card.name, card.nickname ?? '', ...(card.aliases ?? [])]) : part.content,
      config: voiceConfig(config, part.speakerId === null ? config.tts?.narrator : card?.voice ?? (card?.voiceId ? { voice: card.voiceId } : undefined)) };
  });
}
