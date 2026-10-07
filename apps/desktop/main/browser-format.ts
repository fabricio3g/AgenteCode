// ── Browser text helpers (main-process import path) ────────────────────
// The implementation lives in shared/browser/format.ts so the browser extension
// imports the same code; these re-exports keep the existing main-process import
// paths working.

export * from '../shared/browser/format.ts';
export type { BrowserSnapshot } from '../shared/browser/format.ts';
