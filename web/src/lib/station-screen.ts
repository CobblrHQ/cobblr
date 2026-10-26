// The Station's rules that are not drawing (#4640): what a scan is, whether a
// repeat counts, and the queue a tablet keeps while its network is down.
// Pure where it can be, so the tests read the rule rather than the page.
import { classifyScanPayload } from "./scanPayload";
import { REPEAT_WINDOW_MS, type StationStockOp } from "@cobblr/platform-contract/station-screen";
import { randomId } from "@cobblr/platform-contract/random-id";

/** What one scan on a station is: a Cobblr label (its record opens), a code
 *  (looked up, then handed to the intake when nobody has it), or nothing a
 *  station acts on (a link to a page of this app). The lens's own rule. */
export type StationScan = { kind: "label"; token: string } | { kind: "code"; code: string } | { kind: "ignore" };

export function stationScanOf(raw: string, ownOrigins?: readonly string[]): StationScan {
  const p = classifyScanPayload(raw, ownOrigins);
  switch (p.kind) {
    case "cobblr-qr":
      return { kind: "label", token: p.token };
    case "own-route":
    case "own-link":
    case "empty":
      return { kind: "ignore" };
    case "product-code":
    case "code":
      return { kind: "code", code: p.code };
    case "link":
      return { kind: "code", code: p.url };
    case "words":
      return { kind: "code", code: p.text };
  }
}

/** A scanner that reads one label twice in a breath is one scan. Counted
 *  again only when the station is set to count repeats. */
export function isRepeatScan(prev: { code: string; at: number } | null, code: string, now: number, countRepeats: boolean): boolean {
  return !countRepeats && !!prev && prev.code === code && now - prev.at < REPEAT_WINDOW_MS;
}

// ── While the network is down ──────────────────────────────────────────────
// A tap that could not reach the server waits on the tablet, in order, under
// its own request id; the server's journal answers a retry of one that did
// land, so nothing is counted twice. Kept for a few minutes: a count from an
// hour ago is a guess about a shelf that has moved on.
export const QUEUE_KEEP_MS = 10 * 60_000;

export interface QueuedMove {
  request_id: string;
  kind: string;
  entity_id: string;
  op: StationStockOp;
  value?: number;
  title: string;
  at: number;
}

const qkey = (slug: string, address: string) => `cobblr.station.queue.${slug}.${address}`;

export function loadQueue(slug: string, address: string, now: number): QueuedMove[] {
  try {
    const raw = JSON.parse(localStorage.getItem(qkey(slug, address)) ?? "[]") as QueuedMove[];
    return Array.isArray(raw) ? raw.filter((m) => m && typeof m.request_id === "string" && now - m.at < QUEUE_KEEP_MS) : [];
  } catch {
    return [];
  }
}

export function saveQueue(slug: string, address: string, q: readonly QueuedMove[]): boolean {
  try {
    if (q.length) localStorage.setItem(qkey(slug, address), JSON.stringify(q));
    else localStorage.removeItem(qkey(slug, address));
    return true;
  } catch {
    // Storage full or off: the caller keeps these moves in memory for this page.
    return false;
  }
}

/** Send the queue in order. A move the server refuses is dropped with its
 *  reason; the first one that cannot reach the server stops the run, so the
 *  order holds. Returns what is still waiting and what was refused. */
export async function flushQueue(
  q: readonly QueuedMove[],
  send: (m: QueuedMove) => Promise<void>,
  unreachable: (e: unknown) => boolean,
): Promise<{ waiting: QueuedMove[]; refused: Array<{ move: QueuedMove; why: string }> }> {
  const refused: Array<{ move: QueuedMove; why: string }> = [];
  for (let i = 0; i < q.length; i++) {
    const m = q[i]!;
    try {
      await send(m);
    } catch (e) {
      if (unreachable(e)) return { waiting: q.slice(i), refused };
      refused.push({ move: m, why: e instanceof Error ? e.message : String(e) });
    }
  }
  return { waiting: [], refused };
}

/** A request id the server's journal keys a move by. */
export function newRequestId(): string {
  return randomId();
}

export { keepStationScreenAwake } from "./screen-awake";
