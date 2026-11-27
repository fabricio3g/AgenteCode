let embeddingStatus: {
  state: string;
  port: number | null;
  model_id: string | null;
  model_path: string | null;
  dimension: number | null;
} = {
  state: 'idle',
  port: null,
  model_id: null,
  model_path: null,
  dimension: null
};

export function setEmbeddingStatus(status: Partial<typeof embeddingStatus>) {
  embeddingStatus = { ...embeddingStatus, ...status };
}

export function getEmbeddingStatus() {
  return { ...embeddingStatus };
}

export function getEmbeddingModelKey(): string {
  return embeddingStatus.model_path || embeddingStatus.model_id || 'default';
}
