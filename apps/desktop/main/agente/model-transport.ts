/** Additive policy metadata resolved by the Rust core. */
export interface ModelTransport {
  ready: boolean;
  api_format: string | null;
  base_url: string | null;
  cache_control: boolean | null;
  error: string | null;
}

/** Carry the core's policy into a Desktop alias of the same endpoint. */
export function modelTransportConfig(baseUrl: string, defaultFormat: unknown, transport?: ModelTransport): Record<string, unknown> {
  const usesCoreEndpoint = !!transport?.base_url
    && transport.base_url.replace(/\/+$/, '') === baseUrl.replace(/\/+$/, '');
  if (usesCoreEndpoint && transport?.error) throw new Error(transport.error);
  const apiFormat = usesCoreEndpoint ? transport?.api_format : defaultFormat;
  return {
    ...(apiFormat ? { provider: { api_format: apiFormat } } : {}),
    ...(usesCoreEndpoint && typeof transport?.cache_control === 'boolean'
      ? { options: { cache_control: transport.cache_control } } : {}),
  };
}
