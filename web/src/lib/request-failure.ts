// What a failed request MEANS, for the person looking at the page. Three
// different things used to read as one sentence: a sign-in page refused with
// 429 and Retry-After: 300 told a person on a working network to "check your
// connection" and offered an instant Try again that could only be refused
// again (#3622). Unreachable is not absent, and refused is not unreachable:
//
//   unreachable  no response at all (offline, DNS, the server gone)
//   busy         429: the server answered and asked us to wait, maybe saying how long
//   server       5xx: the server answered and is having trouble
//   refused      any other answer: the request itself was turned down
//
// One reading, used by request() for every error's message and by any page
// that draws its own failure panel, so no page has to guess from a status.
import { ApiError } from "./api";
export { busySentence, parseRetryAfter, waitWords } from "./request-wait";

export type RequestFailure =
  | { kind: "unreachable" }
  | { kind: "busy"; retryAfterSec: number | null }
  | { kind: "server"; status: number }
  | { kind: "refused"; status: number; message: string };

export function requestFailureOf(err: unknown): RequestFailure {
  if (!(err instanceof ApiError)) return { kind: "unreachable" };
  if (err.status === 0) return { kind: "unreachable" };
  // A 429 about one account (a lockout after wrong passwords) is that
  // account's answer, with its own words, not the network being asked to wait.
  if (err.status === 429 && err.code === "rate_limited") return { kind: "busy", retryAfterSec: err.retryAfterSec ?? null };
  if (err.status >= 500) return { kind: "server", status: err.status };
  return { kind: "refused", status: err.status, message: err.message };
}
