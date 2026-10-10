<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import FormRow from '$lib/components/ui/FormRow.svelte';
  let props: ComponentProps<typeof FormRow> = $props();
</script>
<FormRow {...props} />
