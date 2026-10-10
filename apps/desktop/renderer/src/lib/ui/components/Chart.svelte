<script lang="ts">
  import UiSurface from '$lib/components/ui/Surface.svelte';
  import UiStack from '$lib/components/ui/Stack.svelte';

  let { props = {}, kind = 'bar' } = $props<{ props?: Record<string, any>; kind?: string }>();
  const labels = $derived(Array.isArray(props.labels) ? props.labels.map((item: unknown) => String(item)) : []);
  const series = $derived(Array.isArray(props.series) ? props.series : []);
  const slices = $derived(Array.isArray(props.slices) ? props.slices : []);
  const maxValue = $derived(Math.max(1, ...series.flatMap((item: any) => Array.isArray(item?.props?.data || item?.data) ? (item?.props?.data || item?.data) : []), ...slices.map((item: any) => Number(item?.props?.value || item?.value || 0))));
</script>

<UiSurface >
  {#if props.title}<h4 class="ui-title-sm">{String(props.title)}</h4>{/if}
  {#if kind === 'pie' || kind === 'radial'}
    <UiStack  style="gap:0.5rem;">
      {#each slices as slice}
        {@const label = String(slice?.props?.label || slice?.label || '')}
        {@const value = Number(slice?.props?.value || slice?.value || 0)}
        <div class="ui-chart-row"><span>{label}</span><div class="ui-chart-track"><div class="ui-chart-bar" style={`width:${(value / maxValue) * 100}%`}></div></div><strong>{value}</strong></div>
      {/each}
    </UiStack>
  {:else}
    <UiStack  style="gap:0.5rem;">
      {#each labels as label, index}
        <div class="ui-chart-row">
          <span>{label}</span>
          <div class="ui-chart-track">
            {#each series as serie, sidx}
              {@const value = Number((serie?.props?.data || serie?.data || [])[index] || 0)}
              <div class="ui-chart-bar" style={`width:${(value / maxValue) * 100}%;opacity:${1 - sidx * 0.18}`}></div>
            {/each}
          </div>
          <strong>{Number((series[0]?.props?.data || series[0]?.data || [])[index] || 0)}</strong>
        </div>
      {/each}
    </UiStack>
  {/if}
</UiSurface>
