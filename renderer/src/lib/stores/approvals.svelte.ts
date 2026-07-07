import type { AgentStep } from '$lib/types/chat';

export interface PendingApproval {
  id: string;
  command: string;
  cwd: string;
  resolve: (allow: boolean) => void;
}

const pendingApprovals: PendingApproval[] = [];

let listeners: Array<() => void> = [];

function notify() {
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.push(fn);
  return () => { listeners = listeners.filter((f) => f !== fn); };
}

export function getPendingApprovals(): PendingApproval[] {
  return pendingApprovals;
}

export function getNextPendingApproval(): PendingApproval | undefined {
  return pendingApprovals[0];
}

export function addPendingApproval(id: string, command: string, cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    pendingApprovals.push({ id, command, cwd, resolve });
    notify();
  });
}

export function resolveApproval(id: string, allow: boolean): void {
  const idx = pendingApprovals.findIndex((a) => a.id === id);
  if (idx >= 0) {
    const approval = pendingApprovals[idx];
    pendingApprovals.splice(idx, 1);
    approval.resolve(allow);
    notify();
  }
}

export function clearApprovals(): void {
  for (const approval of pendingApprovals) {
    approval.resolve(false);
  }
  pendingApprovals.length = 0;
  notify();
}
