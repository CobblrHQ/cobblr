// GET /api/v1/registry/index — the curated extension catalog (HACS-style),
// the single index over all three lanes (bundles / drivers / modules),
// merged with any third-party source index URLs the caller passes in
// `?sources=`. Fetched SERVER-SIDE so the (currently private) repo token
// never reaches the browser, and so we can SSRF-guard custom sources.
//
// Install still goes through the existing per-lane endpoints
// (/orgs/:slug/bundles/install, /orgs/:slug/modules/digifab/drivers,
// /sandbox/install) — each enforces its own permissions. This route is
// just the read-only catalog. See docs/modules/extension-registry.md.

import { Router } from "express";
import { verify as cryptoVerify, createPublicKey } from "node:crypto";
import { requireAuth } from "../auth/middleware.js";
import { assertSafeUrl } from "../sandbox/ssrf.js";
import { githubRegistryHeaders, fetchGithubText } from "../lib/github-registry.js";
import { buildOfficialIndex } from "../lib/extensions-index.js";

export const registryRouter = Router();
registryRouter.use(requireAuth);

// The public, unauthenticated catalog endpoint. This is what "serve the
// catalog from this instance's own stack" means: GET /api/v1/registry/index.json
// returns the official index built locally from the baked-in bundle manifests
// — the drop-in replacement for the GitHub-hosted cobblr-extensions/index.json.
// No auth (the GitHub URL it replaces was public too); mounted BEFORE the
// authed router in server.ts so it isn't caught by requireAuth.
export const registryPublicRouter = Router();
registryPublicRouter.get("/index.json", (_req, res) => {
  // no-store-ish but cacheable briefly: the catalog only changes on deploy.
  res.set("Cache-Control", "public, max-age=60");
  res.json(buildOfficialIndex());
});

// ── Notarised-open trust (extension-registry.md §2.4, Phase D) ──────
// The official index may be anchored to a Cobblr ROOT key: a detached
// ed25519 signature over index.json, verified here against a pubkey baked
// into the deploy (COBBLR_ROOT_PUBKEY). If set + valid, we trust the
// official index's `trusted_keys` (the Cobblr-vouched author pubkeys); a
// module signed by one of those installs clean ("official"). Everything
// else is "unverified" → the UI gates it behind explicit consent (the
// WASM sandbox + capabilities still bound the blast radius). Fail closed:
// a configured root with a missing/invalid sig trusts NO keys.
const ROOT_PUBKEY = process.env.COBBLR_ROOT_PUBKEY || "";
function verifyEd25519(pubkeyB64: string, data: Buffer, sigB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(pubkeyB64, "base64"), format: "der", type: "spki" });
    const sig = Buffer.from(sigB64.startsWith("ed25519:") ? sigB64.slice(8) : sigB64, "base64");
    return cryptoVerify(null, data, key, sig);
  } catch {
    return false;
  }
}

// The official catalog is now SELF-HOSTED: built in-process from the baked-in
// bundle manifests (see lib/extensions-index.ts + GET /registry/index.json).
// No GitHub, no manual publish — the catalog is always current with the deploy.
//
// COBBLR_EXTENSIONS_URL stays as an OPTIONAL override: point it at an external
// index.json (e.g. another Cobblr instance's /api/v1/registry/index.json, or a
// future signed index) and that URL becomes the official source instead of the
// local build. Empty/unset (the default, and what compose passes) → local.
const EXTERNAL_INDEX_URL = process.env.COBBLR_EXTENSIONS_URL || "";

interface IndexShape {
  schema?: number;
  bundles?: Array<Record<string, unknown>>;
  drivers?: Array<Record<string, unknown>>;
  modules?: Array<Record<string, unknown>>;
  renderers?: Array<Record<string, unknown>>;
  /** Cobblr-vouched author pubkeys (SPKI DER base64). Trusted only when
   *  the official index is root-verified (or no root is configured). */
  trusted_keys?: string[];
}
type Lane = "bundles" | "drivers" | "modules" | "renderers";
const LANES: Lane[] = ["bundles", "drivers", "modules", "renderers"];

// The detached signature for an EXTERNAL official index — defaults to that
// index URL with `.sig` appended. Only meaningful when COBBLR_EXTENSIONS_URL
// points at an external index AND COBBLR_ROOT_PUBKEY is set; the local build
// is inherently trusted (it's your own deploy) and carries no signature.
const DEFAULT_SIG = process.env.COBBLR_EXTENSIONS_SIG_URL || (EXTERNAL_INDEX_URL ? `${EXTERNAL_INDEX_URL}.sig` : "");

// Small TTL cache so browsing the marketplace doesn't hammer GitHub (the
// authenticated API is 5,000/hr, but a 5-min cache keeps us comfortable).
// We cache the RAW bytes too — needed to verify the detached signature
// over exactly what was signed.
const cache = new Map<string, { at: number; raw: string; data: IndexShape }>();
const TTL_MS = 5 * 60_000;

async function fetchIndex(url: string): Promise<{ raw: string; data: IndexShape }> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const raw = await fetchGithubText(url);
  const data = JSON.parse(raw) as IndexShape;
  const entry = { at: Date.now(), raw, data };
  cache.set(url, entry);
  return entry;
}

/** The OFFICIAL index: the local self-hosted build by default, or a configured
 *  external index.json when COBBLR_EXTENSIONS_URL is set. Returns both the raw
 *  bytes (needed to verify an external index's detached sig) and the parsed
 *  data. The local build carries no signature (it's your own deploy). */
