<script lang="ts">
  let { props = {} } = $props<{ props?: Record<string, any> }>();
</script>

<div class="ui-callout ui-callout-neutral">
  <div class="ui-copy">{String(props.text || props.content || '')}</div>
</div>
