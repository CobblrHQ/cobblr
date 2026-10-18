// Calling this api's own routes from code running inside it (#4901, #5153).
//
// A loopback socket to 127.0.0.1:$API_PORT was refused under load while the
// api kept serving. apiFetch hands such a call to the api's own app
// in-process (platform().selfFetch); any other address is an ordinary fetch.
// Before the platform is set (a unit test, a CLI) it is plain fetch, so a
// test that stubs fetch sees the same URL it always did.
// EGRESS-FILE: own-api - the instance calling its own API
import { isPlatformSet, platform } from "@cobblr/platform-contract/platform-runtime";

/** This api's own origin, "http://127.0.0.1:<API_PORT>": a base to build URLs
 *  on and hand to apiFetch, never to a plain fetch. */
export function selfOrigin(): string {
  // loopback-ok: the one spelling of the api's own origin; every call on it goes through apiFetch
  return `http://127.0.0.1:${process.env.API_PORT || "4000"}`;
}

/** fetch for a URL whose base can be this api's own (selfOrigin(), a base a
 *  route was handed): in-process once the api is up. A fixed outside address
 *  (a lookup service, a public API) uses plain fetch; it can never be self. */
export function apiFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const self = isPlatformSet() ? platform().selfFetch : undefined;
  return typeof self === "function" ? self(input, init) : fetch(input, init);
}
