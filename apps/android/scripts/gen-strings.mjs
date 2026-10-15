#!/usr/bin/env node
/**
 * Generates the phone's interface strings from the desktop's own copy, so the
 * two surfaces cannot word the same action differently — and so the phone stops
 * being an English-only app in a product that ships seven languages.
 *
 * Sources (never edited by hand):
 *   apps/desktop/renderer/src/lib/copy/en.ts         shared UI copy, English
 *   apps/desktop/renderer/src/lib/copy/locales.ts    its six translations
 *   apps/desktop/renderer/src/lib/locales/<tag>.json settings and menu copy
 *
 * Output: app/src/main/res/values{,-es,-pt-rBR,-fr,-de,-ja,-zh}/copy.xml
 * Phone-only wording (the Code landing's honest empty state, the vault note)
 * lives in `strings.xml` next to it and is never overwritten by this script.
 *
 * Usage:
 *   node apps/android/scripts/gen-strings.mjs           write the resources
 *   node apps/android/scripts/gen-strings.mjs --check   fail if any is stale
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const COPY_DIR = join(repo, 'apps/desktop/renderer/src/lib/copy');
const JSON_DIR = join(repo, 'apps/desktop/renderer/src/lib/locales');
const RES = join(repo, 'apps/android/app/src/main/res');

const { COPY_EN } = await import(join(COPY_DIR, 'en.ts'));
const { COPY_OVERRIDES, SAY_STRINGS } = await import(join(COPY_DIR, 'locales.ts'));

/** Desktop locale tag → Android resource qualifier. */
const LOCALES = [
  ['en', 'values'],
  ['es', 'values-es'],
  ['pt-BR', 'values-pt-rBR'],
  ['fr', 'values-fr'],
  ['de', 'values-de'],
  ['ja', 'values-ja'],
  ['zh', 'values-zh']
];

/**
 * The quantities each locale's CLDR rules require (Android's own plural rules,
 * and the reason `MissingQuantity` fails the build when one is left out). The
 * desktop's `say` strings carry two forms, so `many` takes the plural one.
 */
const QUANTITIES = {
  en: ['one', 'other'],
  es: ['one', 'many', 'other'],
  'pt-BR': ['one', 'many', 'other'],
  fr: ['one', 'many', 'other'],
  de: ['one', 'other'],
  ja: ['other'],
  zh: ['other']
};

/**
 * The phone's copy, one line per string: resource name, where it comes from,
 * and its path there. Nothing is invented here — a new line either names an
 * existing desktop string or it belongs in the hand-written `strings.xml`.
 */
