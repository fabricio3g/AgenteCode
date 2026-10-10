<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';
  let { checked = $bindable(false), ref = $bindable(), class: className = '', ...rest }: Omit<HTMLInputAttributes, 'type'> & { ref?: HTMLInputElement } = $props();
</script>
<input type="radio" bind:this={ref} {checked} class={cn('ui-choice-input', className)} {...rest} />
