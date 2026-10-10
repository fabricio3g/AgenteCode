<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';
  let { checked = $bindable(false), indeterminate = $bindable(false), ref = $bindable(), class: className = '', ...rest }: Omit<HTMLInputAttributes, 'type'> & { ref?: HTMLInputElement } = $props();
</script>
<input type="checkbox" bind:this={ref} bind:checked bind:indeterminate class={cn('ui-choice-input', className)} {...rest} />
