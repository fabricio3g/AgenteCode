// ── Sampling params (main ⇄ renderer) ──────────────────────────────────
// Both processes build OpenAI-compatible request bodies from the same
// stored provider config, so both need the same "only send what is
// actually configured" rule. Keeping it here stops the two copies from
// disagreeing about which knobs survive.

/** The sampling knobs as they sit in config — untyped, straight off disk/localStorage. */
export interface SamplingConfig {
  temperature?: unknown;
  max_tokens?: unknown;
  top_p?: unknown;
}

/**
 * Pick the sampling params worth sending: numeric temperature/top_p, and a
 * truthy max_tokens. Anything unset or non-numeric is omitted so the
 * provider applies its own default.
 */
export function samplingParams(config: SamplingConfig): Record<string, unknown> {
  return {
    ...(Number.isFinite(config.temperature) ? { temperature: config.temperature } : {}),
    ...(config.max_tokens ? { max_tokens: config.max_tokens } : {}),
    ...(Number.isFinite(config.top_p) ? { top_p: config.top_p } : {})
  };
}
