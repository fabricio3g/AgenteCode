export type SettingsSection = 'general' | 'providers' | 'search' | 'local' | 'voice';

export type ModelHubSection =
  | 'models'
  | 'explore'
  | 'library'
  | SettingsSection;

export type ModelHubTab = 'discover' | 'library' | 'active';

export type ModelHubRoute = {
  section: Exclude<ModelHubSection, 'explore' | 'library'>;
  modelTab?: ModelHubTab;
};

const MODEL_HUB_SECTIONS = new Set<ModelHubSection>([
  'models',
  'explore',
  'library',
  'general',
  'providers',
  'search',
  'local',
  'voice',
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
  return { section: resolved as Exclude<ModelHubSection, 'explore' | 'library'> };
}
