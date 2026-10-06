<svelte:options runes={true} />
<script lang="ts">
  import { t, locale } from 'svelte-i18n';
  import { appStore } from '$lib/stores/app.svelte';
  import { codeStore } from '$lib/features/code/code.svelte';
  import { usedModels } from './session-metadata';
  import { displayChatTitle } from './session-title';
  import type { ChatSession } from '$lib/types/chat';
  let { chat }: { chat: ChatSession } = $props();
  const project = $derived(codeStore.projectById(chat.projectId ?? null));
  const folder = $derived(appStore.folders.find(folder => folder.id === chat.folderId)?.name ?? project?.rootName ?? '—');
  const models = $derived(usedModels(chat));
  const selected = $derived(chat.modelSelection?.backendMode === 'local' ? chat.modelSelection.localModel : chat.modelSelection?.model);
  function date(value: number): string { return new Intl.DateTimeFormat($locale ?? 'en', {dateStyle:'medium',timeStyle:'short'}).format(value); }
</script>
<div class="session-metadata" data-session-metadata={chat.id}>
  <p class="metadata-title">{displayChatTitle(chat)}</p>
  <dl>
    <dt>{$t('conversationInfo.created')}</dt><dd>{date(chat.createdAt)}</dd>
    <dt>{$t('conversationInfo.updated')}</dt><dd>{date(chat.updatedAt || chat.createdAt)}</dd>
    <dt>{$t('conversationInfo.folder')}</dt><dd>{folder}</dd>
    {#if project}<dt>{$t('conversationInfo.project')}</dt><dd>{project.rootName}</dd>{/if}
    <dt>{$t('conversationInfo.models')}</dt><dd>{models.length ? models.join(' · ') : $t('conversationInfo.unrecorded')}</dd>
    {#if selected}<dt>{$t('conversationInfo.selectedModel')}</dt><dd>{selected}</dd>{/if}
  </dl>
</div>
<style>
  .session-metadata { width: 18rem; max-width: calc(100vw - 3rem); font-size: var(--text-xs); }
  .metadata-title { font-size: var(--text-sm); font-weight: 550; color: var(--foreground); margin-bottom: 0.625rem; }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.375rem 0.75rem; }
  dt { color: var(--muted-foreground); } dd { color: var(--foreground); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
</style>
