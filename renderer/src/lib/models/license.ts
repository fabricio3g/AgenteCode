/**
 * How a model's license reads in the model hub. "Open" means permissive with
 * no use restrictions (Apache, MIT, BSD, ISC, CC0) — the licenses Flaxeo Chat
 * prefers and highlights. Everything else keeps its own name.
 */

export type LicenseInfo = { label: string; tone: 'open' | 'restricted' | 'other'; open: boolean };

const OPEN: Array<[RegExp, string]> = [
  [/^apache[-_ ]?2(\.0)?$/i, 'Apache-2.0'],
  [/^mit$/i, 'MIT'],
  [/^bsd[-_ ]?(2|3)[-_ ]?clause|^bsd$/i, 'BSD'],
  [/^isc$/i, 'ISC'],
  [/^cc0([-_ ]?1\.0)?$/i, 'CC0']
];

export function licenseInfo(raw: string | null | undefined): LicenseInfo | null {
  const value = String(raw || '').trim();
  if (!value || /^(unknown|other)$/i.test(value)) return null;
  for (const [pattern, label] of OPEN) {
    if (pattern.test(value)) return { label, tone: 'open', open: true };
  }
  if (/(^|[-_ ])nc([-_ ]|$)|non[-_ ]?commercial|research/i.test(value)) {
    return { label: value, tone: 'restricted', open: false };
  }
  const named: Record<string, string> = { llama2: 'Llama 2', llama3: 'Llama 3', 'llama3.1': 'Llama 3.1', 'llama3.2': 'Llama 3.2', 'llama3.3': 'Llama 3.3', llama4: 'Llama 4', gemma: 'Gemma terms' };
  return { label: named[value.toLowerCase()] ?? value, tone: 'other', open: false };
}
