/** Additive policy metadata resolved by the Rust core. */
export interface ModelTransport {
  ready: boolean;
  api_format: string | null;
  base_url: string | null;
  cache_control: boolean | null;
  error: string | null;
  policy?: Record<string, unknown> | null;
}

function usesCoreEndpoint(baseUrl: string, transport?: ModelTransport): boolean {
  return !!transport?.base_url
    && transport.base_url.replace(/\/+$/, '') === baseUrl.replace(/\/+$/, '');
}

/** Preserve provider defaults and overrides, including the session cache key. */
export function providerTransportPolicy(baseUrl: string, transport?: ModelTransport): Record<string, unknown> | undefined {
  return usesCoreEndpoint(baseUrl, transport) ? transport?.policy ?? undefined : undefined;
}

/** Carry the core's policy into a Desktop alias of the same endpoint. */
export function modelTransportConfig(baseUrl: string, defaultFormat: unknown, transport?: ModelTransport): Record<string, unknown> {
  const usesCore = usesCoreEndpoint(baseUrl, transport);
  if (usesCore && transport?.error) throw new Error(transport.error);
  const apiFormat = usesCore ? transport?.api_format : defaultFormat;
  return {
    ...(apiFormat ? { provider: { api_format: apiFormat } } : {}),
    ...(usesCore && typeof transport?.cache_control === 'boolean'
      ? { options: { cache_control: transport.cache_control } } : {}),
  };
}
