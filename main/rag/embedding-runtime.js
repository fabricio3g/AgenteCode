import { getEmbeddingStatus, startEmbeddingServer } from '../llm-runner.js';
import { loadConfig } from '../config.js';

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
