import { describe, expect, it } from 'vitest';
import { micStateFromError } from './mic-probe';

describe('micStateFromError', () => {
  it('tells "nothing plugged in" apart from "access denied"', () => {
    expect(micStateFromError(new DOMException('x', 'NotFoundError'))).toBe('none');
    expect(micStateFromError(new DOMException('x', 'NotAllowedError'))).toBe('blocked');
    expect(micStateFromError(new DOMException('x', 'NotReadableError'))).toBe('busy');
  });
});
