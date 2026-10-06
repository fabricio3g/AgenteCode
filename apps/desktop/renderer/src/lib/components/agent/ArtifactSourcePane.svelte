<svelte:options runes={true} />

<script lang="ts">
  import { Tooltip } from '$lib/components/ui';
  import { t } from 'svelte-i18n';
  import { FileDown, FileQuestion } from 'lucide-svelte';
  import Button from '$lib/components/ui/Button.svelte';
  import CodeEditor from '$lib/ui/components/CodeEditor.svelte';
  import { isDataUrlFile } from '$lib/utils/artifact-files';

  interface Props { path: string; content: string; onchange: (content: string) => void; ondownload: () => void; chrome?: boolean }
  let { path, content, onchange, ondownload, chrome = true }: Props = $props();
  const binary = $derived(isDataUrlFile(content));
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if chrome}<div class="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
    <span class="truncate text-[12px] text-muted-foreground">{path || $t('artifacts.studio.noFile')}</span>
    <Tooltip label={$t('artifacts.studio.downloadFile')} position="bottom"><Button variant="ghost" size="icon-sm" onclick={ondownload} disabled={!path} aria-label={$t('artifacts.studio.downloadFile')}><FileDown /></Button></Tooltip>
  </div>
  {/if}
  {#if !path}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground"><FileQuestion class="size-8 opacity-40" /><span class="text-xs">{$t('artifacts.studio.selectFile')}</span></div>
  {:else if binary}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground"><FileQuestion class="size-8 opacity-40" /><span class="text-xs">Binary files can be previewed or downloaded, but not edited.</span></div>
  {:else}
    <div class="min-h-0 flex-1"><CodeEditor value={content} language={path.split('.').pop() || 'plaintext'} {onchange} /></div>
  {/if}
</div>
