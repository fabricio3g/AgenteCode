/** Runtime subscriptions belong to runs, independently of mounted surfaces. */
import type { HomeRuntimeEvent } from '$shared/home-runtime';
import { listen } from './bridge';

const owners = new Map<string, (event: HomeRuntimeEvent) => void>();
let subscription: Promise<() => void> | undefined;

export async function watchHomeRun(runId: string, receive: (event: HomeRuntimeEvent) => void): Promise<() => void> {
  if (owners.has(runId)) throw new Error('This runtime run is already registered.');
  owners.set(runId, receive);
  const current = subscription ??= listen<HomeRuntimeEvent>('home_runtime_event', event => owners.get(event.runId)?.(event));
  let off: () => void;
  try {
    off = await current;
  } catch (error) {
    owners.delete(runId);
    if (subscription === current) subscription = undefined;
    throw error;
  }
  return () => {
    if (owners.get(runId) !== receive) return;
    owners.delete(runId);
    if (!owners.size && subscription === current) {
      subscription = undefined;
      off();
    }
  };
}
