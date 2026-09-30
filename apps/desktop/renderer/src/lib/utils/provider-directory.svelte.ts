// The provider directory: the Rust core's TOML specs
// (crates/agente-core/providers/*.toml), fetched once through the daemon
// (`providers.list`) — the same list Agente Code's TUI offers. Reactive, so
// anything derived from it redraws when it arrives.

import { invoke, isElectron } from '$lib/services/bridge';

export type CloudProviderMeta = {
  id: string;
  label: string;
  /** The OpenAI chat-completions endpoint Desktop talks to. */
  defaultBaseUrl: string;
  group: 'cloud' | 'local';
  /** Where to create an API key; local servers need none. */
  keyUrl?: string;
  docsUrl?: string;
};

/** A spec as the core sends it. */
type ProviderSpec = {
  id: string;
  name: string;
  group: 'cloud' | 'local';
  base_url: string;
  api_format: string;
  key_url?: string | null;
  docs_url?: string | null;
  openai_compatible_url?: string | null;
};

/**
 * Specs Desktop does not list as providers: the local llama.cpp server has its
 * own "On this computer" section.
 */
const OWN_SECTION = new Set(['llamacpp']);

/** Display names without the "(local)" the TUI's flat list needs. */
function label(spec: ProviderSpec): string {
  return spec.name.replace(/\s*\(local\)$/i, '');
}

export function metaFromSpec(spec: ProviderSpec): CloudProviderMeta | null {
  if (OWN_SECTION.has(spec.id)) return null;
  // Desktop chat speaks OpenAI chat completions only.
  const openai = spec.api_format === 'openai' || spec.api_format === 'responses';
  const baseUrl = openai ? spec.base_url : spec.openai_compatible_url;
  if (!baseUrl) return null;
  return {
    id: spec.id,
    label: label(spec),
    // A custom endpoint always carries its own address.
    defaultBaseUrl: spec.id === 'custom' ? '' : baseUrl,
    group: spec.group,
    ...(spec.key_url ? { keyUrl: spec.key_url } : {}),
    ...(spec.docs_url ? { docsUrl: spec.docs_url } : {})
  };
}

export const providerDirectory = $state({ providers: [] as CloudProviderMeta[], loaded: false });

let loading: Promise<void> | null = null;

/** Fetch the directory once (again after a failure). */
export function loadProviderDirectory(): Promise<void> {
  // Outside Electron there is no daemon to ask; the directory stays empty.
  if (!isElectron()) return Promise.resolve();
  loading ??= invoke<ProviderSpec[]>('list_provider_specs')
    .then((specs) => {
      providerDirectory.providers = (specs ?? []).map(metaFromSpec).filter((m): m is CloudProviderMeta => m !== null);
      providerDirectory.loaded = true;
    })
    .catch((error: unknown) => {
      loading = null;
      console.warn(`[providers] directory unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
  return loading;
}
