// One namespace for both browsers: Firefox's promise-based `browser.*`, or
// Chrome's `chrome.*` (promise-returning since MV3). Typed loosely on purpose —
// the two APIs differ in corners this extension handles explicitly.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ext: any = (globalThis as any).browser ?? (globalThis as any).chrome;

export const isFirefox = typeof (globalThis as any).browser !== 'undefined' && !!ext?.runtime?.getBrowserInfo;
