import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const appShell = readFileSync('renderer/src/lib/components/layout/AppShell.svelte', 'utf8');
const composer = readFileSync('renderer/src/lib/components/chat/Composer.svelte', 'utf8');
const messageList = readFileSync('renderer/src/lib/components/chat/MessageList.svelte', 'utf8');

describe('docked composer layout', () => {
  it('renders the message list and composer as normal-flow siblings', () => {
    assert.match(appShell, /<MessageList\s*\/>\s*<Composer\s*\/>/);
    assert.doesNotMatch(appShell, /composerHeight|composerInset|onHeightChange/);
  });

  it('keeps the original centered card styling without floating over messages', () => {
    assert.match(composer, /class=\{`composer-dock[^`]*relative z-20 w-full shrink-0/);
    assert.match(composer, /welcome-shell mx-auto w-full max-w-\[42rem\]/);
    assert.match(composer, /composer-shell aui-composer[^`]*(?:rounded-xl|rounded-2xl)/);
    assert.match(composer, /\.composer-shell\s*\{[^}]*border-radius:[^}]*box-shadow:/s);
    assert.match(composer, /\.composer-dock::before\s*\{[^}]*top: -3rem;[^}]*linear-gradient/s);
    assert.doesNotMatch(composer, /absolute inset-x-0 bottom-|-translate-x-2/);
  });

  it('does not reserve an artificial composer inset in the message scroller', () => {
    assert.doesNotMatch(messageList, /composerInset|contentBottomInset|jumpButtonBottom/);
    assert.match(messageList, /message-scroll h-full overflow-y-auto px-4 pb-8 pt-6/);
    assert.match(messageList, /\.jump-latest-btn\s*\{[^}]*bottom: 1rem;/s);
  });
});
