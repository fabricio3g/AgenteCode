// Slash commands in the composer: typing "/" lists them, typing more
// filters them, Tab completes the word and Enter runs it.

export interface SlashCommand {
  name: string;
  /** Other words that find it (e.g. "auto" for full-auto mode). */
  aliases?: string[];
}

/** The query while the composer holds only "/word" (no spaces yet); else null. */
export function slashQuery(text: string): string | null {
  const match = text.match(/^\/([\w-]*)$/);
  return match ? match[1].toLowerCase() : null;
}

/** Commands for a query, prefix matches first, then matches anywhere in the name. */
export function matchSlashCommands<T extends SlashCommand>(commands: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  if (!q) return [...commands];
  const words = (command: T) => [command.name, ...(command.aliases ?? [])];
  const prefix = commands.filter((command) => words(command).some((word) => word.startsWith(q)));
  const inside = commands.filter((command) => !prefix.includes(command) && words(command).some((word) => word.includes(q)));
  return [...prefix, ...inside];
}

/** The command a submitted text names exactly ("/compact", "/compact "), if any. */
export function exactSlashCommand<T extends SlashCommand>(commands: readonly T[], text: string): T | null {
  const match = text.trim().match(/^\/([\w-]+)$/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  return commands.find((command) => command.name === name || command.aliases?.includes(name)) ?? null;
}
