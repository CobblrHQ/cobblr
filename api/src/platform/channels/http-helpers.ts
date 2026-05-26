// Shared HTTP helpers for outbound-webhook channels (Discord, Slack,
// generic webhook, Twilio SMS). All of them POST JSON or form data,
// all need an aggressive timeout, all need to return false on
// failure rather than throw (so the dispatcher can fan out cleanly
// to other channels even when one is down).

const DEFAULT_TIMEOUT_MS = 5000;

export interface PostOptions {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  /** Wall-clock cap. Anything bigger than this means the receiver is
   *  dead or rate-limiting; the notification will get logged as
   *  un-delivered and won't appear in `delivered_via`. */
  timeoutMs?: number;
  /** If true, body is sent as application/x-www-form-urlencoded
   *  (Twilio SMS wants this); otherwise JSON. */
  formEncoded?: boolean;
  /** When the receiver is a known webhook (Discord, Slack), the
   *  channel name is helpful in the log line. */
  channelName?: string;
}

/** POST and discard the response body (we don't need it; we just
 *  want delivery confirmation via HTTP 2xx). Returns true on a 2xx,
 *  false on any other status or network error. */
export async function postJson(opts: PostOptions): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let body: string;
    const headers: Record<string, string> = {
      "User-Agent": "cobblr-notifications/1",
      ...(opts.headers ?? {}),
    };
    if (opts.formEncoded) {
      // body is a Record<string, string-ish>
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.body as Record<string, unknown>)) {
        if (v !== undefined && v !== null) form.set(k, String(v));
      }
      body = form.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    } else {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(opts.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(
        `[notify${opts.channelName ? `:${opts.channelName}` : ""}] ${opts.url} → ${res.status}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    const e = err as Error;
    const msg = e.name === "AbortError" ? "timed out" : e.message;
    console.warn(
      `[notify${opts.channelName ? `:${opts.channelName}` : ""}] ${opts.url} → ${msg}`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}
