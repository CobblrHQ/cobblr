// What an assistant read, so its change is judged against it (#4115).
//
// An assistant reads the drill bits: 4. The person sets 10 at the shelf. The
// assistant, asked to "add 2", writes the 6 it worked out from its read, and
// the person's 10 is gone with every save saying saved. A confirm card already
// carries what it opened from and the server refuses it when that changed
// (#7925, EDITED_FROM_HEADER); a change an assistant applies itself (Cobb at
// Auto, an MCP connection) carried nothing, so it wrote over.
//
// So the tools remember, per reader, the fields of each record they read, and
// an update of that record sends, for the fields it changes, the values that
// read saw. The server's stale-edit check then does the rest: a field changed
// since, to something other than what the update writes, refuses the update,
// nothing written, with who changed it; a field nobody touched goes through.
//
// The memory is per process and bounded: a read on one api process and its
// update on another is judged as before (the change goes through as sent),
// never refused for a read it cannot see. Reading the record again replaces
// what was remembered, which is exactly what the refusal asks the model to do.

const KEEP_MS = 60 * 60_000;
const MAX = 5000;

const reads = new Map<string, { at: number; fields: Record<string, unknown> }>();

const keyOf = (scope: string, kind: string, id: string) => `${scope}\u0000${kind}\u0000${id}`;

/** A record's fields as this reader just read them. */
export function rememberRead(scope: string | undefined, kind: string, id: string, fields: unknown): void {
  if (!scope || !kind || !id || !fields || typeof fields !== "object" || Array.isArray(fields)) return;
  const key = keyOf(scope, kind, id);
  reads.delete(key);
  reads.set(key, { at: Date.now(), fields: { ...(fields as Record<string, unknown>) } });
  while (reads.size > MAX) reads.delete(reads.keys().next().value!);
}

/** After this reader's own change went through: what it wrote is what it knows now. */
export function rememberWrite(scope: string | undefined, kind: string, id: string, wrote: Record<string, unknown>): void {
  if (!scope) return;
  const had = reads.get(keyOf(scope, kind, id));
  if (had) rememberRead(scope, kind, id, { ...had.fields, ...wrote });
}

/** For the fields a change writes, what this reader last read them as; null
 *  when it has not read the record (or not lately). */
export function openedFor(scope: string | undefined, kind: string, id: string, writing: Record<string, unknown>): Record<string, unknown> | null {
  if (!scope) return null;
  const had = reads.get(keyOf(scope, kind, id));
  if (!had || Date.now() - had.at > KEEP_MS) return null;
  const opened: Record<string, unknown> = {};
  for (const field of Object.keys(writing)) if (field in had.fields) opened[field] = had.fields[field];
  return Object.keys(opened).length > 0 ? opened : null;
}

/** Tests only: forget everything. */
export function forgetReads(): void {
  reads.clear();
}
