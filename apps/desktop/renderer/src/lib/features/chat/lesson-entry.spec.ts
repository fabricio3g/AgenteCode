import { describe, expect, it } from 'vitest';
import { lessonsEnabled } from '$lib/services/lesson-surface';
import { matchLessonCommand, lessonAskAvailable, lessonFromReply } from '$lib/features/chat/lesson-entry';

describe('lessons are Home only', () => {
  it('is enabled for home and nothing else', () => {
    expect(lessonsEnabled('home')).toBe(true);
    expect(lessonsEnabled(' Home ')).toBe(true);
    for (const space of ['code', 'design', 'roleplay', '', undefined, null]) {
      expect(lessonsEnabled(space as string | null | undefined)).toBe(false);
    }
  });

  it('parses /teach and /practice only in Home', () => {
    expect(matchLessonCommand('/teach the chain rule', 'home')?.mode).toBe('lesson');
    expect(matchLessonCommand('/practice integration by parts', 'home')?.mode).toBe('practice');
    expect(matchLessonCommand('/teach the chain rule', 'code')).toBeNull();
    expect(matchLessonCommand('teach me the chain rule', 'home')).toBeNull();
  });

  it('builds a directive that names the mode and the topic', () => {
    const lessonAsk = matchLessonCommand('/teach  the chain rule ', 'home')!;
    expect(lessonAsk.topic).toBe('the chain rule');
    expect(lessonAsk.directive).toContain('create_lesson');
    expect(lessonAsk.directive).toContain('the chain rule');
    expect(lessonAsk.directive).toContain('mode "lesson"');
    expect(matchLessonCommand('/practice vectors', 'home')!.directive).toContain('mode "practice"');
  });

  it('quotes a reply without sending anything', () => {
    const ask = lessonFromReply('Derivatives compose.\n\nThat is the chain rule.', 'lesson');
    expect(ask.directive).toContain('Derivatives compose. That is the chain rule.');
    expect(ask.directive.startsWith('Create an interactive lesson')).toBe(true);
  });

  it('exposes the affordances only when Home and the type is on', () => {
    expect(lessonAskAvailable('home', true)).toBe(true);
    expect(lessonAskAvailable('home', false)).toBe(false);
    expect(lessonAskAvailable('design', true)).toBe(false);
  });
});
