<svelte:options runes={true} />

<script lang="ts">
  import UiButton from '$lib/components/ui/Button.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import Avatar from '$lib/components/ui/Avatar.svelte';
  import { CornerDownLeft, Copy, Pencil, Pin, Trash2 } from '$lib/icons';
  import { t } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { confirmStore } from '$lib/stores/confirm.svelte';
  import { copy, say } from '$lib/copy';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { writeToClipboard } from '$lib/utils/clipboard';
  import AttachmentDocumentsBlock from '$lib/features/chat/AttachmentDocumentsBlock.svelte';
  import { charactersStore } from '$lib/features/roleplay/characters.svelte';
  import { roleplayStore } from '$lib/features/roleplay/roleplay.svelte';
  import { highlightRoleplayMentions } from '$lib/features/roleplay/roleplay-mentions';
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
  /*
   * `breaks: true` everywhere here: this is text a person typed, so a single
   * newline is a line break they chose. Model output is rendered with the
   * opposite default so its own hard wrapping reflows into the reading column.
   */
  const bodyHtml = $derived.by(() => {
    const content = roleplayStore.displayText(quoted?.question || ctx.message.content || '', { messageId: ctx.message.id });
    if (ctx.contextMode !== 'roleplay') return renderMarkdown(content, { breaks: true });
    const chat = appStore.currentChat;
    const names = (chat?.roleplay?.characterIds ?? (chat?.characterId ? [chat.characterId] : [])).flatMap((id) => {
      const card = charactersStore.getById(id);
      return card ? [card.name, card.nickname ?? '', ...(card.aliases ?? [])] : [];
    });
    return highlightRoleplayMentions(renderMarkdown(content.replace(/\s*\[character:[^\]]+\]/g, ''), { breaks: true }), [...names, ...roleplayStore.room().npcs.map((npc) => npc.name)]);
  });
  const quoteHtml = $derived(quoted ? renderMarkdown(roleplayStore.displayText(quoted.selectedText, { messageId: quoted.sourceMessageId || ctx.message.id }), { breaks: true }) : '');
  const workContext = $derived(ctx.message.workContext);

  /** Roleplay: the persona this turn speaks as, for chat-app identity. */
  const roleplayPersona = $derived.by(() => {
    const chat = appStore.currentChat;
    if (chat?.contextMode !== 'roleplay') return null;
    return ctx.message.metadata?.roleplayPersona ?? charactersStore.getPersonaById(chat.personaId);
  });
  /** No persona chosen: the chip says "You", never the placeholder "User". */
  const personaLabel = $derived(
    !roleplayPersona ? '' : roleplayPersona.id || roleplayPersona.name !== 'User' ? roleplayPersona.name : $t('roleplay.you')
  );

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
        run: () => void writeToClipboard(roleplayStore.displayText(ctx.message.content || '', { messageId: ctx.message.id }))
      },
      ctx.contextMode === 'roleplay' && {
        id: 'pin',
        label: $t('roleplay.memory.pinAction'),
        icon: Pin,
        run: () => roleplayStore.pinToMemory(ctx.message.content || '')
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
  <UiButton variant="plain"
    type="button"
    class={uiClass("selected-text-message-bubble")}
    data-chat-message-content
    data-chat-message-id={ctx.message.id}
    onclick={scrollToSelectedSource}
    title={copy.thread.jumpToSelection}
  >
    <CornerDownLeft class="selected-text-message-icon h-4 w-4" />
    <div class="markdown-body selected-text-message-markdown">{@html quoteHtml}</div>
  </UiButton>
{/if}

<div class="user-message-stack max-w-full space-y-3">
  {#if roleplayPersona}
    <div class="persona-chip">
      <span class="persona-name">{personaLabel}</span>
      {#if roleplayStore.settings().showAvatars !== false}
      <span class="persona-avatar">
        <Avatar size="fill" name={personaLabel} image={roleplayPersona.avatar} />
      </span>
      {/if}
    </div>
  {/if}

  <div
    class="user-bubble leading-relaxed"
    data-chat-message-content
    data-chat-message-id={ctx.message.id}
  >
    <div class="markdown-body">{@html bodyHtml}</div>
  </div>

  {#if ctx.message.metadata?.agentReaction}
    <div class="agent-reaction"><span role="img" aria-label={ctx.message.metadata.agentReaction}>{ctx.message.metadata.agentReaction}</span></div>
  {/if}

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
  .agent-reaction { display:flex; justify-content:flex-end; margin-top:0.25rem; padding-inline:0.5rem; font-size:var(--text-base); }
  .agent-reaction span {
    display:inline-grid;
    place-items:center;
    inline-size:1.85em;
    block-size:1.85em;
    border-radius:50%;
    background:var(--surface-hover);
    line-height:1;
  }
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
    font-size: var(--text-xs);
    font-weight: 600;
  }


  .work-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.25rem 0.625rem;
    border-radius: var(--radius-full);
    background: var(--muted);
    color: var(--muted-foreground);
    font-size: 0.75rem;
    font-weight: 500;
  }

  .work-pill.muted {
    background: transparent;
  }
</style>
