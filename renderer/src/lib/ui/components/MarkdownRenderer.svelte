<script lang="ts">
  import { renderMarkdown } from '$lib/utils/markdown';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const html = $derived(renderMarkdown(String(props.content || props.text || '')));
</script>

<div class="markdown-body">{@html html}</div>
