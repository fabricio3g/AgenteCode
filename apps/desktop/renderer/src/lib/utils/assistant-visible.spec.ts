import { describe, expect, it } from 'vitest';
import { sanitizeAssistantVisibleText } from './assistant-visible';

describe('sanitizeAssistantVisibleText', () => {
  it('removes leaked agent/tool transcript prefixes', () => {
    const text = `Thought for 24.9s
Planning
Using: web_search
Reasoning
I'll search for current information.
Web Search
Thinking
Using: fetch_url
Fetch Url
Response ready
The user wants me to:
1. Search the web
2. Create a spreadsheet
12
Here is the current USD/ARS summary.`;

    expect(sanitizeAssistantVisibleText(text)).toBe('Here is the current USD/ARS summary.');
  });

  it('keeps ordinary answers intact', () => {
    const text = 'A Java software engineer builds and maintains applications using Java.';
    expect(sanitizeAssistantVisibleText(text)).toBe(text);
  });

  it('removes legacy agent fallback diagnostic sections but keeps the visible summary', () => {
    const text = `> **Agent stopped:** it detected repeated calls to web_search. Here is only what I found during the agent loop:

## Sources found

1. [Some Source](https://example.com)

## Tool evidence

Search query: distributed solar microgrids resilience planning
Context excerpt: very long excerpt

Agent stopped because it detected repeated calls to web_search.
What was completed: 5 sources gathered.
What is missing: none.`;

    expect(sanitizeAssistantVisibleText(text)).toBe(`Agent stopped because it detected repeated calls to web_search.
What was completed: 5 sources gathered.
What is missing: none.`);
  });

  it('keeps answers that open in the first person, list included', () => {
    const text = `I can help you with a lot of things:

1. Answer questions and explain topics
2. Write and edit text
3. Help with code

Let me know what you need!`;
    expect(sanitizeAssistantVisibleText(text)).toBe(text);
    expect(sanitizeAssistantVisibleText("Let me explain how it works.\n\n- first\n- second")).toBe(
      "Let me explain how it works.\n\n- first\n- second"
    );
  });

  it('never blanks a reply the model wrote', () => {
    expect(sanitizeAssistantVisibleText('Thinking\nPlanning\nThe user wants a list.')).toBe(
      'Thinking\nPlanning\nThe user wants a list.'
    );
    expect(sanitizeAssistantVisibleText('<think>only reasoning</think>')).toBe('');
  });
});
