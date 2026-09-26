import { describe, expect, it } from 'vitest';
import { licenseInfo } from './license';

describe('licenseInfo', () => {
  it('marks permissive licenses as open', () => {
    for (const raw of ['apache-2.0', 'Apache-2.0', 'mit', 'bsd-3-clause', 'cc0-1.0']) {
      expect(licenseInfo(raw)?.open, raw).toBe(true);
    }
    expect(licenseInfo('apache-2.0')?.label).toBe('Apache-2.0');
  });

  it('flags non-commercial licenses and names custom ones', () => {
    expect(licenseInfo('cc-by-nc-4.0')?.tone).toBe('restricted');
    expect(licenseInfo('llama3.1')).toEqual({ label: 'Llama 3.1', tone: 'other', open: false });
    expect(licenseInfo('LFM Open License 1.0')?.open).toBe(false);
  });

  it('says nothing when the license is unknown', () => {
    expect(licenseInfo('')).toBeNull();
    expect(licenseInfo('other')).toBeNull();
  });
});
