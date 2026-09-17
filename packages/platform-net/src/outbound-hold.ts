// A test's way to say "this write has not landed yet" (core #3119).
//
// A fixture describes a state that has finished happening, so a defect whose
// cause is WHEN two writes land, rather than WHAT they write, is invisible to
// every test built from one: a detached write landing after a person's, a
// rename racing an enrichment, a re-run overwriting an answer that arrived
// while it ran. On the rig (2026-09-17) a rename started a picture search, the
// person picked their own photo, and the search's download landed over it
// three seconds later; nothing in the code read wrongly.
//
// Every detached write in this product is detached BECAUSE it awaits outbound
// I/O (a search, a download, a provider, a webhook), and every SSRF-guarded
// outbound fetch goes through pinnedRedirectingFetch. So the hold lives here,
// at that one funnel: a registered hold matches a URL, the fetch that reaches
// it WAITS until the hold is released, and then either answers with the
// canned response the hold carries (no network) or goes out as it would have.
// A test holds the I/O, lands the competing write, releases, and asserts the
// outcome. The positive control is `reached`: a hold nobody reached means
// nothing was in flight, and a race test that passes that way has proven
// nothing (the vacuous green in a new costume).
//
// Inert unless populated: one map-size check per fetch. Populated only by the
// test-support router, which is mounted only on a deployment whose job is to
// be tested (COBBLR_TEST_ORG_POOL). Every hold auto-releases after a cap, so
// a test that dies mid-hold never wedges a shared api.

import { Response as UndiciResponse } from "undici";

export interface OutboundHoldSpec {
  /** A URL containing this substring is held. */
  includes: string;
  /** Answer with this instead of going to the network, once released. */
  respond?: { status?: number; contentType?: string; body?: Uint8Array };
  /** Release on its own after this long (default 30 s, capped at 120 s). */
  autoReleaseMs?: number;
}

export interface OutboundHoldStatus {
  id: string;
  includes: string;
  /** Fetches that reached the hold (and waited, or are waiting). */
  reached: number;
  /** Fetches that were let through after the release. */
  returned: number;
  released: boolean;
  /** Whether the hold answers from its canned response (true) or the network. */
  canned: boolean;
}

interface Hold {
  spec: OutboundHoldSpec;
  status: OutboundHoldStatus;
  release: () => void;
  released: Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

const holds = new Map<string, Hold>();
let seq = 0;

export function hasOutboundHolds(): boolean {
  return holds.size > 0;
}

export function registerOutboundHold(spec: OutboundHoldSpec): OutboundHoldStatus {
  const id = `hold-${++seq}-${Date.now().toString(36)}`;
  let release: () => void = () => {};
  const released = new Promise<void>((r) => {
    release = r;
  });
  const cap = Math.min(Math.max(spec.autoReleaseMs ?? 30_000, 1), 120_000);
  const status: OutboundHoldStatus = {
    id,
    includes: spec.includes,
    reached: 0,
    returned: 0,
    released: false,
    canned: spec.respond !== undefined,
  };
  const hold: Hold = {
    spec,
    status,
    released,
    release: () => {
      if (status.released) return;
      status.released = true;
      release();
    },
    timer: setTimeout(() => hold.release(), cap),
  };
  hold.timer.unref?.();
  holds.set(id, hold);
  return { ...status };
}

/** Release a hold. The record stays readable (a test asks `returned` after
 *  releasing) until it is forgotten. Returns false for an unknown id. */
export function releaseOutboundHold(id: string): boolean {
  const h = holds.get(id);
  if (!h) return false;
  h.release();
  return true;
}

export function forgetOutboundHold(id: string): boolean {
  const h = holds.get(id);
  if (!h) return false;
  h.release();
  clearTimeout(h.timer);
  holds.delete(id);
  return true;
}

export function outboundHoldStatus(id: string): OutboundHoldStatus | null {
  const h = holds.get(id);
  return h ? { ...h.status } : null;
}

/** Is a hold registered for this URL? A fixture layer above the fetch loop (a
 *  replay directory that answers 404 for a picture it never recorded) asks
 *  this first: a held URL is the test's own I/O, and outranks the fixture. */
export function outboundHoldMatches(url: string): boolean {
  if (holds.size === 0) return false;
  for (const h of holds.values()) if (url.includes(h.spec.includes)) return true;
  return false;
}

/**
 * Called by pinnedRedirectingFetch for every hop. Returns null at once when no
 * hold matches. When one does: waits for its release, then returns the canned
 * response (the caller returns it as the final response) or null (the caller
 * goes to the network as it would have).
 */
export async function applyOutboundHold(url: string): Promise<UndiciResponse | null> {
  if (holds.size === 0) return null;
  let hit: Hold | undefined;
  for (const h of holds.values()) {
    if (url.includes(h.spec.includes)) {
      hit = h;
      break;
    }
  }
  if (!hit) return null;
  hit.status.reached += 1;
  await hit.released;
  hit.status.returned += 1;
  const r = hit.spec.respond;
  if (!r) return null;
  const body = r.body ?? new Uint8Array();
  return new UndiciResponse(body, {
    status: r.status ?? 200,
    headers: {
      "content-type": r.contentType ?? "application/octet-stream",
      "content-length": String(body.byteLength),
    },
  });
}
