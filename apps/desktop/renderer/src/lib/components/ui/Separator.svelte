<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '$lib/utils/cn';
  let { class: className = '', ...rest }: HTMLAttributes<HTMLHRElement> = $props();
</script>
<hr class={cn('ui-divider', className)} {...rest} />
<style>.ui-divider { width:100%; margin-block:0.5rem; border:0; border-top:1px solid var(--border-subtle); }</style>
