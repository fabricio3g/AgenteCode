import type { RoleplaySettings } from '$lib/types/chat';
import { createId } from '$lib/utils/id';
import { presetSettings, ROLEPLAY_PRESETS } from './roleplay-settings';

interface Preset { id: string; name: string; settings: RoleplaySettings }
const KEY = 'agente.roleplay.preferences';

class RoleplayPreferences {
  defaults = $state<RoleplaySettings>({});
  saved = $state<Preset[]>([]);
  private lastPersona: string | null = null;
  private loaded = false;

  load() {
    if (this.loaded || typeof localStorage === 'undefined') return;
    this.loaded = true;
    try {
      const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      if (stored.defaults && typeof stored.defaults === 'object') this.defaults = presetSettings(stored.defaults);
      if (typeof stored.lastPersona === 'string') this.lastPersona = stored.lastPersona;
      if (Array.isArray(stored.saved)) this.saved = stored.saved.filter((entry: Preset) => typeof entry?.name === 'string' && entry.settings && typeof entry.settings === 'object')
        .slice(0, 50).map((entry: Preset) => ({ id: entry.id || createId('preset'), name: entry.name.slice(0, 80), settings: presetSettings(entry.settings) }));
    } catch { /* A corrupt preference cannot prevent opening a conversation. */ }
  }

  get presets(): Preset[] { return [...ROLEPLAY_PRESETS, ...this.saved]; }

  /** The persona the last scene started with, if it still exists; otherwise none. */
  lastPersonaId(personas: Array<{ id: string }>): string | null {
    this.load();
    return this.lastPersona && personas.some((persona) => persona.id === this.lastPersona) ? this.lastPersona : null;
  }

  noteLastPersona(personaId: string | null | undefined) {
    this.load();
    this.lastPersona = personaId ?? null;
    this.persist();
  }

  save(name: string, settings: RoleplaySettings) {
    const preset = { id: createId('preset'), name: name.trim().slice(0, 80) || 'My preset', settings: presetSettings(settings) };
    this.saved = [...this.saved, preset].slice(-50);
    this.persist();
    return preset;
  }

  remove(id: string) { this.saved = this.saved.filter((entry) => entry.id !== id); this.persist(); }
  setDefaults(settings: RoleplaySettings) { this.defaults = presetSettings(settings); this.persist(); }
  resetDefaults() { this.defaults = {}; this.persist(); }

  private persist() {
    localStorage.setItem(KEY, JSON.stringify({ defaults: this.defaults, saved: this.saved, lastPersona: this.lastPersona }));
  }
}

export const roleplayPreferences = new RoleplayPreferences();