async function getOfficialIndex(): Promise<{ raw: string; data: IndexShape; local: boolean }> {
  if (EXTERNAL_INDEX_URL) {
    const { raw, data } = await fetchIndex(EXTERNAL_INDEX_URL);
    return { raw, data, local: false };
  }
  const data = buildOfficialIndex() as unknown as IndexShape;
  return { raw: JSON.stringify(data), data, local: true };
}

/** Fetch a single bundle's full manifest from the OFFICIAL registry index by
 *  its id (e.g. "cobblr.flagship.yarn"). Used by managed-app provisioning so the
 *  server owns the bundle (the rich, published version) instead of trusting a
 *  caller-supplied manifest. Cached via fetchIndex (5-min TTL). Returns null on
 *  a miss or if the registry is unreachable (caller decides the fallback). */
export async function getOfficialBundleManifest(bundleId: string): Promise<unknown | null> {
  try {
    const { data } = await getOfficialIndex();
    const entry = (data.bundles ?? []).find((b) => b.id === bundleId || (b.manifest as { id?: string } | undefined)?.id === bundleId);
    return (entry?.manifest as unknown) ?? null;
  } catch (err) {
    console.error(`[registry] getOfficialBundleManifest(${bundleId}) failed:`, (err as Error).message);
    return null;
  }
}

/** Fetch the official index's detached signature and verify it over the
 *  raw index bytes. Returns whether the root anchor checks out. */
async function verifyRoot(rawIndex: string): Promise<boolean> {
  if (!ROOT_PUBKEY || !DEFAULT_SIG) return false; // no anchor / no sig to fetch
  try {
    await assertSafeUrl(DEFAULT_SIG);
    const r = await fetch(DEFAULT_SIG, { headers: githubRegistryHeaders(DEFAULT_SIG) });
    if (!r.ok) return false;
    const sig = (await r.text()).trim();
    return verifyEd25519(ROOT_PUBKEY, Buffer.from(rawIndex, "utf8"), sig);
  } catch {
    return false;
  }
}

registryRouter.get("/index", async (req, res, next) => {
  try {
    // Third-party sources = URLs to other index.json files (the HACS
    // "add a custom repository" model). Capped + de-duped; each is
    // SSRF-checked in fetchIndex. The frontend persists the list.
    const sources = String(req.query.sources ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s, i, a) => a.indexOf(s) === i)
      .slice(0, 10);

    const out = {
      schema: 1,
      bundles: [] as Array<Record<string, unknown>>,
      drivers: [] as Array<Record<string, unknown>>,
      modules: [] as Array<Record<string, unknown>>,
      renderers: [] as Array<Record<string, unknown>>,
      sources: [] as Array<{ url: string; label: string; ok: boolean; error?: string }>,
      /** Whether the official index's detached signature verified against
       *  COBBLR_ROOT_PUBKEY. null = no root anchor configured. */
      official_root_verified: null as boolean | null,
    };
    const seen: Record<Lane, Set<string>> = { bundles: new Set(), drivers: new Set(), modules: new Set(), renderers: new Set() };
    // The set of Cobblr-vouched author keys. Honoured only when the
    // official index is root-verified — or when no root is configured at
    // all (status-quo "trust the source"). A configured-but-unverified
    // root yields an empty set → every module is "unverified" (fail closed).
    let trustedKeys = new Set<string>();

    const mergeLanes = (idx: IndexShape, label: string) => {
      for (const lane of LANES) {
        for (const e of idx[lane] ?? []) {
          const id = typeof e.id === "string" ? e.id : typeof e.name === "string" ? e.name : undefined;
          if (id && seen[lane].has(id)) continue;
          if (id) seen[lane].add(id);
          out[lane].push({ ...e, source: label });
        }
      }
    };

    // Official FIRST → it wins on id collisions; it also carries the trust
    // anchor (root sig + trusted_keys) used to tag every module. The official
    // index is the local self-hosted build by default (no HTTP, always current
    // with the deploy) or a configured external index.
    const officialUrl = EXTERNAL_INDEX_URL || "self";
    try {
      const { raw, data: idx, local } = await getOfficialIndex();
      // The local build is inherently trusted (your own deploy) → no root
      // check; treat as "no anchor configured" and honour its trusted_keys
      // (empty). An external index is root-checked when a root key is set.
      if (local || !ROOT_PUBKEY) {
        out.official_root_verified = null;
        trustedKeys = new Set(idx.trusted_keys ?? []);
      } else {
        const ok = await verifyRoot(raw);
        out.official_root_verified = ok;
        trustedKeys = ok ? new Set(idx.trusted_keys ?? []) : new Set();
      }
      mergeLanes(idx, "official");
      out.sources.push({ url: officialUrl, label: "official", ok: true });
    } catch (err) {
      out.sources.push({ url: officialUrl, label: "official", ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    // Third-party sources = extra index.json URLs (HACS "custom repository"
    // model). Each is SSRF-checked in fetchIndex; never a trust anchor.
    const ingest = async (url: string, label: string) => {
      try {
        const { data: idx } = await fetchIndex(url);
        mergeLanes(idx, label);
        out.sources.push({ url, label, ok: true });
      } catch (err) {
        out.sources.push({ url, label, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    };
    for (const s of sources) await ingest(s, s);

    // Tag each code extension's trust tier: "official" iff its pubkey is a
    // vouched key, else "unverified" (the UI gates those behind consent).
    // Renderers are sandboxed code too, so the same rule applies.
    for (const lane of [out.modules, out.renderers]) {
      for (const e of lane) {
        const pk = typeof e.pubkey === "string" ? e.pubkey : undefined;
        e.trust = pk && trustedKeys.has(pk) ? "official" : "unverified";
      }
    }

    res.json(out);
  } catch (err) {
    next(err);
  }
});
