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

/** SSRF-checked GET returning the raw response text. */
export async function fetchGithubText(url: string): Promise<string> {
  await assertSafeUrl(url);
  const r = await fetch(url, { headers: githubRegistryHeaders(url) });
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status} ${r.statusText}`);
  return r.text();
}

/** SSRF-checked GET parsing the response as JSON. */
export async function fetchGithubJson<T = unknown>(url: string): Promise<T> {
  return JSON.parse(await fetchGithubText(url)) as T;
}

/** SSRF-checked GET returning raw bytes (binary tarballs / release assets).
 *  Forces `Accept: octet-stream` so GitHub serves the blob, not metadata. */
export async function fetchGithubBuffer(url: string): Promise<Buffer> {
  await assertSafeUrl(url);
  const r = await fetch(url, {
    headers: { ...githubRegistryHeaders(url), Accept: "application/octet-stream" },
  });
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status} ${r.statusText}`);
  return Buffer.from(await r.arrayBuffer());
}
