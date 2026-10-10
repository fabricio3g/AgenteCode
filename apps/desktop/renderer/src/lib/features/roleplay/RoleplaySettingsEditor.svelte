<svelte:options runes={true} />
<script lang="ts">
  import UiInput from '$lib/components/ui/Input.svelte';
  import UiTextarea from '$lib/components/ui/Textarea.svelte';
  import UiFileInput from '$lib/components/ui/FileInput.svelte';
  import { cn as uiClass } from '$lib/utils/cn';

  import { Select, Switch, Button } from '$lib/components/ui';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import type { RoleplaySettings } from '$lib/types/chat';
  import { DECISION_DIRECTIONS, presetSettings, resolveRoleplaySettings } from './roleplay-settings';
  import { roleplayPreferences } from './roleplay-presets.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';
  import { t } from 'svelte-i18n';

  let { value, inherited = {}, onchange }: {
    value: RoleplaySettings;
    inherited?: RoleplaySettings;
    onchange: (settings: RoleplaySettings) => void;
  } = $props();
  roleplayPreferences.load();
  const settings = $derived(resolveRoleplaySettings(inherited, value));
  let section = $state('conversation');
  let presetName = $state('');
  let selectedPreset = $state('');
  let importInput = $state<HTMLInputElement | undefined>();
  const tabs = ['conversation', 'scene', 'decisions', 'suggestions', 'memory', 'presentation', 'advanced'];
  const selects: Array<{ section: string; key: keyof RoleplaySettings; options: string[] }> = [
    { section: 'conversation', key: 'interactionMode', options: ['chat', 'narrative', 'dynamic'] },
    { section: 'conversation', key: 'replyStyle', options: ['dialogue', 'balanced', 'narrative'] },
    { section: 'conversation', key: 'replyLength', options: ['brief', 'adaptive', 'detailed'] },
    { section: 'conversation', key: 'initiative', options: ['reactive', 'balanced', 'proactive'] },
    { section: 'scene', key: 'pacing', options: ['slow', 'balanced', 'fast'] },
    { section: 'scene', key: 'replyOrder', options: ['natural', 'list', 'mention', 'manual'] },
    { section: 'decisions', key: 'stakes', options: ['gentle', 'balanced', 'high'] },
    { section: 'presentation', key: 'autocomplete', options: ['mention', 'automatic', 'off'] },
    { section: 'presentation', key: 'nameInsertion', options: ['name', 'nickname'] },
    { section: 'presentation', key: 'messageDensity', options: ['comfortable', 'compact'] },
    { section: 'presentation', key: 'actionFormatting', options: ['emphasis', 'plain'] },
    { section: 'advanced', key: 'choiceExpiry', options: ['pause', 'silence', 'event'] },
    { section: 'advanced', key: 'contentRating', options: ['sfw', 'unrestricted'] },
    { section: 'advanced', key: 'localSampler', options: ['roleplay', 'server'] },
    { section: 'advanced', key: 'repetition', options: ['dry', 'repeat'] }
  ];
  const toggles: Array<{ section: string; key: keyof RoleplaySettings }> = [
    { section: 'scene', key: 'npcDialogue' },
    { section: 'scene', key: 'sceneNpcs' },
    { section: 'decisions', key: 'outcomeRolls' },
    { section: 'decisions', key: 'showOutcomes' },
    { section: 'decisions', key: 'rerollEnabled' },
    { section: 'suggestions', key: 'adventureChoices' },
    { section: 'memory', key: 'memoryEnabled' },
    { section: 'memory', key: 'autoMemory' },
    { section: 'presentation', key: 'showSpeakerLabels' },
    { section: 'presentation', key: 'props' },
    { section: 'presentation', key: 'showAvatars' },
    { section: 'presentation', key: 'voicePlayback' },
    { section: 'advanced', key: 'autoMode' }
  ];
  const numbers: Array<{ section: string; key: keyof RoleplaySettings; min: number; max: number; step?: number; nullable?: boolean }> = [
    { section: 'scene', key: 'maxExchangeLines', min: 1, max: 8 },
    { section: 'decisions', key: 'surprise', min: 0, max: 100 },
    { section: 'decisions', key: 'twistCooldown', min: 0, max: 20 },
    { section: 'suggestions', key: 'choiceMin', min: 1, max: 6 },
    { section: 'suggestions', key: 'choiceMax', min: 1, max: 6 },
    { section: 'memory', key: 'memoryBudget', min: 100, max: 4000, step: 100 },
    { section: 'memory', key: 'summaryEvery', min: 0, max: 50 },
    { section: 'advanced', key: 'choiceTimerSeconds', min: 0, max: 600, nullable: true },
    { section: 'advanced', key: 'autoModeMaxTurns', min: 1, max: 12 },
    { section: 'advanced', key: 'autoModeDelayMs', min: 1000, max: 20000, step: 1000 },
    { section: 'advanced', key: 'temperature', min: 0, max: 2, step: 0.05, nullable: true },
    { section: 'advanced', key: 'topP', min: 0, max: 1, step: 0.05, nullable: true },
    { section: 'advanced', key: 'maxTokens', min: 0, max: 32000, nullable: true }
  ];
  const option = (value: string) => $t(`roleplay.settings.option.${value}`);
  const field = (key: string) => $t(`roleplay.settings.field.${key}`);
  const presetLabel = (preset: { id: string; name: string }) => $t(`roleplay.preset.${preset.id}`, { default: preset.name });
  function set(key: keyof RoleplaySettings, next: unknown) { onchange({ ...value, [key]: next }); }
  function reset() {
    const next = { ...value };
    for (const key of Object.keys(presetSettings(settings))) delete next[key as keyof RoleplaySettings];
    onchange(next);
    selectedPreset = '';
  }
  function applyPreset(id: string) {
    const preset = roleplayPreferences.presets.find((entry) => entry.id === id);
    if (preset) onchange({ ...value, ...presetSettings(preset.settings) });
    selectedPreset = id;
  }
  function savePreset() {
    const preset = roleplayPreferences.save(presetName || $t('roleplay.settings.myPreset'), settings);
    selectedPreset = preset.id;
    presetName = '';
  }
  function exportPreset() {
    const blob = new Blob([JSON.stringify({ version: 1, name: presetName || $t('roleplay.settings.exportName'), settings: presetSettings(settings) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'roleplay-preset.json'; anchor.click();
    URL.revokeObjectURL(url);
  }
  async function importPreset(event: Event) {
    const element = event.currentTarget as HTMLInputElement;
    const file = element.files?.[0]; element.value = '';
    if (!file) return;
    try {
      if (file.size > 128000) throw new Error($t('roleplay.settings.tooLarge'));
      const parsed = JSON.parse(await file.text());
      if (parsed.version !== 1 || !parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings)) throw new Error($t('roleplay.settings.invalid'));
      const preset = roleplayPreferences.save(typeof parsed.name === 'string' ? parsed.name : $t('roleplay.settings.importedName'), parsed.settings);
      applyPreset(preset.id);
    } catch (error) { toastStore.error(error instanceof Error ? error.message : $t('roleplay.settings.importFailed')); }
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center gap-2">
    <div class="min-w-40 flex-1"><Select variant="surface" value={selectedPreset} options={[{ value: '', label: $t('roleplay.settings.custom') }, ...roleplayPreferences.presets.map((preset) => ({ value: preset.id, label: presetLabel(preset) }))]} aria-label={$t('roleplay.settings.preset')} onchange={applyPreset} /></div>
    <Button variant="outline" size="sm" type="button" onclick={reset}>{$t('roleplay.settings.resetOverrides')}</Button>
  </div>
  <div class="overflow-x-auto py-1">
    <SegmentedControl value={section} options={tabs.map((value) => ({ value, label: $t(`roleplay.settings.tab.${value}`) }))} label={$t('roleplay.settings.sections')} variant="tabs" class="whitespace-nowrap" onchange={(value) => (section = value)} />
  </div>
  <div class="grid gap-4 sm:grid-cols-2">
    {#each selects.filter((entry) => entry.section === section) as item (item.key)}
      <div class="space-y-1.5"><span class="text-xs text-muted-foreground">{field(item.key)}</span>
        <Select variant="surface" value={String(settings[item.key] ?? '')} options={item.options.map((value) => ({ value, label: option(value) }))} aria-label={field(item.key)} onchange={(next) => set(item.key, next)} />
      </div>
    {/each}
    {#each numbers.filter((entry) => entry.section === section) as item (item.key)}
      <label class="space-y-1.5"><span class="text-xs text-muted-foreground">{field(item.key)}</span>
        <UiInput  type="number" min={item.min} max={item.max} step={item.step ?? 1} value={settings[item.key] as number ?? ''} oninput={(event) => set(item.key, event.currentTarget.value === '' && item.nullable ? null : Number(event.currentTarget.value))} />
      </label>
    {/each}
  </div>
  {#each toggles.filter((entry) => entry.section === section) as item (item.key)}
    <div class="flex items-center justify-between gap-4" title={$t(`roleplay.settings.hint.${item.key}`)}><div class="text-[13px] text-foreground">{field(item.key)}</div>
      <Switch checked={!!settings[item.key]} aria-label={field(item.key)} onchange={(next) => set(item.key, next)} />
    </div>
  {/each}
  {#if section === 'conversation'}
    <label class="block space-y-1.5" title={$t('roleplay.settings.modesHint')}><span class="text-xs text-muted-foreground">{$t('roleplay.settings.genre')}</span><UiInput  value={settings.genre ?? ''} placeholder={$t('roleplay.settings.genrePlaceholder')} oninput={(event) => set('genre', event.currentTarget.value)} /></label>
    <label class="block space-y-1.5"><span class="text-xs text-muted-foreground">{$t('roleplay.settings.authorNote')}</span><UiTextarea class={uiClass(" min-h-24 resize-y")} value={settings.authorNote ?? ''} oninput={(event) => set('authorNote', event.currentTarget.value)}></UiTextarea></label>
  {:else if section === 'decisions'}
    <div class="grid gap-3 sm:grid-cols-2" title={$t('roleplay.settings.decisionsHint')}>
      {#each Object.entries(DECISION_DIRECTIONS) as [key, description]}
        <label class="space-y-1"><span class="text-xs text-muted-foreground" title={description}>{$t('roleplay.settings.directionWeight', { values: { name: $t(`roleplay.direction.${key}`) } })}</span><UiInput  type="number" min="0" max="100" value={settings.decisionWeights?.[key] ?? 0} oninput={(event) => set('decisionWeights', { ...settings.decisionWeights, [key]: Number(event.currentTarget.value) })} /></label>
      {/each}
      {#each ['success', 'cost', 'setback'] as key}
        <label class="space-y-1"><span class="text-xs text-muted-foreground">{$t('roleplay.settings.outcomeWeight', { values: { name: $t(`roleplay.outcome.${key}`) } })}</span><UiInput  type="number" min="0" max="100" value={settings.outcomeWeights?.[key as 'success' | 'cost' | 'setback'] ?? 0} oninput={(event) => set('outcomeWeights', { ...settings.outcomeWeights, [key]: Number(event.currentTarget.value) })} /></label>
      {/each}
    </div>
  {/if}
  <details class="text-xs text-muted-foreground">
    <summary class="cursor-pointer py-2">{$t('roleplay.settings.presets')}</summary>
    <div class="space-y-2 pt-2">
      <UiInput  aria-label={$t('roleplay.settings.presetName')} placeholder={$t('roleplay.settings.presetNamePlaceholder')} bind:value={presetName} />
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" type="button" onclick={savePreset}>{$t('roleplay.settings.saveNew')}</Button>
        <Button variant="outline" size="sm" type="button" onclick={exportPreset}>{$t('roleplay.settings.export')}</Button>
        <Button variant="outline" size="sm" type="button" onclick={() => importInput?.click()}>{$t('roleplay.settings.import')}</Button>
        {#if roleplayPreferences.saved.some((entry) => entry.id === selectedPreset)}<Button variant="outline" size="sm" type="button" onclick={() => { roleplayPreferences.remove(selectedPreset); selectedPreset = ''; }}>{$t('roleplay.settings.deletePreset')}</Button>{/if}
        <Button variant="outline" size="sm" type="button" onclick={() => { roleplayPreferences.setDefaults(settings); toastStore.info($t('roleplay.settings.defaultsSaved')); }}>{$t('roleplay.settings.useDefaults')}</Button>
        <Button variant="outline" size="sm" type="button" onclick={() => roleplayPreferences.resetDefaults()}>{$t('roleplay.settings.resetDefaults')}</Button>
      </div>
      <UiFileInput class={uiClass("hidden")}  accept="application/json,.json" bind:ref={importInput} onchange={importPreset} />
      <p>{$t('roleplay.settings.inheritHint')}</p>
    </div>
  </details>
</div>
