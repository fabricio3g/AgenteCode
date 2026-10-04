import { describe, expect, it } from 'vitest';
import { humanizeProviderError } from './errors';

describe('humanizeProviderError', () => {
  it('turns the missing-key IPC dump into a plain next step', () => {
    expect(
      humanizeProviderError(
        new Error(
          "Error invoking remote method 'fetch_provider_models': Error: No API key configured for ollama. Please add your API key in Settings > LLM Providers."
        )
      )
    ).toBe('No API key for Ollama yet. Add it above, then refresh the list.');
  });

  it('strips the IPC wrapper from other failures', () => {
    expect(humanizeProviderError(new Error("Error invoking remote method 'fetch_provider_models': Error: HTTP 500"))).toBe(
      'The provider had a temporary outage. Please try again in a moment.'
    );
  });

  it('explains timeouts and unreachable providers', () => {
    expect(humanizeProviderError(new Error('Model discovery timed out'))).toBe(
      'Loading the model list took too long. Check the connection and try again.'
    );
    expect(humanizeProviderError(new Error('fetch failed'))).toBe(
      'Could not reach the provider. Check the address and connection, then try again.'
    );
  });

  it('falls back to a plain sentence for empty or machine-shaped errors', () => {
    expect(humanizeProviderError(new Error(''))).toBe('Could not load the model list. Please try again.');
    expect(humanizeProviderError(new Error('{"error":{"code":"bad"}}'))).toBe(
      'Could not load the model list. Please try again.'
    );
  });
});
