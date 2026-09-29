<svelte:options runes={true} />

<!--
  Settings → Accessibility: how big the interface and the messages are, the
  reading font and spacing, contrast, focus, links and motion. Changes apply
  at once and stay on this computer.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { RotateCcw } from 'lucide-svelte';
  import { Button, Field, SegmentedControl, Select, Switch } from '$lib/components/ui';
  import SettingsPage from './SettingsPage.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import {
    accessibilityStore,
    DEFAULT_ACCESSIBILITY,
    TEXT_SCALES,
    UI_SCALES,
    type ReadingFont,
    type ReduceMotion
  } from '$lib/stores/accessibility.svelte';

  const prefs = $derived(accessibilityStore.prefs);
  const changed = $derived(JSON.stringify(prefs) !== JSON.stringify(DEFAULT_ACCESSIBILITY));

  const percent = (scale: number) => `${Math.round(scale * 100)}%`;
  /** A saved size between presets (from an older version) still shows as selected. */
  const nearest = (scales: readonly number[], value: number) =>
    String(scales.reduce((best, scale) => (Math.abs(scale - value) < Math.abs(best - value) ? scale : best), scales[0]));
</script>

<SettingsPage title={$t('accessibility.title')} description={$t('accessibility.description')}>
  <SettingsSection title={$t('accessibility.display')}>
    <Field class="py-3" label={$t('accessibility.interfaceSize')} description={$t('accessibility.interfaceSizeDesc')}>
      <SegmentedControl
        class="mt-2.5"
        label={$t('accessibility.interfaceSize')}
        value={nearest(UI_SCALES, prefs.uiScale)}
        options={UI_SCALES.map((scale) => ({ value: String(scale), label: percent(scale) }))}
        onchange={(value) => accessibilityStore.update({ uiScale: Number(value) })}
      />
    </Field>

    <Field class="py-3" label={$t('accessibility.textSize')} description={$t('accessibility.textSizeDesc')}>
      <SegmentedControl
        class="mt-2.5"
        label={$t('accessibility.textSize')}
        value={nearest(TEXT_SCALES, prefs.textScale)}
        options={TEXT_SCALES.map((scale) => ({ value: String(scale), label: percent(scale) }))}
        onchange={(value) => accessibilityStore.update({ textScale: Number(value) })}
      />
      <div class="sample markdown-body mt-3" aria-hidden="true">
        <p>{$t('accessibility.sample')}</p>
      </div>
    </Field>
  </SettingsSection>

  <SettingsSection title={$t('accessibility.reading')}>
    <Field horizontal class="py-3" label={$t('accessibility.font')} description={$t('accessibility.fontDesc')} htmlFor="a11y-font">
      <Select
        id="a11y-font"
        value={prefs.font}
        options={[
          { value: 'default', label: $t('accessibility.fontDefault') },
          { value: 'hyperlegible', label: $t('accessibility.fontHyperlegible') },
          { value: 'system', label: $t('accessibility.fontSystem') }
        ]}
        onchange={(value) => accessibilityStore.update({ font: value as ReadingFont })}
      />
    </Field>

    <Field horizontal class="py-3" label={$t('accessibility.relaxed')} description={$t('accessibility.relaxedDesc')}>
      <div class="flex justify-end">
        <Switch label={$t('accessibility.relaxed')} checked={prefs.relaxedSpacing} onchange={(checked) => accessibilityStore.update({ relaxedSpacing: checked })} />
      </div>
    </Field>

    <Field horizontal class="py-3" label={$t('accessibility.underlineLinks')} description={$t('accessibility.underlineLinksDesc')}>
      <div class="flex justify-end">
        <Switch label={$t('accessibility.underlineLinks')} checked={prefs.underlineLinks} onchange={(checked) => accessibilityStore.update({ underlineLinks: checked })} />
      </div>
    </Field>
  </SettingsSection>

  <SettingsSection title={$t('accessibility.visibility')}>
    <Field horizontal class="py-3" label={$t('accessibility.contrast')} description={$t('accessibility.contrastDesc')}>
      <div class="flex justify-end">
        <Switch label={$t('accessibility.contrast')} checked={prefs.highContrast} onchange={(checked) => accessibilityStore.update({ highContrast: checked })} />
      </div>
    </Field>

    <Field horizontal class="py-3" label={$t('accessibility.focus')} description={$t('accessibility.focusDesc')}>
      <div class="flex justify-end">
        <Switch label={$t('accessibility.focus')} checked={prefs.focusRings} onchange={(checked) => accessibilityStore.update({ focusRings: checked })} />
      </div>
    </Field>
  </SettingsSection>

  <SettingsSection title={$t('accessibility.motion')}>
    <Field horizontal class="py-3" label={$t('accessibility.reduceMotion')} description={$t('accessibility.reduceMotionDesc')}>
      <div class="flex justify-end">
        <SegmentedControl
          label={$t('accessibility.reduceMotion')}
          value={prefs.reduceMotion}
          options={[
            { value: 'system', label: $t('accessibility.motionSystem') },
            { value: 'on', label: $t('accessibility.motionOn') },
            { value: 'off', label: $t('accessibility.motionOff') }
          ]}
          onchange={(value) => accessibilityStore.update({ reduceMotion: value as ReduceMotion })}
        />
      </div>
    </Field>
  </SettingsSection>

  <div class="flex justify-end">
    <Button variant="ghost" size="sm" disabled={!changed} onclick={() => accessibilityStore.reset()}>
      <RotateCcw /> {$t('accessibility.reset')}
    </Button>
  </div>
</SettingsPage>

<style>
  .sample {
    border-radius: 0.75rem;
    background: var(--surface-hover);
    padding: 0.625rem 0.875rem;
  }
  .sample p {
    margin: 0;
  }
</style>
