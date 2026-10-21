// One large backup at a time on each api (#7715). A backup is built in
// memory, so a big workspace's backup holds about its own size while it is
// made (the nightly recording measured 640 MB for one), and two at once can
// take the box down. A build counts what it holds as it goes and takes the one
// slot when it passes HEAVY_BACKUP_BYTES: a download that finds the slot taken
// stops and says so, a background build waits its turn, and a small backup
// never waits for anything.

export const HEAVY_BACKUP_BYTES = 100 * 1024 * 1024;
export const BACKUP_BUSY_RETRY_SEC = 60;

export class BackupBusyError extends Error {
  readonly code = "backup_busy";
  constructor() {
    super("Another large backup is being made right now, and only one is made at a time. Try again in a minute.");
  }
}

let holder: string | null = null;
const waiting: Array<() => void> = [];

/** The workspace whose backup holds the slot, if one does. */
export function heavyBackupHolder(): string | null {
  return holder;
}

/** What one build holds. `charge` each piece as it is read; `release` once
 *  the build is done, whatever happened. */
export function backupBudget(orgId: string, whenBusy: "refuse" | "wait") {
  let held = 0;
  let mine = false;
  const line = heavyLineForTests.get(orgId) ?? HEAVY_BACKUP_BYTES;
  return {
    async charge(bytes: number): Promise<void> {
      held += bytes;
      if (mine || held < line) return;
      if (holder === null) holder = orgId;
      else if (whenBusy === "refuse") throw new BackupBusyError();
      else {
        await new Promise<void>((resolve) => waiting.push(resolve));
        holder = orgId;
      }
      mine = true;
      await heldForTests(orgId);
    },
    release(): void {
      if (!mine) return;
      mine = false;
      // Handed straight to the next in line, so no download slips in between.
      const next = waiting.shift();
      if (next) next();
      else holder = null;
    },
  };
}

/** Test-only: a workspace's backup counts as large from `bytes` (0: always),
 *  and one that takes the slot holds it up to `holdMs`; 0 lets it go. */
const heavyLineForTests = new Map<string, number>();
const holds = new Map<string, { until: number; waiting: Set<() => void> }>();
export function setHeavyBackupForTests(orgId: string, p: { line?: number | null; holdMs?: number }): void {
  if (p.line === null) heavyLineForTests.delete(orgId);
  else if (typeof p.line === "number") heavyLineForTests.set(orgId, p.line);
  if (typeof p.holdMs !== "number") return;
  const held = holds.get(orgId);
  if (p.holdMs > 0) {
    holds.set(orgId, { until: Date.now() + p.holdMs, waiting: held?.waiting ?? new Set() });
    return;
  }
  holds.delete(orgId);
  for (const go of held?.waiting ?? []) go();
}
async function heldForTests(orgId: string): Promise<void> {
  const held = holds.get(orgId);
  const left = held ? held.until - Date.now() : 0;
  if (!held || left <= 0) return;
  await new Promise<void>((resolve) => {
    const go = () => {
      clearTimeout(timer);
      held.waiting.delete(go);
      resolve();
    };
    const timer = setTimeout(go, left);
    held.waiting.add(go);
  });
}
