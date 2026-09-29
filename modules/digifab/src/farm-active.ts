// Which workspaces this process has seen farm work in: a job polled or a pool
// pass run. The farm watchdog's meta-side gate reads it so a round with no
// farm work opens no tenant pool. No imports, so the workers can note into it
// without a cycle.

const active = new Set<string>();

export function noteFarmActive(orgId: string): void {
  active.add(orgId);
}

export function farmIdle(orgId: string): void {
  active.delete(orgId);
}

export function farmActiveOrgs(): string[] {
  return [...active];
}
