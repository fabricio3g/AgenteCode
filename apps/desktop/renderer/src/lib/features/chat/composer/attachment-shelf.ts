export interface DraftAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  kind?: string;
  status?: 'ready' | 'processing' | 'error';
  error?: string;
  warning?: string;
  source?: string;
  content?: string;
  thumbnail?: string;
  loadThumbnail?: () => Promise<string | null>;
  loadSource?: () => Promise<string | null>;
  openExternal?: () => Promise<void>;
}

export const SHELF_LIMIT = 3;
