// What an outbound send does when the other side is briefly down or busy: which
// failures are worth another try, how long to wait, and how fast one connection
// may send. Pure, so the rules are tested without a network.

/** A send that failed in a way the connector can classify. A plain Error (a
 *  refused URL, an empty message, a 400) is the request's own fault and is
 *  never retried. */
export class OutboundSendError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  constructor(message: string, info: { status: number | null; retryable: boolean; retryAfterMs?: number | null }) {
    super(message);
    this.name = "OutboundSendError";
    this.status = info.status;
    this.retryable = info.retryable;
    this.retryAfterMs = info.retryAfterMs ?? null;
  }
}

/** Tries a send gets in all, the first one included. */
export const MAX_SEND_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_FACTOR = 3;
const BACKOFF_CAP_MS = 5 * 60_000;
const RETRY_AFTER_CAP_MS = 60 * 60_000;

/** A status that says "the other side, not the request": too many, timed out,
 *  or a server fault. 501 and 505 are the server saying it will never do this. */
export function isRetryableStatus(status: number): boolean {
  if (status === 429 || status === 408) return true;
  return status >= 500 && status !== 501 && status !== 505;
}

/** `Retry-After` is whole seconds or an HTTP date; anything else is no hint. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.min(Math.round(Number(v) * 1000), RETRY_AFTER_CAP_MS);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.min(Math.max(at - now, 0), RETRY_AFTER_CAP_MS);
}

export function failedSend(label: string, res: { status: number; statusText?: string; headers: { get(name: string): string | null } }, text: string): OutboundSendError {
  return new OutboundSendError(`${label}: ${res.status} ${res.statusText ?? ""} ${text.slice(0, 200)}`.replace(/\s+/g, " ").trim(), {
    status: res.status,
    retryable: isRetryableStatus(res.status),
    retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
  });
}

export function networkFailure(label: string, err: unknown): OutboundSendError {
  const e = err as { name?: string; message?: string; cause?: { code?: string } };
  const why = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timed out" : (e?.cause?.code ?? e?.message ?? "network error");
  return new OutboundSendError(`${label}: could not reach it (${why})`, { status: null, retryable: true });
}

/** fetch for a connector: a refused or timed-out call and a non-2xx answer both
 *  come back as an OutboundSendError that says whether to try again. */
export async function sendFetch(label: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000), ...init });
  } catch (err) {
    throw networkFailure(label, err);
  }
  if (!res.ok) throw failedSend(label, res, await res.text().catch(() => ""));
  return res;
}

export function isRetryable(err: unknown): boolean {
  return err instanceof OutboundSendError && err.retryable;
}

/** How long to wait before try number `nextAttempt` (2 for the first retry):
 *  2s, 6s, 18s, 54s, capped, with jitter so a burst that failed together does
 *  not come back together. The other side's `Retry-After` wins when it is longer. */
export function backoffMs(nextAttempt: number, retryAfterMs: number | null = null, random: () => number = Math.random): number {
  const exp = Math.min(BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(nextAttempt - 2, 0), BACKOFF_CAP_MS);
  const jittered = Math.round(exp * (0.8 + 0.4 * random()));
  return Math.max(jittered, retryAfterMs ?? 0);
}

/** The least gap between two sends on one connection. Slack's incoming webhooks
 *  allow about one a second; a Discord webhook allows five per two seconds. A
 *  webhook or HTTP connection sets its own with `max_per_second`. */
const PACE_MS: Record<string, number> = { slack: 1_000, discord: 400 };

export function paceIntervalMs(connectorId: string, credentials: Record<string, unknown>): number {
  const own = Number(credentials.max_per_second);
  if (Number.isFinite(own) && own > 0) return Math.ceil(1000 / own);
  return PACE_MS[connectorId] ?? 0;
}

/** One send at a time per connection, at least `intervalMs` apart. In memory:
 *  it paces this api process; each connection's queue worker is the same process. */
export class Pacer {
  private next = new Map<string, number>();

  /** Book the next slot and say how long to wait for it, or, when that wait is
   *  longer than `maxWaitMs`, book nothing and say how long until it is free. */
  take(key: string, intervalMs: number, maxWaitMs: number, now = Date.now()): { waitMs: number } | { deferMs: number } {
    if (intervalMs <= 0) return { waitMs: 0 };
    const at = Math.max(this.next.get(key) ?? 0, now);
    const waitMs = at - now;
    if (waitMs > maxWaitMs) return { deferMs: waitMs };
    this.next.set(key, at + intervalMs);
    return { waitMs };
  }
}

export const pacer = new Pacer();

export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
