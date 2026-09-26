/**
 * The thread's "back to latest" state, shared with the composer: the thread
 * knows when you have scrolled up, and the composer draws the button on its
 * own tab row so it lines up with the rest of the input chrome.
 */
export const threadJump = $state({
  /** Scrolled far enough up that a way back helps. */
  visible: false,
  /** Set by the mounted thread; scrolls it to the latest message. */
  jump: null as null | (() => void)
});
