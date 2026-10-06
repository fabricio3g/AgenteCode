import type { ModelHubTab } from '$lib/types/model-hub';

export type SettingsSection = 'general' | 'providers' | 'search' | 'artifacts' | 'domains' | 'local' | 'voice' | 'accessibility';

export type ModelHubSection =
  | 'models'
  | 'explore'
  | 'library'
  | 'loaded'
  | SettingsSection;

export type ModelHubRoute = {
  section: Exclude<ModelHubSection, 'explore' | 'library' | 'loaded'>;
  modelTab?: ModelHubTab;
};

const MODEL_HUB_SECTIONS = new Set<ModelHubSection>([
  'models',
  'explore',
  'library',
  'loaded',
  'general',
  'providers',
  'search',
  'artifacts',
  'domains',
  'local',
  'voice',
  'accessibility',
]);

export function resolveModelHubSection(section?: string | null): ModelHubSection {
  if (!section) return 'models';
  if (section === 'settings') return 'general';
  if (section === 'hardware' || section === 'runtime') return 'local';
  if (section === 'voices' || section === 'whisper') return 'voice';
  if (section === 'api' || section === 'provider' || section === 'providers-api') return 'providers';
  return MODEL_HUB_SECTIONS.has(section as ModelHubSection) ? section as ModelHubSection : 'models';
}

export function legacyFlagToModelHubSection(flag: 'settingsOpen' | 'runtimeManagerOpen'): ModelHubSection {
  return flag === 'settingsOpen' ? 'general' : 'local';
}

export function resolveModelHubRoute(section?: string | null): ModelHubRoute {
  const resolved = resolveModelHubSection(section);
  if (resolved === 'explore') return { section: 'models', modelTab: 'discover' };
  if (resolved === 'library') return { section: 'models', modelTab: 'library' };
  if (resolved === 'loaded') return { section: 'models', modelTab: 'active' };
  return { section: resolved as Exclude<ModelHubSection, 'explore' | 'library' | 'loaded'> };
}
