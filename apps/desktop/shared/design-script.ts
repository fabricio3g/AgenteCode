/**
 * Free-form Blender scripting, kept out of the scene schema on purpose: particles,
 * cloth, geometry nodes and shaders cannot be enumerated, so the agent writes
 * Blender Python and the fixed head/tail around it owns the outputs.
 *
 * This module is pure (no Electron imports) so the screening rules are unit-tested.
 */

/** Largest accepted program. Big enough for a real scene, small enough to stay reviewable. */
export const SCRIPT_LIMIT = 64 * 1024;

/** Modules a scene program never needs, and that would reach outside the job directory. */
const FORBIDDEN = [
  { pattern: /bpy\.ops\.render\.render\s*\(/, reason: 'renders outside the hardware-managed tail; leave rendering to the host' },
  { pattern: /\bimport\s+(subprocess|socket|shlex|pty|ctypes|multiprocessing|urllib|http|requests|ftplib|telnetlib|webbrowser|pickle)\b/, reason: 'imports a network or process module' },
  { pattern: /\bfrom\s+(subprocess|socket|pty|ctypes|multiprocessing|urllib|http|requests|ftplib|telnetlib|webbrowser|pickle)\s+import\b/, reason: 'imports a network or process module' },
  { pattern: /\b(os\.system|os\.popen|os\.exec|os\.spawn|subprocess\.|socket\.|pty\.|ctypes\.)\b/, reason: 'runs another program or opens a socket' },
  { pattern: /(^|[^\w.])(eval|exec|compile)\s*\(/m, reason: 'evaluates code it was handed' },
  { pattern: /__import__\s*\(/, reason: 'imports a module by name' },
  { pattern: /bpy\.ops\.wm\.(open_mainfile|save_as_mainfile)\s*\([^)]*filepath\s*=\s*['"]/, reason: 'writes outside the job directory' },
  { pattern: /bpy\.ops\.wm\.url_open\s*\(/, reason: 'opens a URL' }
];

export interface ScriptCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Reject what a modelling program cannot need: processes, sockets, dynamic code.
 * This is a guard rail, not a sandbox — the caller still runs with approvals and
 * `--disable-autoexec`, and the job directory is the only writable place.
 */
export function screenScript(python: unknown): ScriptCheck {
  if (typeof python !== 'string' || !python.trim()) return { ok: false, reason: 'Write the Blender Python to run.' };
  if (Buffer.byteLength(python) > SCRIPT_LIMIT) return { ok: false, reason: `Program exceeds ${SCRIPT_LIMIT / 1024} KB.` };
  for (const rule of FORBIDDEN) {
    if (rule.pattern.test(python)) return { ok: false, reason: `Program ${rule.reason}. Modelling code does not need it.` };
  }
  return { ok: true };
}
