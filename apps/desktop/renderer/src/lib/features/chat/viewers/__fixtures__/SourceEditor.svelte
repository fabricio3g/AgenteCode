<script lang="ts">
  let { value, onchange }: { value: string; onchange: (value: string) => void } = $props();
</script>
<textarea aria-label="Source editor" {value} oninput={event => onchange(event.currentTarget.value)}></textarea>
