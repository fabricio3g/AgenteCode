/** Playback visibility is transient; persisted chat always retains the full answer. */
class VoiceText {
  chatId = $state<string | null>(null);
  startedAt = $state(0);
  visible = $state<Record<string, string>>({});
  start(chatId: string | null) { this.chatId = chatId; this.startedAt = Date.now(); this.visible = {}; }
  buffer(messageId: string, initial = '') { if (!(messageId in this.visible)) this.visible[messageId] = initial; }
  reveal(messageId: string, text: string) { this.visible[messageId] = text; }
  finish() { this.chatId = null; this.visible = {}; }
}
export const voiceText = new VoiceText();
