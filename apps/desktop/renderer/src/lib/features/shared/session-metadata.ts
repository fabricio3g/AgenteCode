import type { ChatSession } from '$lib/types/chat';
/** Only recorded models are described as used. The current selection is separate. */
export function usedModels(chat: ChatSession): string[] {
  const models = new Set<string>();
  for (const message of chat.messages) {
    if (message.metadata?.modelName?.trim()) models.add(message.metadata.modelName.trim());
    for (const child of message.metadata?.codeChildren ?? []) if (child.model?.trim()) models.add(child.model.trim());
    for (const step of message.agentSteps ?? []) if (step.model?.trim()) models.add(step.model.trim());
  }
  return [...models];
}
