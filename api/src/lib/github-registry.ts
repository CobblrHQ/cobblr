// Shared GitHub-registry fetch helpers.
//
// Centralizes the auth/Accept logic for fetching Cobblr's registry repos —
// the bundle/extension index (registry.ts) and the sandbox-module registry
// (sandbox-install.ts). The non-obvious part (and the bug this consolidates
// away) is that **raw.githubusercontent.com does NOT accept a Bearer token
// for PRIVATE repos** — it just 404s. You must use the GitHub *contents API*
// (api.github.com/repos/.../contents/<path>) with
// `Accept: application/vnd.github.raw+json`, which returns the raw file body
// AND authenticates via Bearer. Both shapes are handled here.
//
// Cobblr's own module registry is PUBLIC and therefore reached by raw URL with
// no token at all. The contents-API path is what an operator needs when they
// point COBBLR_REGISTRY_URL at a private index of their own.
//
// NOTE: scripts/install-registry-modules.mjs carries its own copy of the
// header logic on purpose — it runs standalone at image-build time (plain
// node, before/without the compiled api), so it can't import this module.
// Keep the two in sync.

// EGRESS-FILE: operator-configured - the module registry's address is the operator's setting
import { assertSafeUrl } from "../sandbox/ssrf.js";

/** Auth + Accept headers for fetching from GitHub. Token from
 *  COBBLR_REGISTRY_TOKEN (or GITHUB_TOKEN). */
export function githubRegistryHeaders(url: string): Record<string, string> {
  const token = process.env.COBBLR_REGISTRY_TOKEN || process.env.GITHUB_TOKEN;
  const h: Record<string, string> = {};
  if (/^https:\/\/api\.github\.com\//.test(url)) {
    h.Accept = "application/vnd.github.raw+json"; // raw file body, not base64 metadata
    if (token) h.Authorization = `Bearer ${token}`;
  } else if (/^https:\/\/([^/]*\.)?githubusercontent\.com\b/.test(url) && token) {
    h.Authorization = `Bearer ${token}`;
  }
  return h;
}

/** A raw file fetched with a token GitHub will not take answers 404, even
 *  when the file is public, so such a 404 is asked once more without the
 *  token, and a public file is reached whatever token the environment
 *  carries. A private index uses the contents API, which is never retried
 *  bare. `auth` says which request the answer came from. */
async function githubFetch(url: string, headers: Record<string, string>): Promise<{ res: Response; auth: "token" | "none" }> {
  const res = await fetch(url, { headers });
  const auth = headers.Authorization ? "token" : "none";
  if (res.status !== 404 || auth === "none" || !/^https:\/\/([^/]*\.)?githubusercontent\.com\b/.test(url)) return { res, auth };
  const { Authorization: _refused, ...bare } = headers;
  const again = await fetch(url, { headers: bare });
  if (again.ok) console.warn(`[registry] ${url} answered 404 to the configured token and 200 without it: the token has no access to it`);
  return again.ok ? { res: again, auth: "none" } : { res, auth };
}

/** A failed fetch, said with what names its cause: the walk saw a 404 from a
 *  public registry that answered 200 to every later read, with or without the
 *  token (#9106). The status, which credentials it went with (never their
 *  value) and GitHub's own request id travel in the error and the log. */
function fetchFailed(url: string, got: { res: Response; auth: "token" | "none" }): Error {
  const said = `fetch ${url} → ${got.res.status} ${got.res.statusText} (auth: ${got.auth}, github request: ${got.res.headers.get("x-github-request-id") ?? "none"})`;
  console.warn(`[registry] ${said}`);
  return new Error(said);
}

/** SSRF-checked GET returning the raw response text. */
export async function fetchGithubText(url: string): Promise<string> {
  await assertSafeUrl(url);
  const got = await githubFetch(url, githubRegistryHeaders(url));
  if (!got.res.ok) throw fetchFailed(url, got);
  return got.res.text();
}

/** SSRF-checked GET parsing the response as JSON. */
export async function fetchGithubJson<T = unknown>(url: string): Promise<T> {
  return JSON.parse(await fetchGithubText(url)) as T;
}

/** SSRF-checked GET returning raw bytes (binary tarballs / release assets).
 *  Forces `Accept: octet-stream` so GitHub serves the blob, not metadata. */
export async function fetchGithubBuffer(url: string): Promise<Buffer> {
  await assertSafeUrl(url);
  const got = await githubFetch(url, { ...githubRegistryHeaders(url), Accept: "application/octet-stream" });
  if (!got.res.ok) throw fetchFailed(url, got);
  return Buffer.from(await got.res.arrayBuffer());
}
