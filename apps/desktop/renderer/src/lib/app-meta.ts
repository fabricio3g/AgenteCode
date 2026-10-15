import { APP_NAME } from '$shared/brand';

/** Display name, from the one brand constant. */
export { APP_NAME };
export const APP_SYSTEM_PROMPT_DEFAULT = `You are ${APP_NAME}. Answer clearly and accurately.`;

/** The release, e.g. `0.2.3`; empty outside a Vite build (unit tests). */
export const APP_VERSION = typeof __AGENTE_VERSION__ === 'string' ? __AGENTE_VERSION__ : '';
/** The short commit the build came from; empty when git was not available. */
export const APP_BUILD = typeof __AGENTE_BUILD__ === 'string' ? __AGENTE_BUILD__ : '';

/** `v0.2.3 · a1b2c3d`, the same line the TUI's welcome card carries. */
export function versionLabel(version = APP_VERSION, build = APP_BUILD): string {
  if (!version) return '';
  return build ? `v${version} · ${build}` : `v${version}`;
}
