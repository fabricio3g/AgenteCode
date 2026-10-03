<svelte:options runes={true} />
<script lang="ts">
  import { File, FileImage, FileText, Music, Video, X } from 'lucide-svelte';
  import { t } from 'svelte-i18n';
  import type { Attachment } from '$shared/agente-protocol.gen';
  import { invoke } from '$lib/services/bridge';
  import { openWorkspaceFile } from '$lib/services/files';
  import { toastStore } from '$lib/stores/toast.svelte';
  let { attachment, onremove }: { attachment: Attachment; onremove?: () => void } = $props();
  let preview = $state<string | null>(null);
  let failed = $state(false);
  const Icon = $derived(attachment.kind === 'image' ? FileImage : attachment.kind === 'audio' ? Music : attachment.kind === 'video' ? Video : attachment.kind === 'pdf' ? FileText : File);
  $effect(() => {
    const path = attachment.path;
    preview = null; failed = false;
    let active = true;
    if (attachment.kind === 'image') void invoke<string | null>('agente_media_preview', { path }).then(value => { if (active) preview = value; }).catch(() => {});
    return () => { active = false; };
  });
</script>
<div class="media-card">
  <button type="button" class="media-open" title={attachment.name} onclick={() => openWorkspaceFile(attachment.path).catch(error => toastStore.error(String(error)))}>
    <span class="media-thumb">
      {#if preview && !failed}<img src={preview} alt={attachment.name} onerror={() => failed = true} />{:else}<Icon class="size-5" />{/if}
    </span>
    <span class="media-caption"><span class="media-name">{attachment.name}</span><span class="media-kind">{attachment.kind}{attachment.bytes ? ` · ${(attachment.bytes / 1024).toFixed(0)} KB` : ''}</span></span>
  </button>
  {#if onremove}<button type="button" class="media-remove ui-icon-button" aria-label={$t('code.media.remove', { values: { name: attachment.name } })} onclick={onremove}><X class="size-3" /></button>{/if}
</div>
<style>
  .media-card { display: flex; align-items: center; gap: 0.25rem; max-width: 16rem; min-width: 0; padding: 0.25rem; border-radius: 0.625rem; background: color-mix(in srgb, var(--muted) 70%, var(--background)); }
  .media-open { display: flex; align-items: center; gap: 0.5rem; min-width: 0; text-align: left; }
  .media-thumb { display: flex; align-items: center; justify-content: center; flex-shrink: 0; width: 3rem; height: 3rem; border-radius: 0.375rem; overflow: hidden; color: var(--muted-foreground); }
  img { width: 100%; height: 100%; object-fit: cover; }
  .media-caption { display: flex; flex-direction: column; min-width: 0; padding-right: 0.25rem; font-size: 12px; }
  .media-name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--foreground); }
  .media-kind { color: var(--muted-foreground); }
  .media-remove { flex-shrink: 0; }
</style>
