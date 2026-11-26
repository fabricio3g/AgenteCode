<svelte:options runes={true} />

<!--
  The mark a work-layout row leads with: the kind of work in a soft tile (or a
  round node), replaced by a spinner while it runs, a cross when it failed and
  a warning when it waits for you.
-->

<script lang="ts">
  import { AlertCircle, Bot, Brain, Check, FilePen, FileText, FolderOpen, Globe, LoaderCircle, Search, SquareTerminal, Wrench, XCircle } from '$lib/icons';
  import type { EntryKind, EntryStatus } from '../work-layouts';

  let {
    kind,
    status,
    shape = 'tile',
    settled = 'kind'
  }: {
    kind: EntryKind;
    status: EntryStatus;
    /** `tile` a rounded square, `node` a circle on a timeline. */
    shape?: 'tile' | 'node';
    /** What a finished step shows: its kind, or a check. */
    settled?: 'kind' | 'check';
  } = $props();

  const KIND = { read: FileText, list: FolderOpen, search: Search, web: Globe, edit: FilePen, command: SquareTerminal, subagent: Bot, other: Wrench, thought: Brain };
  const Icon = $derived(
    status === 'running' ? LoaderCircle : status === 'error' ? XCircle : status === 'ask' ? AlertCircle : settled === 'check' ? Check : KIND[kind]
  );
</script>

<span class="wl-icon is-{shape} is-{status}" class:is-check={settled === 'check' && status === 'done'} aria-hidden="true">
  <Icon class="wl-icon-glyph {status === 'running' ? 'wl-spin' : ''}" />
</span>
