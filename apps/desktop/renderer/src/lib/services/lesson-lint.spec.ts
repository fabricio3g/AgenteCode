import { describe, expect, it } from 'vitest';
import { lintLesson } from '$lib/services/lesson-lint';

function lesson(overrides: Record<string, unknown> = {}) {
  return {
    title: 'The chain rule',
    mode: 'lesson',
    blocks: [
      { type: 'pretest', prompt: 'What is the derivative shape?', choices: [
        { text: 'Multiply outer by inner', correct: true },
        { text: 'Add the derivatives', why: 'You may have assumed derivatives add like values.' }
      ] },
      { type: 'explore', prompt: 'Move the coefficient.', model: {
        variables: [{ key: 'a', label: 'Coefficient', value: 2, min: 1, max: 5 }],
        outputs: [{ key: 'rate', label: 'Rate', expression: '3*(a)^2*a' }]
      } },
      { type: 'steps', prompt: 'Work it out', steps: [{ note: 'Differentiate outside first.' }] },
      { type: 'summary', points: ['Outside times inside.'] }
    ],
    ...overrides
  };
}

describe('lesson lint', () => {
  it('accepts a well-formed lesson', () => {
    const result = lintLesson(lesson());
    expect(result.errors).toEqual([]);
  });

  it('refuses prose before the first question', () => {
    const result = lintLesson(lesson({
      blocks: [
        { type: 'reveal', prompt: 'Here is the idea', body: 'Derivatives compose.' },
        { type: 'choice', prompt: 'Which is right?', choices: [{ text: 'A', correct: true }, { text: 'B', why: 'No.' }] },
        { type: 'summary', points: ['x'] }
      ]
    }));
    expect(result.errors.some((issue) => issue.message.includes('opens with a question'))).toBe(true);
  });

  it('refuses a wrong option with no reason', () => {
    const result = lintLesson(lesson({
      blocks: [
        { type: 'choice', prompt: 'Which?', choices: [{ text: 'A', correct: true }, { text: 'B' }] },
        { type: 'summary', points: ['x'] }
      ]
    }));
    expect(result.errors.some((issue) => issue.path.endsWith('why'))).toBe(true);
  });

  it('refuses scaffolding inside a practice set', () => {
    const result = lintLesson(lesson({
      mode: 'practice',
      blocks: [
        { type: 'explore', prompt: 'Play', model: { variables: [{ key: 'a', label: 'A', value: 1, min: 0, max: 1 }], outputs: [{ key: 'o', label: 'O', expression: 'a' }] } },
        { type: 'choice', prompt: 'Which?', choices: [{ text: 'A', correct: true }, { text: 'B', why: 'No.' }] },
        { type: 'summary', points: ['x'] }
      ]
    }));
    expect(result.errors.some((issue) => issue.message.includes('Practice sets hold only'))).toBe(true);
  });

  it('refuses a fractional answer without a tolerance', () => {
    const result = lintLesson(lesson({
      blocks: [
        { type: 'numeric', prompt: 'Half of 7?', answer: 3.5 },
        { type: 'summary', points: ['x'] }
      ]
    }));
    expect(result.errors.some((issue) => issue.path.endsWith('tolerance'))).toBe(true);
  });

  it('refuses a lesson that does not end on a summary', () => {
    const result = lintLesson(lesson({
      blocks: [
        { type: 'choice', prompt: 'Which?', choices: [{ text: 'A', correct: true }, { text: 'B', why: 'No.' }] },
        { type: 'steps', prompt: 'Steps', steps: [{ note: 'One.' }] }
      ]
    }));
    expect(result.errors.some((issue) => issue.message.includes('ends with a summary'))).toBe(true);
  });

  it('warns — without failing — on a wall of text', () => {
    const result = lintLesson(lesson({
      blocks: [
        { type: 'choice', prompt: 'Which?', choices: [{ text: 'A', correct: true }, { text: 'B', why: 'No.' }] },
        { type: 'reveal', prompt: 'Read', body: Array.from({ length: 260 }, () => 'word').join(' ') },
        { type: 'summary', points: ['x'] }
      ]
    }));
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((issue) => issue.path.includes('body'))).toBe(true);
  });
});
