// The provider and model the app is using right now, resolved from the
// config the same way the chat pipeline does. Code chats and bots start
// their runs with it.

import type { AppConfig } from '$lib/types/chat';
import { loadAppConfig } from '$lib/utils/storage';

export async function currentProviderModel(config?: AppConfig): Promise<{ provider: string; model: string }> {
  const llm = (config ?? await loadAppConfig()).llm;
  if (llm?.backend_mode === 'local' || !llm?.provider) return { provider: 'local', model: llm?.local?.model || '' };
  return { provider: llm.provider, model: llm.providers?.[llm.provider]?.model || '' };
}
