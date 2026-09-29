// The provider and model the app is using right now, resolved from the
// config the same way the chat pipeline does. Code chats and bots start
// their runs with it.

import { loadAppConfig } from '$lib/utils/storage';

export async function currentProviderModel(): Promise<{ provider: string; model: string }> {
  const llm = (await loadAppConfig()).llm;
  if (llm?.backend_mode === 'local' || !llm?.provider) return { provider: 'local', model: llm?.local?.model || '' };
  return { provider: llm.provider, model: llm.providers?.[llm.provider]?.model || '' };
}
