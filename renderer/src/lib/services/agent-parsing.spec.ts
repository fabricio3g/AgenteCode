import { describe, expect, it } from 'vitest';
import { isPublicFallbackContent } from '$lib/services/agent-parsing';

describe('agent-parsing', () => {
  it('recognizes evidence-only fallback content without visible stop boilerplate', () => {
    expect(isPublicFallbackContent('## Gathered Evidence\n\n- Source-backed fact [1]')).toBe(true);
    expect(isPublicFallbackContent('No reliable gathered evidence was available.')).toBe(true);
    expect(isPublicFallbackContent('Here is a normal completed answer.')).toBe(false);
  });

  it('recognizes partial research reports as public fallback content', () => {
    const partial = [
      '# Clinical research overview',
      '',
      '_Partial research report from retrieved sources (automatic synthesis). Say **continue** to deepen or refine._',
      '',
      '## Key findings',
      '',
      'First-line therapy is selected by severity and comorbidities. [1]'
    ].join('\n');
    expect(isPublicFallbackContent(partial)).toBe(true);
    expect(isPublicFallbackContent('# Full report\n\n## Key findings\n\nComplete synthesis.')).toBe(false);
  });

  it('recognizes human-readable partial answers as public fallback content', () => {
    expect(
      isPublicFallbackContent(
        '# Topic\n\nPartial answer from sources already retrieved. Say **continue** if you want more depth.\n\nSome prose.'
      )
    ).toBe(true);
    expect(
      isPublicFallbackContent(
        'Battery storage helps. I could not complete every step, so this is based only on what was already found.'
      )
    ).toBe(true);
    expect(
      isPublicFallbackContent(
        'I stopped before finishing and did not gather enough information to answer fully. Please try again or rephrase your request.'
      )
    ).toBe(true);
  });
});
