// What to show a user when an error response body is not JSON.
//
// A non-JSON error body is almost always a proxy, gateway or relay talking
// rather than the api — and that body is the ONLY place that says which one.
// Every client here used to answer `Non-JSON response (${status})` and throw
// the body away, which names the transport instead of the cause. A user hit it
// on a long Ask Cobb turn and recovering the real sentence took hours of proxy,
// container and relay logs, when the response had been carrying it the whole
// time (2026-08-18).
//
// Read the body as TEXT first (`res.json()` CONSUMES it, so after it throws
// there is nothing left to quote), then pass the text here.

/** A user-facing message for an error response whose body would not parse. */
export function describeUnreadableBody(status: number, raw: string): string {
  const snippet = raw
    .replace(/<[^>]*>/g, " ") // an HTML error page should read as a sentence
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const lead =
    status >= 502 && status <= 504
      ? "Cobblr couldn't finish that — the server, or a service it relies on, didn't answer in time."
      : `Cobblr returned a ${status} it couldn't read.`;
  return snippet ? `${lead} (${status}: ${snippet})` : `${lead} (${status})`;
}
