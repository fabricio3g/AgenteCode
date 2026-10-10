<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import type { Action } from 'svelte/action';
  import { cn } from '$lib/utils/cn';
  import { fieldVariants, type FieldVariant } from './control-styles';

  type Props = HTMLInputAttributes & { variant?: FieldVariant; ref?: HTMLInputElement; action?: Action<HTMLInputElement> };
  let { class: className = '', variant = 'default', value = $bindable(), ref = $bindable(), action = () => {}, ...rest }: Props = $props();
</script>
<input bind:this={ref} bind:value use:action class={cn(fieldVariants({ variant }), className)} {...rest} />
