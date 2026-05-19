export type ModelHubSection =
  | 'models'
  | 'explore'
  | 'providers'
  | 'runtime'
  | 'settings'
  | 'voices'
  | 'whisper'
  | 'extensions';

const MODEL_HUB_SECTIONS = new Set<ModelHubSection>([
  'models',
  'explore',
  'providers',
  'runtime',
  'settings',
  'voices',
  'whisper',
  'extensions'
]);

export function resolveModelHubSection(section?: string | null): ModelHubSection {
  if (!section) return 'models';
  if (section === 'search') return 'settings';
  return MODEL_HUB_SECTIONS.has(section as ModelHubSection) ? section as ModelHubSection : 'models';
}

export function legacyFlagToModelHubSection(flag: 'settingsOpen' | 'runtimeManagerOpen'): ModelHubSection {
  return flag === 'settingsOpen' ? 'settings' : 'runtime';
}