const STRINGS = [
  // Spaces and the destination strip.
  ['space_home', 'copy', 'spaces.home'],
  ['space_code', 'copy', 'spaces.code'],
  ['space_roleplay', 'copy', 'spaces.roleplay'],
  // History (the sidebar's own copy lives in the locale JSON).
  ['history_new_chat', 'json', 'sidebar.newChat'],
  ['history_search', 'json', 'sidebar.searchPlaceholder'],
  ['history_today', 'json', 'sidebar.today'],
  ['history_yesterday', 'json', 'sidebar.yesterday'],
  ['history_this_week', 'json', 'sidebar.thisWeek'],
  ['history_older', 'json', 'sidebar.older'],
  ['history_empty', 'json', 'sidebar.noConversations'],
  ['history_empty_hint', 'json', 'sidebar.emptyHint'],
  // The search modal, the desktop's `ChatSearchModal`.
  ['search_placeholder', 'json', 'search.placeholderChats'],
  ['search_placeholder_code', 'json', 'search.placeholderCode'],
  ['search_matches', 'json', 'search.matches'],
  ['search_recent', 'json', 'search.recent'],
  ['search_no_matches', 'json', 'search.noMatches'],
  ['search_no_matches_hint', 'json', 'search.noMatchesHint'],
  ['search_empty', 'json', 'search.empty'],
  ['search_empty_hint', 'json', 'search.emptyHint'],
  ['search_clear', 'json', 'search.clear'],
  ['search_days_ago', 'json', 'search.daysAgo'],
  // The empty state: one greeting and the five starters, in order.
  ['home_greeting', 'copy', 'emptyState.greeting'],
  ['starter_weather_label', 'copy', 'emptyState.suggestions.0.label'],
  ['starter_weather_prompt', 'copy', 'emptyState.suggestions.0.prompt'],
  ['starter_code_label', 'copy', 'emptyState.suggestions.1.label'],
  ['starter_code_prompt', 'copy', 'emptyState.suggestions.1.prompt'],
  ['starter_write_label', 'copy', 'emptyState.suggestions.2.label'],
  ['starter_write_prompt', 'copy', 'emptyState.suggestions.2.prompt'],
  ['starter_brainstorm_label', 'copy', 'emptyState.suggestions.4.label'],
  ['starter_brainstorm_prompt', 'copy', 'emptyState.suggestions.4.prompt'],
  // Composer and thread.
  ['composer_placeholder', 'copy', 'composer.placeholder'],
  ['composer_send', 'copy', 'composer.send'],
  ['composer_stop', 'copy', 'composer.stop'],
  ['thread_jump_to_latest', 'copy', 'thread.jumpToLatest'],
  ['thread_thinking', 'json', 'chat.thinking'],
  ['thread_generation_failed', 'copy', 'thread.generationFailed'],
  ['status_working', 'copy', 'status.working'],
  ['status_loading', 'copy', 'status.loading'],
  ['option_auto', 'json', 'composer.thinking.level.auto'],
  ['character_name_required', 'json', 'roleplay.character.nameRequired'],
  // Actions.
  ['action_copy', 'copy', 'actions.copy'],
  ['action_retry', 'copy', 'actions.retry'],
  ['action_edit', 'copy', 'actions.edit'],
  ['action_save', 'copy', 'actions.save'],
  ['action_more', 'copy', 'actions.more'],
  ['action_back', 'copy', 'actions.back'],
  // Roleplay.
  ['roleplay_characters', 'copy', 'roleplay.characters'],
  ['roleplay_new_character', 'copy', 'roleplay.newCharacter'],
  ['roleplay_pick_character', 'copy', 'roleplay.pickCharacter'],
  ['roleplay_pick_hint', 'copy', 'roleplay.pickCharacterHint'],
  // A scene, its persona and a character's fields.
  ['roleplay_persona', 'json', 'roleplay.header.persona'],
  ['roleplay_scene_placeholder', 'json', 'roleplay.placeholder.scene'],
  ['character_name', 'json', 'roleplay.character.name'],
  ['character_name_placeholder', 'json', 'roleplay.character.namePlaceholder'],
  ['character_notes', 'json', 'roleplay.character.personality'],
  ['character_notes_hint', 'json', 'roleplay.character.personalityHint'],
  ['character_opening', 'json', 'roleplay.character.openingFirst'],
  ['character_opening_placeholder', 'json', 'roleplay.character.openingPlaceholder'],
  ['character_no_opening', 'json', 'roleplay.setup.noOpening'],
  ['persona_name', 'json', 'roleplay.persona.name'],
  // Settings (the desktop keeps this half of its copy in the locale JSON).
  ['settings_title', 'json', 'settings.title'],
  ['settings_general', 'json', 'settings.general'],
  ['settings_save', 'json', 'settings.save'],
  ['settings_appearance', 'json', 'generalSettings.appearance'],
  ['settings_theme_desc', 'json', 'generalSettings.themeDesc'],
  ['settings_light', 'json', 'generalSettings.light'],
  ['settings_dark', 'json', 'generalSettings.dark'],
  ['settings_enter_name', 'json', 'generalSettings.enterYourName'],
  ['providers_api_key', 'json', 'providers.apiKey'],
  ['providers_key_placeholder', 'json', 'providers.keyPlaceholder'],
  ['providers_key_saved', 'json', 'providers.keySaved'],
  ['providers_models', 'json', 'providers.models'],
  ['providers_models_hint', 'json', 'providers.modelsHint'],
  ['providers_refresh_models', 'json', 'providers.refreshModels'],
  ['providers_needs_key', 'json', 'providers.needsKey'],
  ['providers_no_models_key', 'json', 'providers.noModelsNeedKey'],
  ['model_picker_title', 'json', 'modelPicker.title'],
  ['model_picker_search', 'json', 'modelPicker.searchPlaceholder'],
  ['model_configure_provider', 'copy', 'model.configureProvider']
];

