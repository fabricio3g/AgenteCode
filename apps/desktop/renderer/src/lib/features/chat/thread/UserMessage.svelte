<svelte:options runes={true} />

<script lang="ts">
  import { CornerDownLeft, Copy, Pencil, Trash2 } from 'lucide-svelte';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { copy, say } from '$lib/copy';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import AttachmentDocumentsBlock from '$lib/features/chat/AttachmentDocumentsBlock.svelte';
  import { charactersStore } from '$lib/features/roleplay/characters.svelte';
  import MessageActionBar from './MessageActionBar.svelte';
  import { compactActions, type MessageAction } from './message-actions';
  import { useMessage } from './message-context';

  interface Props {
    hovering: boolean;
    onmenutoggle?: (open: boolean) => void;
  }

  let { hovering, onmenutoggle }: Props = $props();

  const ctx = useMessage();

  /**
   * "Quote a selection, then ask about it" messages are stored as a marker
   * comment, a blockquote, and the question. Split them so the quote renders as
   * a jump-back affordance instead of appearing inline in the user's bubble.
   */
  function splitSelectedTextQuestion(content: string) {
    const raw = (content || '').trim();
    const sourceMatch = raw.match(/^<!--\s*chatealm-selected-source:([^\s]+)\s*-->\n?/);
    const sourceMessageId = sourceMatch?.[1] || '';
    const normalized = sourceMatch ? raw.slice(sourceMatch[0].length).trim() : raw;
    if (!normalized.startsWith('> ')) return null;

    const separatorIndex = normalized.indexOf('\n\n');
    if (separatorIndex < 0) return null;

    const quoteBlock = normalized.slice(0, separatorIndex);
    const question = normalized.slice(separatorIndex + 2).trim();
    if (!question) return null;

    const quoteLines = quoteBlock.split('\n');
    if (!quoteLines.every((line) => line.startsWith('>'))) return null;

    const selectedText = quoteLines
      .map((line) => line.replace(/^> ?/, ''))
      .join('\n')
      .trim();

    return selectedText ? { selectedText, question, sourceMessageId } : null;
  }

  const quoted = $derived(splitSelectedTextQuestion(ctx.message.content || ''));
  const bodyHtml = $derived(renderMarkdown(quoted?.question || ctx.message.content || ''));
  const quoteHtml = $derived(quoted ? renderMarkdown(quoted.selectedText) : '');
  const workContext = $derived(ctx.message.workContext);

  /** Roleplay: the persona this turn speaks as, for chat-app identity. */
  const roleplayPersona = $derived.by(() => {
    const chat = appStore.currentChat;
    if (chat?.contextMode !== 'roleplay') return null;
    return charactersStore.getPersonaById(chat.personaId);
  });

  function scrollToSelectedSource() {
    const sourceMessageId = quoted?.sourceMessageId;
    if (!sourceMessageId) return;
    window.dispatchEvent(
      new CustomEvent('scroll-to-chat-message', { detail: { messageId: sourceMessageId } })
    );
  }

  const actions = $derived<MessageAction[]>(
    compactActions([
      {
        id: 'copy',
        label: copy.actions.copy,
        icon: Copy,
        primary: true,
        confirms: true,
        run: () => void writeToClipboard(ctx.message.content || '')
      },
      {
        id: 'edit',
        label: copy.actions.edit,
        icon: Pencil,
        primary: true,
        run: () => appStore.openEditMessage(ctx.message.id)
      },
      {
        id: 'delete',
        label: copy.actions.delete,
        icon: Trash2,
        danger: true,
        run: () =>
          confirmStore.show({
            ...copy.confirm.deleteMessage,
            danger: true,
            onConfirm: () => appStore.deleteMessage(ctx.message.id)
          })
      }
    ])
  );
</script>

{#if quoted}
  <button
    type="button"
    class="selected-text-message-bubble"
    data-chat-message-content
    data-chat-message-id={ctx.message.id}
    onclick={scrollToSelectedSource}
    title={copy.thread.jumpToSelection}
  >
    <CornerDownLeft class="selected-text-message-icon h-4 w-4" />
    <div class="markdown-body selected-text-message-markdown">{@html quoteHtml}</div>
  </button>
{/if}

<div class="user-message-stack max-w-full space-y-3">
  {#if roleplayPersona}
    <div class="persona-chip">
      <span class="persona-name">{roleplayPersona.name}</span>
      <span class="persona-avatar">
        {#if roleplayPersona.avatar}
          <img src={roleplayPersona.avatar} alt={roleplayPersona.name} />
        {:else}
          <span>{roleplayPersona.name?.trim()?.[0]?.toUpperCase() || '?'}</span>
        {/if}
      </span>
    </div>
  {/if}

  <div
    class="chateaui-user-bubble text-sm leading-relaxed"
    data-chat-message-content
    data-chat-message-id={ctx.message.id}
  >
    <div class="markdown-body">{@html bodyHtml}</div>
  </div>

  {#if ctx.message.attachments?.length}
    <div class="user-attachments-row">
      <AttachmentDocumentsBlock attachments={ctx.message.attachments} />
    </div>
  {/if}

  {#if workContext}
    <div class="flex flex-wrap justify-end gap-2">
      <span class="work-pill">Work · {workContext.rootName}</span>
      <span class="work-pill muted">{say.files(workContext.indexedCount)}</span>
    </div>
  {/if}

  <MessageActionBar {actions} align="end" visible={hovering || ctx.actionsPinned} {onmenutoggle} />
</div>

<style>
  /* Roleplay identity: mirrors the speaker line on assistant replies. */
  .persona-chip {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.375rem;
  }

  .persona-name {
    color: var(--text-secondary);
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.01em;
  }

  .persona-avatar {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.25rem;
    height: 1.25rem;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--muted);
    color: var(--text-muted);
    font-size: 0.625rem;
    font-weight: 600;
  }

  .persona-avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .work-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    border: 1px solid var(--work-accent-border);
    border-radius: var(--radius-full);
    background: var(--work-accent-soft);
    color: var(--work-accent-strong);
    font-size: 0.75rem;
    font-weight: 500;
  }

  .work-pill.muted {
    border-color: var(--border);
    background: var(--card);
    color: var(--muted-foreground);
  }
</style>
