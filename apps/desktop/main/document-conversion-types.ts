/** Result contract shared by document readers. No runtime imports. */
export type MarkdownConversion = {
  markdown: string;
  /** Coarse type recorded on the RAG document row. */
  fileType: string;
  /** Set when a format was recognised but yielded nothing useful. */
  warning?: string;
};

