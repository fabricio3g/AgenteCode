<script lang="ts">
  import { Input, Textarea, Range, FileInput, Checkbox, IconButton } from '$lib/components/ui';
  let { onnumber, onrange, ontext, onfile, oncheck }: { onnumber: (value: number | null | undefined) => void; onrange: (value: number) => void; ontext: (value: string) => void; onfile: (file?: File) => void; oncheck: (value: boolean) => void } = $props();
  let number = $state<number | null | undefined>(3);
  let range = $state(5);
  let text = $state('Initial');
  let checked = $state(false);
  let input = $state<HTMLInputElement>();
  let file = $state<HTMLInputElement>();
  $effect(() => { onnumber(number); });
  $effect(() => { onrange(range); });
  $effect(() => { ontext(text); });
  $effect(() => { oncheck(checked); });
</script>
<Input type="number" aria-label="Count" bind:ref={input} bind:value={number} />
<Range aria-label="Volume" bind:value={range} />
<Textarea aria-label="Notes" bind:value={text} />
<FileInput aria-label="Import" bind:ref={file} onchange={event => { onfile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
<Checkbox aria-label="Enabled" bind:checked />
<IconButton label="Focus count" onclick={() => input?.focus()} />
<IconButton label="Open import" onclick={() => file?.click()} />
