<svelte:options runes={true} />

<!--
  Starter prompts under the composer, shown only while a conversation is empty.

  One line of links, in the same look the Code space and the Design dock use: a
  row of pills with glyphs competed with the composer for the eye, and the same
  suggestion in three spaces should read the same way. Selecting one fills the
  composer and focuses it rather than sending, so a mis-tap costs nothing and
  the prompt can still be edited before it goes anywhere. The Design dock lists
  its own starters, so that composer is told to skip these.
-->

<script lang="ts">
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { BarChart3, Code2, GraduationCap, ListChecks, PenLine, Sparkles, SunMedium } from '$lib/icons';
  import StarterList from '$lib/components/ui/StarterList.svelte';
  import type { Starter, StarterIcon } from '$lib/components/ui/starter-list';
  import { appStore } from '$lib/stores/app.svelte';
  import { copy } from '$lib/copy';
  import { lessonsEnabled } from '$lib/services/lesson-surface';

  const ICONS: Record<string, StarterIcon> = {
    weather: SunMedium,
    code: Code2,
    write: PenLine,
    analyze: BarChart3,
    brainstorm: Sparkles,
    teach: GraduationCap,
    practice: ListChecks
  };

  /** Hue per kind (oklch degrees): tells the starters apart, never emphasis. */
  const HUES: Record<string, number> = {
    weather: 75,
    code: 250,
    write: 20,
    analyze: 165,
    brainstorm: 300,
    teach: 130,
    practice: 205
  };

  interface Props {
    /** Focuses the composer textarea after the prompt is inserted. */
    onpick: () => void;
    /** The starter under the pointer, so the composer can preview its prompt. */
    onpreview?: (starter: Starter | null) => void;
  }

  let { onpick, onpreview }: Props = $props();

  /* Lessons are Home's, and off until asked for: the starters are the visible
     way in. They leave the command in the field for the topic to follow, and
     sending it turns the lesson type on (Composer's `/teach` handling). */
  const lessonStarters = $derived(lessonsEnabled(appStore.currentContextMode) ? [
    { id: 'teach', label: $t('artifacts.lesson.teach'), prompt: '/teach ', group: 'learn' },
    { id: 'practice', label: $t('artifacts.lesson.practice'), prompt: '/practice ', group: 'learn' }
  ] : []);
  const suggestions = $derived([
    ...copy.emptyState.suggestions.map((item) => ({ ...item, group: 'general' })),
    ...lessonStarters
  ]);

  const starters = $derived<Starter[]>(
    suggestions.map((suggestion) => ({
      id: suggestion.id,
      icon: ICONS[suggestion.id],
      hue: HUES[suggestion.id],
      label: suggestion.label,
      preview: suggestion.prompt,
      group: suggestion.group
    }))
  );

  async function pick(id: string) {
    const suggestion = suggestions.find((item) => item.id === id);
    if (!suggestion) return;
    appStore.composer = suggestion.prompt;
    // The textarea holds the prompt only once the update lands; focusing before
    // that puts the caret at the pre-insert length.
    await tick();
    onpick();
  }
</script>

<div class="suggestions">
  <StarterList {starters} label={copy.emptyState.greeting} onpick={(id) => void pick(id)} {onpreview} variant="links" />
</div>

<style>
  /* The composer dock is pointer-events:none so the thread stays scrollable
     behind it; anything interactive inside has to opt back in. The dock's own
     `px-3 md:px-6` already starts this line on the composer card's edge. */
  .suggestions {
    margin-top: 0.75rem;
    pointer-events: auto;
  }
</style>
