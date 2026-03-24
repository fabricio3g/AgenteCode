<script lang="ts">
  import Card from './Card.svelte';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
</script>

<Card {props} chat={true} />
