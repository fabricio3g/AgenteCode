/** One tick on the conversation dial. */
export interface TimelineMarker {
  id: string;
  role: 'user' | 'assistant';
  preview: string;
}
