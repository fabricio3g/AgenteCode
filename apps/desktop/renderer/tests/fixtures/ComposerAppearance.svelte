<script lang="ts">
  import Textarea from '$lib/components/ui/Textarea.svelte';
  let value = $state('');
</script>
<div class="ui-composer" style="width:min(38rem,100%);padding:1rem">
  <Textarea variant="composer" bind:value placeholder="Escribe un mensaje…" aria-label="Mensaje" rows={2} />
</div>
