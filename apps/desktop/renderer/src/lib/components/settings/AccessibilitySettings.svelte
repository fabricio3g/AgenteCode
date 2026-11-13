<svelte:options runes={true} />

<!--
  Settings → Accessibility: how big the interface and the messages are, the
  reading font and spacing, contrast, focus, links and motion. Changes apply
  at once and stay on this computer.
-->

<script lang="ts">
  import { t } from 'svelte-i18n';
  import { RotateCcw } from '$lib/icons';
  import { Button, SegmentedControl, Select, Switch } from '$lib/components/ui';
  import SettingsRow from './SettingsRow.svelte';
  import SettingsPage from './SettingsPage.svelte';
  import SettingsSection from './SettingsSection.svelte';
  import {
    accessibilityStore,
    DEFAULT_ACCESSIBILITY,
    TEXT_SCALES,
    UI_SCALES,
    type ReadingFont,
    type ReduceMotion,
    type TextWeight
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
    <!-- Interface and text size stay stacked: a 7-step scale is wider than the
         256px control column, and the sample needs the full row width. -->
    <SettingsRow layout="stack" label={$t('accessibility.interfaceSize')} description={$t('accessibility.interfaceSizeDesc')}>
      <SegmentedControl
        class="mt-2.5"
        label={$t('accessibility.interfaceSize')}
        value={nearest(UI_SCALES, prefs.uiScale)}
        options={UI_SCALES.map((scale) => ({ value: String(scale), label: percent(scale) }))}
        onchange={(value) => accessibilityStore.update({ uiScale: Number(value) })}
      />
    </SettingsRow>

    <SettingsRow layout="stack" label={$t('accessibility.textSize')} description={$t('accessibility.textSizeDesc')}>
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
    </SettingsRow>
  </SettingsSection>

  <SettingsSection title={$t('accessibility.reading')}>
    <SettingsRow label={$t('accessibility.textWeight')} description={$t('accessibility.textWeightDesc')} htmlFor="a11y-weight" control="auto">
      <SegmentedControl
        id="a11y-weight"
        label={$t('accessibility.textWeight')}
        value={prefs.textWeight}
        options={[
          { value: 'regular', label: $t('accessibility.weightRegular') },
          { value: 'medium', label: $t('accessibility.weightMedium') }
        ]}
        onchange={(value) => accessibilityStore.update({ textWeight: value as TextWeight })}
      />
    </SettingsRow>

    <SettingsRow label={$t('accessibility.font')} description={$t('accessibility.fontDesc')} htmlFor="a11y-font">
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
    </SettingsRow>

    <SettingsRow label={$t('accessibility.relaxed')} description={$t('accessibility.relaxedDesc')} control="auto">
      <Switch label={$t('accessibility.relaxed')} checked={prefs.relaxedSpacing} onchange={(checked) => accessibilityStore.update({ relaxedSpacing: checked })} />
    </SettingsRow>

    <SettingsRow label={$t('accessibility.underlineLinks')} description={$t('accessibility.underlineLinksDesc')} control="auto">
      <Switch label={$t('accessibility.underlineLinks')} checked={prefs.underlineLinks} onchange={(checked) => accessibilityStore.update({ underlineLinks: checked })} />
    </SettingsRow>
  </SettingsSection>

  <SettingsSection title={$t('accessibility.visibility')}>
    <SettingsRow label={$t('accessibility.contrast')} description={$t('accessibility.contrastDesc')} control="auto">
      <Switch label={$t('accessibility.contrast')} checked={prefs.highContrast} onchange={(checked) => accessibilityStore.update({ highContrast: checked })} />
    </SettingsRow>

    <SettingsRow label={$t('accessibility.focus')} description={$t('accessibility.focusDesc')} control="auto">
      <Switch label={$t('accessibility.focus')} checked={prefs.focusRings} onchange={(checked) => accessibilityStore.update({ focusRings: checked })} />
    </SettingsRow>
  </SettingsSection>

  <SettingsSection title={$t('accessibility.motion')}>
    <SettingsRow label={$t('accessibility.reduceMotion')} description={$t('accessibility.reduceMotionDesc')} control="auto">
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
    </SettingsRow>
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
