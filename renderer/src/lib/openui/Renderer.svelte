<svelte:options runes={true} />

<script lang="ts">
  import UIRenderer from '../ui/Renderer.svelte';
  import type { ActionEvent, ParseResult } from '$lib/ui';
  import type { Library } from '$lib/ui/library';

  interface Props {
    response: string | null;
    library: Library;
    isStreaming?: boolean;
    onAction?: (event: ActionEvent) => void;
    onStateUpdate?: (state: Record<string, any>) => void;
    initialState?: Record<string, any>;
    onParseResult?: (result: ParseResult | null) => void;
  }

  let {
    response,
    library,
    isStreaming = false,
    onAction,
    onStateUpdate,
    initialState,
    onParseResult
  }: Props = $props();
</script>

<UIRenderer {response} {library} {isStreaming} {onAction} {onStateUpdate} {initialState} {onParseResult} />
