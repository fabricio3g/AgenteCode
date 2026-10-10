import { describe, expect, it } from 'vitest';
import { DESIGN_SYSTEM_PROMPT, attachedReferencesBlock, designWorkspaceBriefing, referenceLines } from './design-prompts';

describe('design briefing', () => {
  it('lists the references first and leaves the section out when there are none', () => {
    const listing = ['index.html (120 bytes)', 'references/stripe-com-1.png (48213 bytes)', 'tokens.css (300 bytes)'].join('\n');
    expect(referenceLines(listing)).toEqual(['- references/stripe-com-1.png (48213 bytes)']);
    expect(designWorkspaceBriefing(listing, '', ':root{}')).toContain('### References (look at these first with design_view)\n\n- references/stripe-com-1.png (48213 bytes)');
    expect(designWorkspaceBriefing('index.html (1 bytes)', '', '')).not.toContain('References');
  });
});

describe('attachedReferencesBlock', () => {
  it('is empty when nothing was attached', () => {
    expect(attachedReferencesBlock([])).toBe('');
  });

  it('names each image saved from the message', () => {
    const block = attachedReferencesBlock(['references/hero.png', 'references/menu-2.jpg']);
    expect(block).toContain('## Attached to this message');
    expect(block).toContain('- references/hero.png');
    expect(block).toContain('- references/menu-2.jpg');
  });
});

describe('system prompt', () => {
  it('teaches the agent to look before it borrows, and never to copy', () => {
    expect(DESIGN_SYSTEM_PROMPT).toContain('## Research');
    expect(DESIGN_SYSTEM_PROMPT).toContain('design_reference');
    expect(DESIGN_SYSTEM_PROMPT).toMatch(/never copy a logo/i);
  });
});
