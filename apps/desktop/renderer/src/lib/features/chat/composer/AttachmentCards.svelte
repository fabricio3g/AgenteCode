<script lang="ts">
  import { appStore } from '$lib/stores/app.svelte';
  import AttachmentShelf from './AttachmentShelf.svelte';
  const files = $derived(appStore.pendingAttachments.map(file => ({
    id:file.id, name:file.name, size:file.size, type:file.type, kind:file.kind,
    status:file.status, error:file.error, warning:file.warning,
    thumbnail:file.base64 || file.preview,
    source:file.kind === 'image' ? file.base64 || file.preview : file.data || file.preview,
    content:file.ocrText
  })));
</script>
<AttachmentShelf {files} onremove={id => appStore.removeAttachment(id)} />
