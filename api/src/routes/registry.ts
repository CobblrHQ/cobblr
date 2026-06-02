// GET /api/v1/registry/index — the curated extension catalog (HACS-style),
// the single index over all three lanes (bundles / drivers / modules),
// merged with any third-party source index URLs the caller passes in
// `?sources=`. Fetched SERVER-SIDE so the (currently private) repo token
// never reaches the browser, and so we can SSRF-guard custom sources.
//
// Install still goes through the existing per-lane endpoints
// (/orgs/:slug/bundles/install, /orgs/:slug/modules/digifab/drivers,
// /sandbox/install) — each enforces its own permissions. This route is
// just the read-only catalog. See docs/design-decisions/extension-registry.md.

import { Router } from "express";
import { verify as cryptoVerify, createPublicKey } from "node:crypto";
import { requireAuth } from "../auth/middleware.js";
import { assertSafeUrl } from "../sandbox/ssrf.js";

export const registryRouter = Router();
registryRouter.use(requireAuth);

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

// The official index. While the repo is private, fetch via the GitHub API
// contents endpoint (raw.githubusercontent doesn't accept a Bearer token
// for private repos). When it goes public, a raw URL works too — both are
// handled by ghHeaders below.
const DEFAULT_INDEX =
  process.env.COBBLR_EXTENSIONS_URL ??
  "https://api.github.com/repos/CobblrHQ/cobblr-extensions/contents/index.json";

function ghHeaders(url: string): Record<string, string> {
  const token = process.env.COBBLR_REGISTRY_TOKEN || process.env.GITHUB_TOKEN;
  const h: Record<string, string> = {};
  if (/^https:\/\/api\.github\.com\//.test(url)) {
    h.Accept = "application/vnd.github.raw+json"; // return the raw file body
    if (token) h.Authorization = `Bearer ${token}`;
  } else if (/^https:\/\/([^/]*\.)?githubusercontent\.com\b/.test(url) && token) {
    h.Authorization = `Bearer ${token}`;
  }
  return h;
}

interface IndexShape {
  schema?: number;
  bundles?: Array<Record<string, unknown>>;
  drivers?: Array<Record<string, unknown>>;
  modules?: Array<Record<string, unknown>>;
  /** Cobblr-vouched author pubkeys (SPKI DER base64). Trusted only when
   *  the official index is root-verified (or no root is configured). */
  trusted_keys?: string[];
}
type Lane = "bundles" | "drivers" | "modules";
const LANES: Lane[] = ["bundles", "drivers", "modules"];

// The detached signature for the official index — defaults to the index
// URL with `.sig` appended. Only the OFFICIAL index is root-checked.
const DEFAULT_SIG = process.env.COBBLR_EXTENSIONS_SIG_URL || `${DEFAULT_INDEX}.sig`;

// Small TTL cache so browsing the marketplace doesn't hammer GitHub (the
// authenticated API is 5,000/hr, but a 5-min cache keeps us comfortable).
// We cache the RAW bytes too — needed to verify the detached signature
// over exactly what was signed.
const cache = new Map<string, { at: number; raw: string; data: IndexShape }>();
const TTL_MS = 5 * 60_000;

async function fetchIndex(url: string): Promise<{ raw: string; data: IndexShape }> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  await assertSafeUrl(url);
  const r = await fetch(url, { headers: ghHeaders(url) });
  if (!r.ok) throw new Error(`fetch ${r.status} ${r.statusText}`);
  const raw = await r.text();
  const data = JSON.parse(raw) as IndexShape;
  const entry = { at: Date.now(), raw, data };
  cache.set(url, entry);
  return entry;
}

/** Fetch the official index's detached signature and verify it over the
 *  raw index bytes. Returns whether the root anchor checks out. */
async function verifyRoot(rawIndex: string): Promise<boolean> {
  if (!ROOT_PUBKEY) return false; // no anchor configured
  try {
    await assertSafeUrl(DEFAULT_SIG);
    const r = await fetch(DEFAULT_SIG, { headers: ghHeaders(DEFAULT_SIG) });
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
      sources: [] as Array<{ url: string; label: string; ok: boolean; error?: string }>,
      /** Whether the official index's detached signature verified against
       *  COBBLR_ROOT_PUBKEY. null = no root anchor configured. */
      official_root_verified: null as boolean | null,
    };
    const seen: Record<Lane, Set<string>> = { bundles: new Set(), drivers: new Set(), modules: new Set() };
    // The set of Cobblr-vouched author keys. Honoured only when the
    // official index is root-verified — or when no root is configured at
    // all (status-quo "trust the source"). A configured-but-unverified
    // root yields an empty set → every module is "unverified" (fail closed).
    let trustedKeys = new Set<string>();

    // Official first → it wins on id collisions; it also carries the
    // trust anchor (root sig + trusted_keys) used to tag every module.
    const ingest = async (url: string, label: string, isOfficial: boolean) => {
      try {
        const { raw, data: idx } = await fetchIndex(url);
        if (isOfficial) {
          if (!ROOT_PUBKEY) {
            out.official_root_verified = null;
            trustedKeys = new Set(idx.trusted_keys ?? []);
          } else {
            const ok = await verifyRoot(raw);
            out.official_root_verified = ok;
            trustedKeys = ok ? new Set(idx.trusted_keys ?? []) : new Set();
          }
        }
        for (const lane of LANES) {
          for (const e of idx[lane] ?? []) {
            const id = typeof e.id === "string" ? e.id : typeof e.name === "string" ? e.name : undefined;
            if (id && seen[lane].has(id)) continue;
            if (id) seen[lane].add(id);
            out[lane].push({ ...e, source: label });
          }
        }
        out.sources.push({ url, label, ok: true });
      } catch (err) {
        out.sources.push({ url, label, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    };

    await ingest(DEFAULT_INDEX, "official", true);
    for (const s of sources) await ingest(s, s, false);

    // Tag each module's trust tier: "official" iff its pubkey is a vouched
    // key, else "unverified" (the UI gates those behind consent).
    for (const m of out.modules) {
      const pk = typeof m.pubkey === "string" ? m.pubkey : undefined;
      m.trust = pk && trustedKeys.has(pk) ? "official" : "unverified";
    }

    res.json(out);
  } catch (err) {
    next(err);
  }
});
