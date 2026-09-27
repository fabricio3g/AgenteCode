export type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
};

export function createLogger(prefix: string): Logger {
  const withPrefix = (args: unknown[]) => [prefix, ...args];
  return {
    info: (...args) => console.log(...withPrefix(args)),
    warn: (...args) => console.warn(...withPrefix(args)),
    error: (...args) => console.error(...withPrefix(args)),
    debug: (...args) => console.debug(...withPrefix(args)),
  };
}
