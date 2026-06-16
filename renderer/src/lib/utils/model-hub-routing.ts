export type ModelHubSection =
  | 'models'
  | 'explore'
  | 'general'
  | 'search'
  | 'hardware'
  | 'providers'
  | 'runtime'
  | 'voices'
  | 'whisper';

const MODEL_HUB_SECTIONS = new Set<ModelHubSection>([
  'models',
  'explore',
  'general',
  'search',
  'hardware',
  'providers',
  'runtime',
  'voices',
  'whisper'
]);

export function resolveModelHubSection(section?: string | null): ModelHubSection {
  if (!section) return 'models';
  if (section === 'settings') return 'general';
  if (section === 'explore') return 'models';
  return MODEL_HUB_SECTIONS.has(section as ModelHubSection) ? section as ModelHubSection : 'models';
}

export function legacyFlagToModelHubSection(flag: 'settingsOpen' | 'runtimeManagerOpen'): ModelHubSection {
  return flag === 'settingsOpen' ? 'general' : 'runtime';
}
