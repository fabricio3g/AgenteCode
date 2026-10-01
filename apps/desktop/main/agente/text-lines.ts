// How many lines a file's text holds (a trailing newline ends the last one).
// Shared by the Changes pane's counts and the edit rows' +/− stats.

export function lineCount(text: string | null | undefined): number {
  if (!text) return 0;
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}
