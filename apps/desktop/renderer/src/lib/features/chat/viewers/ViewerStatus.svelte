<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import { t } from 'svelte-i18n';
  import AsyncState from '$lib/components/ui/AsyncState.svelte';
  let props: Omit<ComponentProps<typeof AsyncState>, 'retryLabel'> = $props();
</script>
<AsyncState {...props} retryLabel={$t('chat.retry')} />
