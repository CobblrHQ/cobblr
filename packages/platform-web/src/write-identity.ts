// A write's identity while its outcome is unknown (#7923).
//
// A part's create reached the server and was saved, its answer was lost on
// the way back, and pressing Create again made a second part (#7835). Every
// write to a workspace now carries an Idempotency-Key, and the server answers
// a repeat of a key with the first answer (api/src/platform/request-replays.ts).
// The key is the same for the same write (method, path and body) while the
// first is still on its way, so a double tap is one write, and after it ended
// without an answer (the connection dropped, the server failed), so pressing
// again is the same write. Once a write has had its answer the next one is new:
// a second create on purpose is a second create.

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A write of any method: what the client forgets once it lands. The refusal
 *  sheet's isMutating leaves PUT out; read there it kept every landed PUT as
 *  still on its way, laid over each later read (#6881). */
export function isAWrite(method: string): boolean {
  return MUTATING.has(method.toUpperCase());
}
/** As long as the server keeps an answer. */
const KEPT_MS = 24 * 60 * 60 * 1000;

interface Open {
  key: string;
  inFlight: number;
  unknownSince: number | null;
}
const open = new Map<string, Open>();

function newKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

/** What one write ended with: an answer, or nothing that says whether it ran. */
export type WriteOutcome = "answered" | "unknown";

/** The outcome a response says: a server failure, a gateway's answer or a
 *  write still being done elsewhere leave it unknown. */
export function outcomeOf(status: number, retryAfter: string | null): WriteOutcome {
  return status >= 500 || (status === 409 && retryAfter !== null) ? "unknown" : "answered";
}

/** A person's writes outside a workspace whose answers the server keeps
 *  (replayAccountWrite, api/src/platform/request-replays.ts). Only these and a
 *  workspace's writes carry a key: a keyed write is kept on the device and
 *  sent again after a reload, and one whose answer the server does not keep
 *  would run twice. lint:creating-writes-ask-the-replay-seam holds every
 *  entry to a route that asks. */
export const KEPT_ACCOUNT_WRITES = [
  "POST /orgs",
  "POST /me/connections",
  "POST /me/notification-channels",
  "POST /me/notifications/:id/actions/:actionId",
  "POST /me/links",
  "POST /feedback",
  "POST /feedback/:id/reply",
  "POST /share-links/accept",
  "POST /try/keep",
  "POST /try/take",
  "POST /super-admin/demos",
  "POST /super-admin/announce",
  "POST /super-admin/notices",
  "POST /super-admin/feedback/batch-resolve",
  "POST /super-admin/sign-in/providers",
] as const;

const keptAccountWrite = KEPT_ACCOUNT_WRITES.map((w) => {
  const [verb, route] = w.split(" ") as [string, string];
  return { verb, path: new RegExp(`^${route.replace(/:[A-Za-z]+/g, "[^/]+")}$`) };
});

/** Whether the server keeps this write's answer: every write to a workspace
 *  (`path` under /orgs/), and the person's own writes listed above. */
function isKept(verb: string, path: string): boolean {
  if (path.startsWith("/orgs/")) return true;
  const bare = path.split("?")[0]!;
  return keptAccountWrite.some((w) => w.verb === verb && w.path.test(bare));
}

/** Begin one write whose answer the server keeps: the key to send, and how
 *  it ended. Null for a read, or a write the server keeps no answer for. */
export function beginWrite(method: string, path: string, body: string | null | undefined): { key: string; settle: (outcome: WriteOutcome) => void } | null {
  const verb = method.toUpperCase();
  if (!MUTATING.has(verb) || !isKept(verb, path)) return null;
  const id = `${verb} ${path}\n${body ?? ""}`;
  let entry = open.get(id);
  if (entry && entry.inFlight === 0 && (entry.unknownSince === null || Date.now() - entry.unknownSince > KEPT_MS)) entry = undefined;
  if (!entry) {
    entry = { key: newKey(), inFlight: 0, unknownSince: null };
    open.set(id, entry);
  }
  const mine = entry;
  mine.inFlight++;
  let settled = false;
  return {
    key: mine.key,
    settle: (outcome) => {
      if (settled) return;
      settled = true;
      mine.inFlight--;
      if (outcome === "unknown") mine.unknownSince = Date.now();
      else mine.unknownSince = null;
      if (mine.inFlight === 0 && mine.unknownSince === null && open.get(id) === mine) open.delete(id);
    },
  };
}

/** For tests: forget every open write. */
export function resetWriteIdentities(): void {
  open.clear();
}
