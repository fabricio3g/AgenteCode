<svelte:options runes={true} />

<!--
  The left edge of every inline artifact's header: the kind's tile, then the
  title and subtitle. One component so a chart, a map, a diagram, a dashboard,
  a card and a widget all start the same way; each surface puts its own
  actions to the right of it inside `.viz-header`.
-->

<script lang="ts">
  import { AppWindow, BarChart3, GraduationCap, Info, LayoutDashboard, MapPin, SlidersHorizontal, Workflow } from 'lucide-svelte';
  import type { ArtifactKind } from '$lib/types/chat';
  import { artifactKindAccent } from './artifact-accent';

  type HeadingKind = Extract<ArtifactKind, 'chart' | 'map' | 'diagram' | 'dashboard' | 'info_card' | 'html_card' | 'widget' | 'lesson'>;

  interface Props {
    kind: HeadingKind;
    title?: string;
    subtitle?: string;
  }

  let { kind, title = '', subtitle = '' }: Props = $props();

  const ICONS: Record<HeadingKind, typeof BarChart3> = {
    chart: BarChart3,
    map: MapPin,
    diagram: Workflow,
    dashboard: LayoutDashboard,
    info_card: Info,
    html_card: AppWindow,
    widget: SlidersHorizontal,
    lesson: GraduationCap
  };
  const Icon = $derived(ICONS[kind]);
</script>

<div class="viz-heading">
  <span class="artifact-kind-tile size-8 rounded-lg" style:--artifact-accent={artifactKindAccent(kind)} aria-hidden="true"><Icon class="size-4" /></span>
  <div class="min-w-0">
    {#if title}<h3 class="viz-title">{title}</h3>{/if}
    {#if subtitle}<p class="viz-subtitle">{subtitle}</p>{/if}
  </div>
</div>
