/** Conversation IDs are unique across projects and remain stable on resume. */
export function conversationScope(chatId: string): string { return `chat:${chatId}`; }
export function isWorkspaceScope(scope: unknown): scope is string {
  return typeof scope === 'string' && scope.length > 0 && scope.length <= 512;
}
