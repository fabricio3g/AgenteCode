// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ConversationFollow, distanceFromLatest, pauseOnScrollIntent } from './conversation-scroll';

const viewport = (scrollTop: number, scrollHeight = 1000, clientHeight = 400) => ({ scrollTop, scrollHeight, clientHeight });

describe('conversation following', () => {
  it('pauses on a small upward scroll even close to the live edge', () => {
    const follow = new ConversationFollow();
    follow.resume(600);
    follow.observe(viewport(590));
    expect(follow.following).toBe(false);
  });

  it('keeps following when content grows before the resize callback', () => {
    const follow = new ConversationFollow();
    follow.resume(600);
    follow.observe(viewport(600, 1400));
    expect(follow.following).toBe(true);
  });

  it('stays paused as a reply grows and resumes when scrolling back down', () => {
    const follow = new ConversationFollow();
    follow.resume(600);
    follow.observe(viewport(400));
    follow.observe(viewport(400, 1400));
    expect(follow.following).toBe(false);
    follow.observe(viewport(980, 1400));
    expect(follow.following).toBe(true);
  });

  it('does not interrupt a downward jump while far from the bottom', () => {
    const follow = new ConversationFollow();
    follow.resume(200);
    follow.observe(viewport(300, 2000));
    expect(follow.following).toBe(true);
  });

  it('keeps following when a disclosure closes and the browser clamps its position', () => {
    const follow = new ConversationFollow();
    follow.resume(1000);
    follow.observe(viewport(400, 800));
    expect(follow.following).toBe(true);
  });

  it('resets the old position when switching to a shorter conversation', () => {
    const follow = new ConversationFollow();
    follow.resume(1600);
    follow.pause();
    follow.resume(0);
    follow.observe(viewport(0, 200));
    expect(follow.following).toBe(true);
    expect(distanceFromLatest(viewport(0, 200))).toBe(0);
  });

  it('pauses before an upward wheel scroll and removes listeners when unmounted', () => {
    const follow = new ConversationFollow();
    const node = document.createElement('div');
    const action = pauseOnScrollIntent(node, follow);
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -10 }));
    expect(follow.following).toBe(false);
    follow.resume();
    action.destroy();
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -10 }));
    expect(follow.following).toBe(true);
  });

  it('lets the arrow keys edit a prompt without changing transcript following', () => {
    const follow = new ConversationFollow();
    const node = document.createElement('div');
    const input = document.createElement('textarea');
    node.append(input);
    const action = pauseOnScrollIntent(node, follow);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(follow.following).toBe(true);
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }));
    expect(follow.following).toBe(false);
    action.destroy();
  });
});
