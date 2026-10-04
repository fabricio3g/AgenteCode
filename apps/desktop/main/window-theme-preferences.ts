import fs from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseWindowTheme, type WindowTheme } from '../shared/window-theme.ts';

/** Tiny native mirror of the renderer preference, so even the blank window matches. */
export class WindowThemePreferences {
  theme: WindowTheme = 'dark';
  private saved: WindowTheme | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();

  constructor(private file: string) {
    try { this.saved = parseWindowTheme(JSON.parse(fs.readFileSync(file, 'utf8')).theme); } catch { /* First launch or corrupt preference. */ }
    this.theme = this.saved ?? 'dark';
  }

  update(theme: WindowTheme): void {
    this.theme = theme;
    if (this.saved === theme) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(error => console.warn('[window theme]', error)); }, 200);
    this.timer.unref();
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.writing = this.writing.catch(() => {}).then(async () => {
      const theme = this.theme;
      if (this.saved === theme) return;
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify({ theme }));
      await rename(`${this.file}.tmp`, this.file);
      this.saved = theme;
    });
    return this.writing;
  }
}
