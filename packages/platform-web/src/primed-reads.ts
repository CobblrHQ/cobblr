// Reads answered from the dashboard's one snapshot (#6563).
//
// The dashboard asks the server once (GET /orgs/:slug/dashboard) and gets
// every section's reads back, each as its own route answered it. Every GET
// the page then makes goes through one of two doors, the web app's api client
// and workspaceFetch (a module's tile); both ask here first, so a section
// keeps its own query and is answered from the snapshot without a request.
//
// The answers are only good for a moment: they are kept for PRIMED_FOR_MS,
// long enough for the page to mount and ask, and dropped at once by any write
// the page makes, so a refetch after a change is never answered by the
// snapshot from before it.
//
// While a snapshot is on its way, every read of that workspace waits for it
// (holdPrimedReads) rather than racing it with a request of its own: what the
// page asks in that moment is the dashboard asking, and the snapshot answers
// it. A read the snapshot does not hold then goes out as it would have.

import { snapshotKey, type SnapshotEntry } from "@cobblr/platform-contract/dashboard-reads";
import { changesNothing } from "./workspace-writes";

export const PRIMED_FOR_MS = 10_000;

let entries = new Map<string, SnapshotEntry>();
let until = 0;
// Moved on by every clear (a write, the page leaving, another account), so a
// snapshot asked for before it cannot put its older answers back (#7142).
let generation = 0;
let held: { prefix: string; except: string; done: Promise<void> } | null = null;

/** "/orgs/…" for a request's path, with or without the "/api/v1" base. */
function pathOf(input: string): string {
  const at = input.indexOf("/api/v1/");
  const path = at >= 0 ? input.slice(at + "/api/v1".length) : input;
  return snapshotKey(path);
}

/** Taken when a snapshot is asked for, and handed to primeReads with its
 *  answer: a write or a page change in between makes it stale. */
export function primeTicket(): number {
  return generation;
}

/** The snapshot's answers, good for `forMs`. Replaces any before them, unless
 *  something cleared the primed reads after the snapshot was asked for
 *  (`ticket` from primeTicket then): a write in between would otherwise be
 *  undone by the older answers for another ten seconds (#7142). */
export function primeReads(snapshot: Record<string, SnapshotEntry>, ticket: number, forMs = PRIMED_FOR_MS, now = Date.now()): boolean {
  if (ticket !== generation) return false;
  entries = new Map(Object.entries(snapshot).map(([k, v]) => [snapshotKey(k), v]));
  until = now + forMs;
  return true;
}

/** Drop every primed answer: a write happened, or the page went away. */
export function clearPrimedReads(): void {
  entries = new Map();
  until = 0;
  generation++;
}

/** Until `done` settles, a GET under `/orgs/<slug>/` waits for it: all but
 *  the snapshot's own request, `/orgs/<slug>/dashboard`. */
export function holdPrimedReads(slug: string, done: Promise<unknown>): void {
  const mine = { prefix: `/orgs/${slug}/`, except: `/orgs/${slug}/dashboard`, done: done.then(() => undefined, () => undefined) };
  held = mine;
  void mine.done.then(() => {
    if (held === mine) held = null;
  });
}

/** The primed answer for a GET, if there is one, else null. */
function lookup(path: string, now: number): SnapshotEntry | null {
  if (now > until) return null;
  return entries.get(path) ?? null;
}

/** A write to a workspace (as noteWorkspaceWrite reads one): it may change
 *  what the snapshot said. A write about the person (a tip seen, a theme) and
 *  a stream's ticket change nothing a section reads: on an iPhone the install
 *  tip recorded itself as shown the moment the snapshot landed, and every
 *  section went back to asking for itself. */
function changesTheWorkspace(path: string): boolean {
  return path.startsWith("/orgs/") && !changesNothing(path);
}

/**
 * The snapshot's answer for a request, or null to send it. A held path waits
 * for the snapshot first. Only GETs are answered; a write to the workspace
 * clears what is primed, since it may change what the snapshot said.
 */
export async function primedRead(method: string, input: string): Promise<SnapshotEntry | null> {
  const path = pathOf(input);
  if (method.toUpperCase() !== "GET") {
    if (changesTheWorkspace(path)) {
      clearPrimedReads();
      held = null;
    }
    return null;
  }
  const h = held;
  if (h && path.startsWith(h.prefix) && path.split("?")[0] !== h.except) await h.done;
  return lookup(path, Date.now());
}

/** Nothing primed and nothing held: between tests, and when the page starts
 *  answering for another account (#6970). */
export function resetPrimedReads(): void {
  clearPrimedReads();
  held = null;
}
