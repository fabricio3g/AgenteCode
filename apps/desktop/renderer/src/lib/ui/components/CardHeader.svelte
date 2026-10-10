<script lang="ts">
  import UiStack from '$lib/components/ui/Stack.svelte';

  let { props = {} } = $props<{ props?: Record<string, any> }>();
</script>

<UiStack  style="gap:0.35rem;">
  {#if props.title}<h3 class="ui-title">{String(props.title)}</h3>{/if}
  {#if props.subtitle}<p class="ui-muted">{String(props.subtitle)}</p>{/if}
</UiStack>
