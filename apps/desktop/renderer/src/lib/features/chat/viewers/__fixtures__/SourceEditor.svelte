<script lang="ts">
  import UiTextarea from '$lib/components/ui/Textarea.svelte';

  let { value, onchange }: { value: string; onchange: (value: string) => void } = $props();
</script>
<UiTextarea  aria-label="Source editor" {value} oninput={event => onchange(event.currentTarget.value)}></UiTextarea>
