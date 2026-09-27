<script lang="ts">
  import { getContext } from 'svelte';
  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const formName = getContext<string | undefined>('ui-form-name');
  const { getFieldValue, setFieldValue } = useUI();
  const items = $derived(Array.isArray(props.items) ? props.items : []);
  const selected = $derived(String(getFieldValue(formName, String(props.name || '')) ?? ''));
</script>

<div class="ui-stack" style="gap:0.45rem;">
  {#each items as item}
    {@const value = String(item?.props?.value || item?.value || '')}
    {@const label = String(item?.props?.label || item?.label || value)}
    <label class="ui-choice"><input type="radio" name={String(props.name || '')} checked={selected === value} onchange={() => setFieldValue(formName, 'RadioGroup', String(props.name || ''), value)} /> <span>{label}</span></label>
  {/each}
</div>
