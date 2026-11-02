import { describe, expect, it } from 'vitest';
import { WriteQueue } from './write-queue';

describe('transcript write queue', () => {
  it('serializes only the latest snapshot in a burst', async () => {
    const writes: number[] = [];
    const queue = new WriteQueue<number>(async value => { writes.push(value); });
    const first = queue.enqueue('chat', 1);
    const second = queue.enqueue('chat', 2);
    await queue.flush();
    await Promise.all([first, second]);
    expect(writes).toEqual([2]);
  });
  it('drains writes queued during an in-flight save before close', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writes: number[] = [];
    const queue = new WriteQueue<number>(async value => { if (value === 1) await gate; writes.push(value); });
    const first = queue.enqueue('chat', 1);
    const draining = queue.flush();
    const second = queue.enqueue('chat', 2);
    release();
    await draining;
    await Promise.all([first, second]);
    expect(writes).toEqual([1, 2]);
  });
  it('surfaces failed writes and allows a subsequent save', async () => {
    let fail = true;
    const queue = new WriteQueue<number>(async () => { if (fail) throw new Error('disk full'); });
    const first = expect(queue.enqueue('chat', 1)).rejects.toThrow('disk full');
    await queue.flush(); await first;
    fail = false;
    const second = queue.enqueue('chat', 2);
    await queue.flush(); await second;
  });
});
