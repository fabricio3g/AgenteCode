import { describe, expect, it } from 'vitest';
import { isPublicFallbackContent } from '$lib/services/agent-parsing';

describe('agent-parsing', () => {
  it('recognizes evidence-only fallback content without visible stop boilerplate', () => {
    expect(isPublicFallbackContent('## Gathered Evidence\n\n- Source-backed fact [1]')).toBe(true);
    expect(isPublicFallbackContent('No reliable gathered evidence was available.')).toBe(true);
    expect(isPublicFallbackContent('Here is a normal completed answer.')).toBe(false);
  });
});
