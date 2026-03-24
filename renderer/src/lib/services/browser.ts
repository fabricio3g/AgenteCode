import { invoke } from './tauri';

export interface BrowserPageInfo {
  url: string;
  title: string;
  text: string;
  links: { text: string; href: string }[];
  inputs: { index: number; kind: string; name: string; placeholder: string }[];
  buttons: { index: number; text: string }[];
}

export function browserNavigate(url: string): Promise<BrowserPageInfo> {
  return invoke<BrowserPageInfo>('browser_navigate', { url });
}

export function browserSnapshot(): Promise<BrowserPageInfo> {
  return invoke<BrowserPageInfo>('browser_snapshot', {});
}

export function browserClick(text: string): Promise<BrowserPageInfo> {
  return invoke<BrowserPageInfo>('browser_click', { text });
}

export function browserTypeText(selector: string, text: string): Promise<string> {
  return invoke<string>('browser_type_text', { selector, text });
}

export function browserEvaluate(script: string): Promise<string> {
  return invoke<string>('browser_evaluate', { script });
}

export function browserScreenshot(): Promise<string> {
  return invoke<string>('browser_screenshot', {});
}

export function browserGetCurrentUrl(): Promise<string> {
  return invoke<string>('browser_get_current_url', {});
}

export function browserClose(): Promise<void> {
  return invoke<void>('browser_close', {});
}

/** Format a BrowserPageInfo into a compact text the LLM can read. */
export function formatPageInfo(page: BrowserPageInfo): string {
  let out = `Page: ${page.title || '(no title)'}\nURL: ${page.url}\n\nContent:\n${page.text}`;

  if (page.links.length) {
    out += '\n\nLinks:\n' + page.links.map((l) => `- [${l.text}](${l.href})`).join('\n');
  }
  if (page.inputs.length) {
    out +=
      '\n\nInput fields:\n' +
      page.inputs
        .map((i) => `- [${i.index}] ${i.kind} "${i.name || i.placeholder || '(unnamed)'}"`)
        .join('\n');
  }
  if (page.buttons.length) {
    out += '\n\nButtons:\n' + page.buttons.map((b) => `- "${b.text}"`).join('\n');
  }
  return out;
}
