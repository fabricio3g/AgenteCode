export type UnknownRecord = Record<string, unknown>;

export type ProviderConfig = {
  api_key?: string;
  has_api_key?: boolean;
  [key: string]: unknown;
};

export type AppConfigLike = {
  llm?: { providers?: Record<string, ProviderConfig> };
  search?: { providers?: Record<string, ProviderConfig> };
  [key: string]: unknown;
};

export type ErrorMessageFn = (err: unknown) => string;
