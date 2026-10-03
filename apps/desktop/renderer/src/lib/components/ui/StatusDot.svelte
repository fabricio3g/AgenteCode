<svelte:options runes={true} />

<!--
  The sidebar rail's status dot: a turn in progress, a turn waiting for
  approval, a loaded model, a bot at work.

  Four components hand-rolled this — SessionRow, CodeSidebar, SidebarInstances
  and BotRoster — in three sizes with two copies of the same pulse keyframes.
  The dot is decorative: `label` carries the meaning for screen readers, and
  omitting it hides the dot from them entirely.
-->

<script lang="ts">
  type Tone = 'idle' | 'running' | 'busy' | 'approval' | 'active' | 'error';

  let {
    tone = 'idle',
    label = ''
  }: {
    /** `running` and `busy` pulse; the rest hold still. */
    tone?: Tone;
    /** Accessible name. Without one the dot is hidden from assistive tech. */
    label?: string;
  } = $props();
</script>

<span
  class="sidebar-dot is-{tone}"
  role={label ? 'status' : undefined}
  aria-label={label || undefined}
  title={label || undefined}
  aria-hidden={label ? undefined : 'true'}
></span>
