/** Console records translated from Chromium's debugger events. */
export type BrowserConsoleMessage = {
  level: 'log' | 'info' | 'warning' | 'error' | 'debug';
  source: 'console' | 'exception' | 'network';
  text: string;
};

type Params = Record<string, unknown>;
type ExceptionDetails = { text?: string; exception?: { description?: string } };
type ResponseDetails = { status?: number; url?: string };

const LEVELS = new Map<string, BrowserConsoleMessage['level']>([
  ['error', 'error'], ['assert', 'error'], ['warning', 'warning'], ['debug', 'debug'], ['info', 'info']
]);

function argumentText(arg: { value?: unknown; description?: string }): string {
  return arg.value !== undefined ? String(arg.value) : arg.description ?? '';
}

function consoleCall(params: Params): BrowserConsoleMessage {
  const args = (params.args as Array<{ value?: unknown; description?: string }> | undefined) ?? [];
  const type = String(params.type ?? 'log');
  return { level: LEVELS.get(type) ?? 'log', source: 'console', text: args.map(argumentText).join(' ') };
}

function exceptionSummary(details: ExceptionDetails | undefined): string {
  return details?.text ?? 'Uncaught exception';
}

function exceptionText(details: ExceptionDetails | undefined): string {
  return details?.exception?.description ?? exceptionSummary(details);
}

function exceptionThrown(params: Params): BrowserConsoleMessage {
  return { level: 'error', source: 'exception', text: exceptionText(params.exceptionDetails as ExceptionDetails | undefined) };
}

function loadingFailed(params: Params): BrowserConsoleMessage | null {
  if (params.canceled) return null;
  return { level: 'error', source: 'network', text: `${String(params.errorText ?? 'Request failed')} (${String(params.type ?? 'request')})` };
}

function responseText(response: ResponseDetails): string {
  return `HTTP ${response.status} ${response.url ?? ''}`;
}

function responseReceived(params: Params): BrowserConsoleMessage | null {
  const response = params.response as ResponseDetails | undefined;
  if (response?.status && response.status >= 400) {
    return { level: 'error', source: 'network', text: responseText(response) };
  }
  return null;
}

const BUILDERS = new Map<string, (params: Params) => BrowserConsoleMessage | null>([
  ['Runtime.consoleAPICalled', consoleCall],
  ['Runtime.exceptionThrown', exceptionThrown],
  ['Network.loadingFailed', loadingFailed],
  ['Network.responseReceived', responseReceived]
]);

export function debuggerConsoleMessage(method: string, params: Params): BrowserConsoleMessage | null {
  return BUILDERS.get(method)?.(params) ?? null;
}
