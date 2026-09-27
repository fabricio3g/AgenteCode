<script lang="ts">
  import { getContext } from 'svelte';
  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const formName = getContext<string | undefined>('ui-form-name');
  const { getFieldValue, setFieldValue } = useUI();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
  const selected = $derived((getFieldValue(formName, String(props.name || '')) || {}) as Record<string, boolean>);
  function update(key: string, value: boolean) {
    setFieldValue(formName, 'SwitchGroup', String(props.name || ''), { ...selected, [key]: value });
  }
</script>

<div class="ui-stack" style="gap:0.45rem;">
  {#each items as item}
    {@const value = String(item?.props?.value || item?.value || item?.props?.name || '')}
    {@const label = String(item?.props?.label || item?.label || value)}
    <label class="ui-choice ui-switch"><span>{label}</span><input type="checkbox" checked={!!selected[value]} onchange={(event) => update(value, (event.currentTarget as HTMLInputElement).checked)} /></label>
  {/each}
</div>
