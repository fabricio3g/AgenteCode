<script lang="ts">
  import { getContext } from 'svelte';
  import { useUI } from '../context';
  let { props = {} } = $props<{ props?: Record<string, any> }>();
  const formName = getContext<string | undefined>('ui-form-name');
  const { getFieldValue, setFieldValue } = useUI();
  const current = $derived(Number(getFieldValue(formName, String(props.name || '')) ?? props.defaultValue ?? props.min ?? 0));
</script>

<div class="ui-stack" style="gap:0.4rem;">
  <input class="ui-range" type="range" min={String(props.min ?? 0)} max={String(props.max ?? 100)} step={String(props.step ?? 1)} value={String(current)} oninput={(event) => setFieldValue(formName, 'Slider', String(props.name || ''), Number((event.currentTarget as HTMLInputElement).value))} />
  <span class="ui-muted">{current}</span>
</div>
