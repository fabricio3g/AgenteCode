<script lang="ts">
  let { props = {} } = $props<{ props?: Record<string, any> }>();
</script>

<div class="code-block-wrapper">
  <div class="code-block-header"><span class="code-lang">{String(props.language || 'code')}</span></div>
  <pre><code>{String(props.code || '')}</code></pre>
</div>