const read = (object, path) => path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);

/**
 * Counted nouns, from the desktop's own `say` strings: `SAY_STRINGS[locale]
 * .nouns[key]` is `[one, other]`, which is exactly Android's plural shape.
 */
const PLURALS = [
  ['search_count', 'conversation']
];

/** English with the locale's keys laid over it, exactly as the app merges it. */
function mergedCopy(tag) {
  const override = COPY_OVERRIDES[tag];
  if (!override) return COPY_EN;
  const merge = (base, over) => {
    if (over === undefined) return base;
    if (typeof base !== 'object' || base === null || Array.isArray(base) || typeof over !== 'object' || over === null || Array.isArray(over)) return over;
    const out = {};
    for (const key of Object.keys(base)) out[key] = merge(base[key], over[key]);
    return out;
  };
  return merge(COPY_EN, override);
}

const jsonFor = (tag) => {
  const file = join(JSON_DIR, `${tag}.json`);
  if (!existsSync(file)) throw new Error(`no ${tag}.json in lib/locales`);
  return JSON.parse(readFileSync(file, 'utf8'));
};

/** Android string XML: the five characters that must not reach the parser. */
function escape(text) {
  return String(text)
    // One ellipsis glyph, never three dots — the desktop's own copy rule
    // (see copy/en.ts); a few of its locale JSON files still spell it out.
    .replace(/\.\.\./g, '\u2026')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/^([@?])/, '\\$1');
}

function resourcesFor(tag) {
  const copy = mergedCopy(tag);
  const json = jsonFor(tag);
  const lines = STRINGS.map(([name, source, path]) => {
    const value = source === 'copy' ? read(copy, path) : read(json, path);
    if (value === undefined) throw new Error(`${tag}: no \`${path}\` in ${source === 'copy' ? 'copy' : 'locales'}`);
    if (typeof value !== 'string') throw new Error(`${tag}: \`${path}\` is not a string`);
    return `    <string name="${name}">${escape(value)}</string>`;
  });
  const plurals = PLURALS.map(([name, noun]) => {
    const forms = SAY_STRINGS[tag]?.nouns?.[noun];
    if (!forms) throw new Error(`${tag}: no \`${noun}\` noun in SAY_STRINGS`);
    const [one, other] = forms;
    const quantities = QUANTITIES[tag];
    if (!quantities) throw new Error(`${tag}: no plural quantities declared`);
    const items = quantities.map((quantity) =>
      `        <item quantity="${quantity}">%1$d ${escape(quantity === 'one' ? one : other)}</item>`
    );
    return `    <plurals name="${name}">\n${items.join('\n')}\n    </plurals>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by apps/android/scripts/gen-strings.mjs from the desktop's copy
     (renderer/src/lib/copy and renderer/src/lib/locales). Do not edit. -->
<resources>
${lines.concat(plurals).join('\n')}
</resources>
`;
}

const check = process.argv.includes('--check');
let stale = 0;
for (const [tag, qualifier] of LOCALES) {
  const file = join(RES, qualifier, 'copy.xml');
  const generated = resourcesFor(tag);
  if (check) {
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (current !== generated) {
      console.error(`stale: ${file.replace(`${repo}/`, '')}`);
      stale += 1;
    }
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, generated);
}
if (check) {
  if (stale) {
    console.error(`\n${stale} resource file(s) stale. Run: node apps/android/scripts/gen-strings.mjs`);
    process.exit(1);
  }
  console.log(`${LOCALES.length} locale files are current.`);
} else {
  console.log(`Wrote ${LOCALES.length} locale files (${STRINGS.length} strings each).`);
}
