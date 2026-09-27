<script lang="ts">
  import RenderNode from './RenderNode.svelte';
  import Unknown from './components/Unknown.svelte';
  import { isElementNode, useUI } from './context';

  let { value } = $props<{ value: unknown }>();
  const { library } = useUI();

  const isArrayValue = $derived(Array.isArray(value));
  const isPrimitive = $derived(value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
  const node = $derived(isElementNode(value) ? value : null);
  const Component = $derived(node ? library.components[node.typeName]?.component || Unknown : Unknown);
  const extraProps = $derived.by(() => {
    if (!node) return {};
    const kindMap: Record<string, string> = {
      BarChart: 'bar',
      LineChart: 'line',
      AreaChart: 'area',
      RadarChart: 'radar',
      HorizontalBarChart: 'horizontal-bar',
      PieChart: 'pie',
      RadialChart: 'radial',
      SingleStackedBarChart: 'stacked-bar',
      ScatterChart: 'scatter'
    };
    return kindMap[node.typeName] ? { kind: kindMap[node.typeName] } : {};
  });
</script>

{#if isArrayValue}
  {#each value as item, index (index)}
    <RenderNode value={item} />
  {/each}
{:else if isPrimitive}
  {#if value != null}<span>{String(value)}</span>{/if}
{:else if node}
  <Component props={node.props} typeName={node.typeName} {...extraProps} />
{:else if typeof value === 'object'}
  <pre class="ui-debug">{JSON.stringify(value, null, 2)}</pre>
{/if}
