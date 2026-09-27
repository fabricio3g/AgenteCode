let embeddingStatus: { state: string; port: number | null } = { state: 'idle', port: null };

export function setEmbeddingStatus(status: Partial<typeof embeddingStatus>) {
  embeddingStatus = { ...embeddingStatus, ...status };
}

export function getEmbeddingStatus() {
  return { ...embeddingStatus };
}
