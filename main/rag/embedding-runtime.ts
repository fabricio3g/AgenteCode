import { getEmbeddingStatus, startEmbeddingServer } from '../llm-runner.ts';
import { loadConfig } from '../config.ts';

export async function ensureRagEmbeddingRuntime() {
  const status = getEmbeddingStatus();
  if (status.state === 'ready' || status.state === 'starting') return;

  const cfg = loadConfig();
  const embeddingCfg = cfg?.llm?.local;
  if (!embeddingCfg?.embedding_model_path) return;

  try {
    await startEmbeddingServer(embeddingCfg, null);
  } catch {
    // Best-effort: embedding operations will fall back gracefully
  }
}
