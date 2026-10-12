import { AsyncLocalStorage } from "node:async_hooks";
import { changesOf, changesIn, DERIVED_FIELDS, type ActivityChange } from "@cobblr/platform-contract/activity-changes";
import { isStoredSecret, secretHistoryDiff } from "@cobblr/platform-contract/secret-field";

export const historyBag = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const IMMUTABLE = new Set(["id", "org_id", "instance", "created_at", "updated_at", "search_vector"]);

export function changesBetween(before: unknown, after: unknown): ActivityChange[] {
  const was = historyBag(before);
  const now = historyBag(after);
  const metadata = Object.fromEntries([...new Set([...Object.keys(historyBag(was.metadata)), ...Object.keys(historyBag(now.metadata))])].map((key) => [key, historyBag(now.metadata)[key] ?? null]));
  return changesOf(was, { ...now, metadata });
}

export function historyDiff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  return secretHistoryDiff({ ...after, changes: changesBetween(before, after), version_before: before }) as Record<string, unknown>;
}

export function restoreImage(current: Record<string, unknown>, diff: unknown, hidden: ReadonlySet<string>): Record<string, unknown> {
  const before = historyBag(historyBag(diff).version_before);
  if (!Object.keys(before).length) throw new Error("This entry has no saved version to restore.");
  const image = { ...current };
  for (const [field, value] of Object.entries(before)) {
    if (IMMUTABLE.has(field) || hidden.has(field) || isStoredSecret(current[field])) continue;
    if (field === "metadata") {
      const live = historyBag(current.metadata);
      const old = historyBag(value);
      const preserve = (key: string) => hidden.has(key) || isStoredSecret(live[key]);
      image.metadata = { ...Object.fromEntries(Object.entries(old).filter(([key]) => !preserve(key))), ...Object.fromEntries(Object.entries(live).filter(([key]) => preserve(key))) };
    } else if (field in current) image[field] = value;
  }
  return image;
}

export function publicHistoryDiff(diff: unknown, hidden: ReadonlySet<string>): unknown {
  if (!diff || typeof diff !== "object" || diff instanceof Date) return diff;
  if (Array.isArray(diff)) return diff.map((value) => publicHistoryDiff(value, hidden));
  const out = Object.fromEntries(Object.entries(historyBag(diff))
    .filter(([key]) => key !== "version_before" && !hidden.has(key) && !DERIVED_FIELDS.has(key))
    .map(([key, value]) => [key, publicHistoryDiff(value, hidden)]));
  const changes = changesIn(diff);
  if (changes) out.changes = changes.filter((c) => !hidden.has(c.field)).map((c) => publicHistoryDiff(c, hidden));
  return out;
}

export interface HistoryWrite {
  orgId: string;
  kind: string;
  id: string;
  before: Record<string, unknown>;
  readAfter: () => Promise<Record<string, unknown> | null>;
  logged: boolean;
  forceLog?: boolean;
}
const writes = new AsyncLocalStorage<HistoryWrite>();
export function runHistoryWrite<T>(write: HistoryWrite, fn: () => T): T { return writes.run(write, fn); }
export function currentHistoryWrite(orgId: string, kind: string, id: string): HistoryWrite | null {
  const write = writes.getStore();
  return write && write.orgId === orgId && write.kind === kind && write.id === id ? write : null;
}

/** The records a writer's create is making, by `<module>:<noun>:<id>`: a
 *  `<noun>_created` row logged while one runs is noted here, so the door logs
 *  its own only when the module's create did not (one entry, never two). */
const creating = new AsyncLocalStorage<Set<string>>();
export async function runCreateWrite<T>(fn: () => Promise<T>): Promise<{ result: T; logged: ReadonlySet<string> }> {
  const logged = new Set<string>();
  return creating.run(logged, async () => ({ result: await fn(), logged }));
}
export function noteCreatedLog(module: string | null, entityType: string, entityId: string): void {
  creating.getStore()?.add(`${module}:${entityType}:${entityId}`);
}
