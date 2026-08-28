// The ONE redirect-following, IP-pinning outbound-fetch loop.
//
// Three SSRF-guarded fetch paths independently grew the same non-trivial loop —
// the kernel egress guard, the wasm-sandbox HOST_FETCH, and the scan image
// fetch. Each follows redirects itself with `redirect: "manual"` (so a public
// host that 302s to an internal address is caught at the hop, not followed
// blindly), pins every hop's TCP connection to the exact IP its policy just
// validated (so a DNS rebind between the check and undici's own connect cannot
// land on a private address), and downgrades method/body across a 301/302/303.
// Getting any of that subtly wrong is an SSRF hole, and three copies is three
// chances to drift — the same "one implementation, not copies" rule the shared
// private-IP predicate already follows.
//
// What DIFFERS between the three lives at the call site, not here:
//   - the policy (allowlist vs strict-cloud-with-allow-providers vs block-private)
//     is a `validate` callback that returns the IP to pin (or throws to block);
//   - header preparation (the sandbox strips dangerous headers, sets a UA);
//   - what to do with the FINAL response (the sandbox reads + caps the body and
//     returns a plain object; egress/image hand back a streamable Response).
// This function owns only the loop those three share.

import {
  fetch as undiciFetch,
  Agent,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from "undici";

/** The address to pin a hop's connection to. `family` is 4 or 6. */
export interface Pin {
  address: string;
  family: number;
}

export interface PinnedFetchArgs {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: UndiciRequestInit["body"];
  signal?: AbortSignal;
  /** A redirect chain longer than this is refused. Default 5. */
  maxRedirects?: number;
  /**
   * Validate ONE hop's URL under the caller's policy and return the IP to pin
   * its connection to — or `null` to connect without pinning (rare; only when a
   * caller deliberately does not resolve). THROW to block the hop; the throw
   * propagates out of pinnedRedirectingFetch so the caller maps it to its own
   * error shape. Called for the initial URL AND for every redirect target.
   */
  validate: (url: URL) => Promise<Pin | null>;
}

export interface PinnedFetchResult {
  /** The FINAL (non-redirect) response. Its body is unread. */
  response: UndiciResponse;
  /**
   * The Agent that served the final response, or null when the final hop was
   * unpinned. The CALLER owns its lifecycle, because only the caller knows when
   * the body is done:
   *   - read the body here, then `await dispatcher?.close()`  (the sandbox), or
   *   - return the streamable response and leave the Agent for undici's idle
   *     reaper                                                 (egress, image).
   * This function never closes it on the success path (it would kill a body the
   * caller has not read yet); it DOES close every intermediate redirect hop's
   * Agent, and the failing Agent on a thrown fetch.
   */
  dispatcher: Agent | null;
}

// NB: no TypeScript parameter properties (`constructor(public x)`) anywhere in
// this package. It is buildless — the api loads it from .ts SOURCE via Node's
// strip-only type loader, which cannot emit the this.x assignment a parameter
// property needs and crashes at import (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). Same
// rule as @cobblr/platform-contract. Declare the field, assign it in the body.

/** Thrown when the redirect chain exceeds `maxRedirects`. */
export class TooManyRedirectsError extends Error {
  readonly max: number;
  constructor(max: number) {
    super(`too many redirects (> ${max})`);
    this.name = "TooManyRedirectsError";
    this.max = max;
  }
}

/** Thrown when a redirect's Location header is not a parseable URL. */
export class InvalidRedirectError extends Error {
  readonly location: string;
  constructor(location: string) {
    super(`invalid redirect location: ${location}`);
    this.name = "InvalidRedirectError";
    this.location = location;
  }
}

function pinnedAgent(pin: Pin): Agent {
  return new Agent({
    connect: {
      // SNI/Host stay the original hostname (TLS still verifies); only the IP
      // the socket dials is forced to the validated one.
      //
      // A custom lookup has TWO answer shapes, and undici's connector asks for
      // the second: it passes `{ all: true }`, and Node then reads
      // `addresses[0].address`. Answering the single-address way hands it
      // `undefined`, the connect dies with "Invalid IP address: undefined", and
      // EVERY pinned fetch in the product fails at the socket — webhooks, sync
      // connectors, sandboxed module fetch, catalog image downloads. Answer in
      // whichever shape was asked for.
      lookup: (_hostname, opts, cb) => {
        if ((opts as { all?: boolean } | undefined)?.all) {
          (cb as unknown as (e: Error | null, a: Pin[]) => void)(null, [
            { address: pin.address, family: pin.family },
          ]);
          return;
        }
        (cb as (e: Error | null, a: string, f: number) => void)(null, pin.address, pin.family);
      },
    },
  });
}

/**
 * Follow redirects manually, re-validating and re-pinning every hop.
 * See the module header for why this exists and what each caller keeps.
 */
export async function pinnedRedirectingFetch(args: PinnedFetchArgs): Promise<PinnedFetchResult> {
  const maxRedirects = args.maxRedirects ?? 5;
  let method = (args.method ?? "GET").toUpperCase();
  let body = args.body;
  let current = new URL(args.url);

  for (let hop = 0; ; hop++) {
    const pin = await args.validate(current); // throws to block the hop
    const dispatcher = pin ? pinnedAgent(pin) : null;

    let response: UndiciResponse;
    try {
      response = await undiciFetch(current.href, {
        method,
        redirect: "manual", // we follow + re-validate ourselves
        ...(dispatcher ? { dispatcher } : {}),
        ...(args.headers ? { headers: args.headers } : {}),
        ...(args.signal ? { signal: args.signal } : {}),
        ...(body !== undefined ? { body } : {}),
      });
    } catch (err) {
      await dispatcher?.close().catch(() => {});
      throw err;
    }

    const isRedirect =
      response.status >= 300 && response.status < 400 && response.headers.get("location") !== null;
    if (!isRedirect) {
      // Final response: hand it back with its Agent unclosed (the caller reads
      // the body then closes, or streams it and lets undici reap).
      return { response, dispatcher };
    }

    // A redirect hop: its body is unused, so close this Agent now.
    await dispatcher?.close().catch(() => {});
    if (hop >= maxRedirects) throw new TooManyRedirectsError(maxRedirects);
    const loc = response.headers.get("location")!;
    let next: URL;
    try {
      next = new URL(loc, current);
    } catch {
      throw new InvalidRedirectError(loc);
    }
    // 301/302/303 re-issue as GET without a body (browser semantics); 307/308
    // preserve method + body.
    if (response.status !== 307 && response.status !== 308) {
      method = "GET";
      body = undefined;
    }
    current = next;
  }
}
