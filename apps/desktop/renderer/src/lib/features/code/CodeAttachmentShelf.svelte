<script lang="ts">
  import type { Attachment } from '$shared/agente-protocol.gen';
  import { invoke } from '$lib/services/bridge';
  import { openWorkspaceFile } from '$lib/services/files';
  import AttachmentShelf from '../chat/composer/AttachmentShelf.svelte';
  import type { DraftAttachment } from '../chat/composer/attachment-shelf';
  let { attachments, onremove }: { attachments: Attachment[]; onremove: (path: string) => void } = $props();
  const thumbnails = new Map<string, Promise<string | null>>();
  function thumbnail(path: string) {
    let result = thumbnails.get(path);
    if (!result) { result = invoke<string | null>('agente_media_preview', {path}); thumbnails.set(path,result); }
    return result;
  }
  async function source(file: Attachment): Promise<string | null> {
    if (file.bytes > 32 * 1024 * 1024) {
      if (file.kind === 'image') return invoke<string | null>('agente_media_preview', {path:file.path,maxSize:4096});
      throw new Error('Files over 32 MB can be opened in the default app.');
    }
    const data = await invoke<string>('read_file_base64', {filePath:file.path});
    return `data:${file.mime || 'application/octet-stream'};base64,${data}`;
  }
  const files = $derived(attachments.map((file): DraftAttachment => ({
    id:file.path, name:file.name, size:file.bytes, type:file.mime, kind:file.kind, status:'ready',
    loadThumbnail:file.kind === 'image' ? () => thumbnail(file.path) : undefined,
    loadSource:() => source(file), openExternal:() => openWorkspaceFile(file.path)
  })));
</script>
<AttachmentShelf {files} onremove={onremove} />
