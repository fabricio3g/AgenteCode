<svelte:options runes={true} />
<script lang="ts">
  import { Select, Switch } from '$lib/components/ui';
  import SegmentedControl from '$lib/components/ui/SegmentedControl.svelte';
  import type { RoleplaySettings } from '$lib/types/chat';
  import { DECISION_DIRECTIONS, presetSettings, resolveRoleplaySettings } from './roleplay-settings';
  import { roleplayPreferences } from './roleplay-presets.svelte';
  import { toastStore } from '$lib/stores/toast.svelte';

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
  let importInput: HTMLInputElement;
  const tabs = [
    ['conversation', 'Conversation'], ['scene', 'Scene'], ['decisions', 'Decisions'],
    ['suggestions', 'Suggestions'], ['memory', 'Memory'], ['presentation', 'Presentation'], ['advanced', 'Advanced']
  ];
  const selects: Array<{ section: string; key: keyof RoleplaySettings; label: string; options: string[] }> = [
    { section: 'conversation', key: 'interactionMode', label: 'Mode', options: ['chat', 'narrative', 'dynamic'] },
    { section: 'conversation', key: 'replyStyle', label: 'Reply style', options: ['dialogue', 'balanced', 'narrative'] },
    { section: 'conversation', key: 'replyLength', label: 'Reply length', options: ['brief', 'adaptive', 'detailed'] },
    { section: 'conversation', key: 'initiative', label: 'Character initiative', options: ['reactive', 'balanced', 'proactive'] },
    { section: 'scene', key: 'pacing', label: 'Pacing', options: ['slow', 'balanced', 'fast'] },
    { section: 'scene', key: 'replyOrder', label: 'Lead speaker', options: ['natural', 'list', 'mention', 'manual'] },
    { section: 'decisions', key: 'stakes', label: 'Consequences', options: ['gentle', 'balanced', 'high'] },
    { section: 'presentation', key: 'autocomplete', label: 'Name completion', options: ['mention', 'automatic', 'off'] },
    { section: 'presentation', key: 'nameInsertion', label: 'Insert names as', options: ['name', 'nickname'] },
    { section: 'presentation', key: 'messageDensity', label: 'Message spacing', options: ['comfortable', 'compact'] },
    { section: 'presentation', key: 'actionFormatting', label: 'Action formatting', options: ['emphasis', 'plain'] },
    { section: 'advanced', key: 'choiceExpiry', label: 'When a suggestion timer expires', options: ['pause', 'silence', 'event'] },
    { section: 'advanced', key: 'contentRating', label: 'Content frame', options: ['sfw', 'unrestricted'] }
  ];
  const toggles: Array<{ section: string; key: keyof RoleplaySettings; label: string; description: string }> = [
    { section: 'scene', key: 'npcDialogue', label: 'Character-to-character dialogue', description: 'Relevant characters can answer each other inside one response.' },
    { section: 'scene', key: 'sceneNpcs', label: 'Scene-local NPCs', description: 'Dynamic scenes may introduce supporting characters for this conversation.' },
    { section: 'decisions', key: 'outcomeRolls', label: 'Uncertain action outcomes', description: 'Resolve explicit “I try…” or “I attempt…” actions. Ordinary dialogue is never rolled.' },
    { section: 'decisions', key: 'showOutcomes', label: 'Show outcome indicators', description: 'Attach a subtle outcome label to the response.' },
    { section: 'decisions', key: 'rerollEnabled', label: 'Allow a new direction', description: 'Offer a separate reroll action. Retry keeps the original decision.' },
    { section: 'suggestions', key: 'adventureChoices', label: 'Suggested actions', description: 'Selecting a suggestion fills the composer for you to edit and send.' },
    { section: 'memory', key: 'memoryEnabled', label: 'Recall scene memory', description: 'Include pinned journal entries, established facts and unresolved goals.' },
    { section: 'memory', key: 'autoMemory', label: 'Capture completed scene beats', description: 'Dynamic replies may update confirmed facts, goals and relationships.' },
    { section: 'presentation', key: 'showSpeakerLabels', label: 'Keep speaker labels', description: 'Ensemble replies always retain attribution for clarity.' },
    { section: 'presentation', key: 'props', label: 'Scene props', description: 'Letters, notes and objects can attach to a reply.' },
    { section: 'presentation', key: 'showAvatars', label: 'Message avatars', description: 'Show character and persona portraits beside their messages.' },
    { section: 'presentation', key: 'voicePlayback', label: 'Voice playback', description: 'Allow playback in this scene when voice output is enabled in app settings.' },
    { section: 'advanced', key: 'autoMode', label: 'Optional NPC continuation', description: 'After your next turn, a group may continue briefly. Typing pauses it.' }
  ];
  const numbers: Array<{ section: string; key: keyof RoleplaySettings; label: string; min: number; max: number; step?: number; nullable?: boolean }> = [
    { section: 'scene', key: 'maxExchangeLines', label: 'Maximum NPC contributions per response', min: 1, max: 8 },
    { section: 'decisions', key: 'surprise', label: 'Scene decision frequency (%)', min: 0, max: 100 },
    { section: 'decisions', key: 'twistCooldown', label: 'Repeat cooldown (turns)', min: 0, max: 20 },
    { section: 'suggestions', key: 'choiceMin', label: 'Minimum suggestions', min: 1, max: 6 },
    { section: 'suggestions', key: 'choiceMax', label: 'Maximum suggestions', min: 1, max: 6 },
    { section: 'memory', key: 'memoryBudget', label: 'Memory budget (approximate tokens)', min: 100, max: 4000, step: 100 },
    { section: 'advanced', key: 'choiceTimerSeconds', label: 'Suggestion timer (seconds; empty = off)', min: 0, max: 600, nullable: true },
    { section: 'advanced', key: 'autoModeMaxTurns', label: 'NPC continuation limit', min: 1, max: 12 },
    { section: 'advanced', key: 'autoModeDelayMs', label: 'NPC continuation delay (ms)', min: 1000, max: 20000, step: 1000 },
    { section: 'advanced', key: 'temperature', label: 'Temperature (empty = model default)', min: 0, max: 2, step: 0.05, nullable: true },
    { section: 'advanced', key: 'topP', label: 'Top P (empty = model default)', min: 0, max: 1, step: 0.05, nullable: true },
    { section: 'advanced', key: 'maxTokens', label: 'Output tokens (empty = model default)', min: 0, max: 32000, nullable: true }
  ];
  const label = (text: string) => text === 'mention' ? '@ mention' : text === 'automatic' ? 'Partial names too' : text === 'sfw' ? 'General audience' : text[0].toUpperCase() + text.slice(1);
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
    const preset = roleplayPreferences.save(presetName || 'My preset', settings);
    selectedPreset = preset.id;
    presetName = '';
  }
  function exportPreset() {
    const blob = new Blob([JSON.stringify({ version: 1, name: presetName || 'Roleplay preset', settings: presetSettings(settings) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'roleplay-preset.json'; anchor.click();
    URL.revokeObjectURL(url);
  }
  async function importPreset(event: Event) {
    const element = event.currentTarget as HTMLInputElement;
    const file = element.files?.[0]; element.value = '';
    if (!file) return;
    try {
      if (file.size > 128000) throw new Error('Preset is too large.');
      const parsed = JSON.parse(await file.text());
      if (parsed.version !== 1 || !parsed.settings || typeof parsed.settings !== 'object' || Array.isArray(parsed.settings)) throw new Error('Choose a valid Roleplay preset.');
      const preset = roleplayPreferences.save(typeof parsed.name === 'string' ? parsed.name : 'Imported preset', parsed.settings);
      applyPreset(preset.id);
    } catch (error) { toastStore.error(error instanceof Error ? error.message : 'Could not import preset.'); }
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center gap-2">
    <div class="min-w-40 flex-1"><Select variant="surface" value={selectedPreset} options={[{ value: '', label: 'Custom settings' }, ...roleplayPreferences.presets.map((preset) => ({ value: preset.id, label: preset.name }))]} aria-label="Roleplay preset" onchange={applyPreset} /></div>
    <button type="button" class="aui-btn aui-btn-ghost" onclick={reset}>Reset overrides</button>
  </div>
  <div class="overflow-x-auto py-1">
    <SegmentedControl value={section} options={tabs.map(([value, label]) => ({ value, label }))} label="Settings sections" variant="tabs" class="whitespace-nowrap" onchange={(value) => (section = value)} />
  </div>
  <div class="grid gap-4 sm:grid-cols-2">
    {#each selects.filter((field) => field.section === section) as field (field.key)}
      <div class="space-y-1.5"><span class="text-xs text-muted-foreground">{field.label}</span>
        <Select variant="surface" value={String(settings[field.key] ?? '')} options={field.options.map((option) => ({ value: option, label: label(option) }))} aria-label={field.label} onchange={(next) => set(field.key, next)} />
      </div>
    {/each}
    {#each numbers.filter((field) => field.section === section) as field (field.key)}
      <label class="space-y-1.5"><span class="text-xs text-muted-foreground">{field.label}</span>
        <input class="aui-input" type="number" min={field.min} max={field.max} step={field.step ?? 1} value={settings[field.key] as number ?? ''} oninput={(event) => set(field.key, event.currentTarget.value === '' && field.nullable ? null : Number(event.currentTarget.value))} />
      </label>
    {/each}
  </div>
  {#each toggles.filter((field) => field.section === section) as field (field.key)}
    <div class="flex items-center justify-between gap-4"><div><div class="text-sm text-foreground">{field.label}</div><p class="text-xs text-muted-foreground">{field.description}</p></div>
      <Switch checked={!!settings[field.key]} aria-label={field.label} onchange={(next) => set(field.key, next)} />
    </div>
  {/each}
  {#if section === 'conversation'}
    <p class="text-xs text-muted-foreground">Chat is spoken conversation without narration. Narrative places narrator passages between character replies. Dynamic adds only the scene decisions you enable. Reply style applies to Narrative and Dynamic.</p>
    <label class="block space-y-1.5"><span class="text-xs text-muted-foreground">Genre / tone</span><input class="aui-input" value={settings.genre ?? ''} placeholder="Modern slice of life, cozy fantasy…" oninput={(event) => set('genre', event.currentTarget.value)} /></label>
    <label class="block space-y-1.5"><span class="text-xs text-muted-foreground">Voice, style and author instructions</span><textarea class="aui-input min-h-24 resize-y" value={settings.authorNote ?? ''} oninput={(event) => set('authorNote', event.currentTarget.value)}></textarea></label>
  {:else if section === 'decisions'}
    <p class="text-xs text-muted-foreground">Dynamic mode samples only plausible directions. Set a weight to 0 to disable it. Established facts and player-authored actions remain stable.</p>
    <div class="grid gap-3 sm:grid-cols-2">
      {#each Object.entries(DECISION_DIRECTIONS) as [key, description]}
        <label class="space-y-1"><span class="text-xs text-muted-foreground" title={description}>{label(key)} weight</span><input class="aui-input" type="number" min="0" max="100" value={settings.decisionWeights?.[key] ?? 0} oninput={(event) => set('decisionWeights', { ...settings.decisionWeights, [key]: Number(event.currentTarget.value) })} /></label>
      {/each}
      {#each ['success', 'cost', 'setback'] as key}
        <label class="space-y-1"><span class="text-xs text-muted-foreground">{label(key)} outcome weight</span><input class="aui-input" type="number" min="0" max="100" value={settings.outcomeWeights?.[key as 'success' | 'cost' | 'setback'] ?? 0} oninput={(event) => set('outcomeWeights', { ...settings.outcomeWeights, [key]: Number(event.currentTarget.value) })} /></label>
      {/each}
    </div>
  {/if}
  <details class="text-xs text-muted-foreground">
    <summary class="cursor-pointer py-2">Presets and defaults</summary>
    <div class="space-y-2 pt-2">
      <input class="aui-input" aria-label="Preset name" placeholder="Name your preset" bind:value={presetName} />
      <div class="flex flex-wrap gap-2">
        <button type="button" class="aui-btn aui-btn-ghost" onclick={savePreset}>Save as new preset</button>
        <button type="button" class="aui-btn aui-btn-ghost" onclick={exportPreset}>Export</button>
        <button type="button" class="aui-btn aui-btn-ghost" onclick={() => importInput.click()}>Import</button>
        {#if roleplayPreferences.saved.some((entry) => entry.id === selectedPreset)}<button type="button" class="aui-btn aui-btn-ghost" onclick={() => { roleplayPreferences.remove(selectedPreset); selectedPreset = ''; }}>Delete preset</button>{/if}
        <button type="button" class="aui-btn aui-btn-ghost" onclick={() => { roleplayPreferences.setDefaults(settings); toastStore.info('Defaults saved for new conversations.'); }}>Use as my defaults</button>
        <button type="button" class="aui-btn aui-btn-ghost" onclick={() => roleplayPreferences.resetDefaults()}>Reset my defaults</button>
      </div>
      <input class="hidden" type="file" accept="application/json,.json" bind:this={importInput} onchange={importPreset} />
      <p>Values inherit from your defaults and the world, then scene overrides. Reset overrides restores inherited values.</p>
    </div>
  </details>
</div>
