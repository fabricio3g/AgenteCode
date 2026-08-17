import { getContext, setContext } from 'svelte';
import type {
  ChatContextMode,
  ChatMessage,
  MessageVersion,
  SearchMeta
} from '$lib/types/chat';

/**
 * Per-message context.
 *
 * Every child of a message needs the same handful of derived facts: which
 * version is active, what content that version resolves to, whether the message
 * is still streaming. Before this existed, the assistant body took eleven props
 * and relayed most of them again to each of its own children, so adding one fact
 * meant editing four files. Children now read what they need and nothing else.
 *
 * The value is an object of getters so it stays reactive across the context
 * boundary — `setContext` runs once at init, but each getter re-reads the
 * `$derived` it closes over.
 */
export interface MessageContextValue {
  readonly message: ChatMessage;
  readonly role: 'user' | 'assistant';
  readonly contextMode: ChatContextMode;
  readonly isStreaming: boolean;
  /** Content of the active version, sanitized for assistant messages. */
  readonly displayContent: string;
  readonly displayReasoning: string;
  readonly displayMetadata: MessageVersion['metadata'] | null;
  readonly displaySearchMeta: SearchMeta | null;
  /** Metadata for the footer: message-level fields overlaid with version-level. */
  readonly footerMetadata: MessageVersion['metadata'] | null;
  readonly activeVersionIndex: number;
  readonly versionCount: number;
  /** Keep the hover action bar pinned open (after a jump, or while a menu is up). */
  readonly actionsPinned: boolean;
}

const MESSAGE_CONTEXT_KEY = Symbol('thread-message');

export function createMessageContext(value: MessageContextValue): void {
  setContext(MESSAGE_CONTEXT_KEY, value);
}

export function useMessage(): MessageContextValue {
  const value = getContext<MessageContextValue | undefined>(MESSAGE_CONTEXT_KEY);
  if (!value) throw new Error('Message context missing: component used outside <Message>');
  return value;
}
