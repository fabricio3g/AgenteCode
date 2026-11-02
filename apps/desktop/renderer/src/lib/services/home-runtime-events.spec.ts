import { describe, expect, it, vi } from 'vitest';
import type { HomeRuntimeEvent } from '$shared/home-runtime';

const source = vi.hoisted(() => ({ receive: undefined as ((event: HomeRuntimeEvent) => void) | undefined, off: vi.fn() }));
vi.mock('./bridge', () => ({ listen: vi.fn(async (_name, receive) => { source.receive = receive; return source.off; }) }));
import { listen } from './bridge';
import { watchHomeRun } from './home-runtime-events';

describe('Home and Design run ownership', () => {
  it('routes concurrent runs separately and keeps the background owner subscribed', async () => {
    const home = vi.fn(), design = vi.fn();
    const releaseHome = await watchHomeRun('home', home);
    const releaseDesign = await watchHomeRun('design', design);
    expect(listen).toHaveBeenCalledTimes(1);
    const event = (runId: string) => ({ runId, type: 'error', message: 'fixture' } as HomeRuntimeEvent);
    source.receive!(event('design'));
    expect(design).toHaveBeenCalledTimes(1);
    expect(home).not.toHaveBeenCalled();
    releaseHome();
    expect(source.off).not.toHaveBeenCalled();
    source.receive!(event('home'));
    source.receive!(event('design'));
    expect(home).not.toHaveBeenCalled();
    expect(design).toHaveBeenCalledTimes(2);
    releaseDesign();
    expect(source.off).toHaveBeenCalledTimes(1);
  });
});
