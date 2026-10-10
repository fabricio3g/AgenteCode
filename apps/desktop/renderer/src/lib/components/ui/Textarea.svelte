<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';
  import { fieldVariants, type FieldVariant } from './control-styles';
  type Props = HTMLTextareaAttributes & { variant?: FieldVariant; ref?: HTMLTextAreaElement };
  let { value = $bindable(), ref = $bindable(), class: className = '', variant = 'default', ...rest }: Props = $props();
</script>
<textarea bind:this={ref} bind:value class={cn(fieldVariants({ variant, multiline: true }), className)} {...rest}></textarea>
