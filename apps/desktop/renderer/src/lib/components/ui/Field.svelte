<script lang="ts">
  import type { Snippet } from 'svelte';
  import FormRow from './FormRow.svelte';
  let { label, description, error, htmlFor, horizontal = false, class: className = '', children }: { label: string; description?: string; error?: string; htmlFor?: string; horizontal?: boolean; class?: string; children: Snippet } = $props();
</script>
<FormRow {label} {description} {error} {htmlFor} layout={horizontal ? 'row' : 'stack'} control={horizontal ? 'md' : 'auto'} density="compact" class={className} {children} />
