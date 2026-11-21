/** Normalize any thrown value into a concise message string. */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
