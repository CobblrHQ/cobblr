// Shared transient-retry fetch for the test harness.
//
// The suite runs 8 forks against ONE shared API. Under that contention a
// request can transiently fail — ECONNRESET / connection refused / a fetch
// timeout / a 5xx-while-pools-warm — especially during the end-of-run TEARDOWN
// storm (all forks dropping their tenant DBs at once, plus template1
// provisioning contention). That window makes the API briefly unreachable, and
// any request in flight gets "fetch failed".
//
// vitest's per-test `retry` never re-runs beforeAll/afterAll, so a blip in a
// file's SETUP or TEARDOWN cascades into the whole file (undefined shared
// session → "reading 'token' of undefined" across siblings). The only place to
// absorb that is the HTTP layer itself. This retries transients with jittered
// backoff; a real failure (4xx, bad body) still surfaces on the first attempt.
//
// `retryServerErrors` (default true): retry 5xx/429 as transient. Callers that
// legitimately ASSERT a 5xx (via expectStatus) pass `false` so an expected
// server error returns immediately instead of eating four backoffs.
//
// `retryBusy` (default true): a 503 whose body says `busy` is the api's own
// "no connection came free, try again in a moment" (server-error.ts), with a
// Retry-After. It is asked again after that wait even when retryServerErrors
// is false, because http() turns 5xx retries off for every call and a busy
// then failed whichever test happened to land in the moment (#8600). Only a
// caller that asserts the 503 itself passes `false`.

export async function fetchTransient(
  url: string,
  init?: RequestInit,
  opts?: { retries?: number; retryServerErrors?: boolean; retryBusy?: boolean },
): Promise<Response> {
  const MAX = opts?.retries ?? 4;
  const retry5xx = opts?.retryServerErrors !== false;
  const retryBusy = opts?.retryBusy !== false;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    let waitMs: number | null = null;
    try {
      const res = await fetch(url, init);
      const busy = retryBusy && (await saysBusy(res));
      const transientStatus = busy || (retry5xx && (res.status >= 500 || res.status === 429));
      if (!transientStatus || attempt === MAX) return res;
      if (busy) waitMs = retryAfterMs(res);
      lastErr = new Error(`HTTP ${res.status} (attempt ${attempt}/${MAX})`);
    } catch (e) {
      // Network-level failure (ECONNRESET/refused, fetch timeout) → retry.
      lastErr = e;
      if (attempt === MAX) throw e;
    }
    // Jittered backoff so 8 forks that collided don't retry in lockstep.
    await new Promise((r) => setTimeout(r, (waitMs ?? attempt * 300) + Math.floor(Math.random() * 200)));
  }
  throw lastErr instanceof Error ? lastErr : new Error("request failed after retries");
}

async function saysBusy(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  try {
    const body = (await res.clone().json()) as { error?: { code?: string } };
    return body.error?.code === "busy";
  } catch {
    return false;
  }
}

function retryAfterMs(res: Response): number | null {
  const s = Number(res.headers.get("retry-after"));
  return Number.isFinite(s) && s >= 0 ? Math.min(s, 10) * 1000 : null;
}
