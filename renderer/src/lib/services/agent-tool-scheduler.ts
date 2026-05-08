type ToolCallLike = { name: string };

const DEPENDENT_TOOLS: Set<string> = new Set(['preview_project']);

export function groupParallelAndSequential<T extends ToolCallLike>(toolCalls: T[]): T[][] {
  const groups: T[][] = [];
  let currentBatch: T[] = [];

  for (const toolCall of toolCalls) {
    if (DEPENDENT_TOOLS.has(toolCall.name)) {
      if (currentBatch.length) groups.push(currentBatch);
      groups.push([toolCall]);
      currentBatch = [];
    } else {
      currentBatch.push(toolCall);
    }
  }

  if (currentBatch.length) groups.push(currentBatch);
  return groups.length ? groups : [toolCalls];
}
