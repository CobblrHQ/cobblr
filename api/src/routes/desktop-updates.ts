// /api/v1/desktop/updates — the auto-update feed for the Cobblr desktop apps
// (Tauri). ACCOUNT-LEVEL / non-tenant: desktop releases are instance-global, not
// per-workspace. MULTIPLE products share this feed (edge-helper, studio, …),
// namespaced by an optional product segment so one product's release is never
// served to another (see desktop-updates-manifest.ts for the key scheme).
//
// An app's updater polls
//   GET /desktop/updates/:target/:arch/:version           (default = edge-helper)
//   GET /desktop/updates/:product/:target/:arch/:version  (a named product, e.g. studio)
// (target ∈ darwin|linux|windows, arch ∈ x86_64|aarch64|…) and expects the
// Tauri v2 DYNAMIC contract:
//   • 204 No Content            → you're on the latest
//   • 200 { version, pub_date, url, signature, notes }  → download + install
//
// Releases are held in a small JSON manifest, published by CI (tauri-action) or
// an operator via POST /publish (super-admin gated; pass `product` to namespace).
// This lets a PRIVATE app repo still auto-update through the hosted instance — no
// public GitHub release needed. Manifest path: env DESKTOP_UPDATES_FILE
// (default ./data/desktop-releases.json).

import { Router, type Response } from "express";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { requireAuth, requirePlatformAdmin } from "../auth/middleware.js";
import {
  type Manifest,
  type ReleaseEntry,
  entryFor,
  manifestKey,
  PRODUCT_RE,
  versionGt,
} from "./desktop-updates-manifest.js";

export const desktopUpdatesRouter = Router();

const MANIFEST_FILE = process.env.DESKTOP_UPDATES_FILE || "./data/desktop-releases.json";

async function readManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await fs.readFile(MANIFEST_FILE, "utf8")) as Manifest;
  } catch {
    return {}; // no releases published yet → every app is "up to date"
  }
}
async function writeManifest(m: Manifest): Promise<void> {
  await fs.mkdir(dirname(MANIFEST_FILE), { recursive: true });
  await fs.writeFile(MANIFEST_FILE, JSON.stringify(m, null, 2));
}

/** The Tauri v2 dynamic-updater reply: 204 if up to date, else the release. */
function sendUpdate(res: Response, entry: ReleaseEntry | undefined, currentVersion: string): void {
  if (!entry || !versionGt(entry.version, currentVersion)) {
    res.status(204).end(); // up to date (or nothing published for this platform)
    return;
  }
  res.json({
    version: entry.version,
    pub_date: entry.pub_date ?? new Date(0).toISOString(),
    url: entry.url,
    signature: entry.signature,
    notes: entry.notes ?? "",
  });
}

// ── the updater poll (unauthenticated — it's a public feed) ─────────────────
// Default (unprefixed) feed — edge-helper.
desktopUpdatesRouter.get("/updates/:target/:arch/:version", async (req, res, next) => {
  try {
    const { target, arch, version } = req.params;
    sendUpdate(res, entryFor(await readManifest(), undefined, target!, arch!), version!);
  } catch (e) {
    next(e);
  }
});
// Product-scoped feed — studio, and any future named app. Distinct from the route
// above by segment count, so the two never collide.
desktopUpdatesRouter.get("/updates/:product/:target/:arch/:version", async (req, res, next) => {
  try {
    const { product, target, arch, version } = req.params;
    if (!PRODUCT_RE.test(product!)) {
      return void res.status(404).json({ error: { code: "bad_product", message: "product must be a lowercase slug" } });
    }
    sendUpdate(res, entryFor(await readManifest(), product, target!, arch!), version!);
  } catch (e) {
    next(e);
  }
});

// ── publish a release (super-admin / CI) ─────────────────────────────────────
const PublishBody = z.object({
  // Optional product namespace (edge-helper is the default when omitted).
  product: z.string().regex(PRODUCT_RE).optional(),
  // Either one platform, or a whole manifest at once.
  platform: z.string().min(3).max(40).optional(), // "<target>-<arch>"
  version: z.string().min(1).max(40).optional(),
  url: z.string().url().optional(),
  signature: z.string().min(1).optional(),
  notes: z.string().max(4000).optional(),
  pub_date: z.string().optional(),
  manifest: z.record(z.object({ version: z.string(), url: z.string().url(), signature: z.string(), notes: z.string().optional(), pub_date: z.string().optional() })).optional(),
});
desktopUpdatesRouter.post("/publish", requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const parsed = PublishBody.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ error: { code: "bad_body", message: "platform+version+url+signature, or a full manifest" } });
    const { product, manifest } = parsed.data;
    const m = await readManifest();
    if (manifest) {
      for (const [platform, entry] of Object.entries(manifest)) m[manifestKey(product, platform)] = entry;
    } else {
      const { platform, version, url, signature, notes, pub_date } = parsed.data;
      if (!platform || !version || !url || !signature) return void res.status(400).json({ error: { code: "bad_body", message: "platform, version, url, signature required" } });
      m[manifestKey(product, platform)] = { version, url, signature, ...(notes ? { notes } : {}), pub_date: pub_date ?? new Date().toISOString() };
    }
    await writeManifest(m);
    res.json({ ok: true, platforms: Object.keys(m).length });
  } catch (e) {
    next(e);
  }
});

// ── read the full manifest (super-admin — debugging/verification) ────────────
desktopUpdatesRouter.get("/manifest", requireAuth, requirePlatformAdmin, async (_req, res, next) => {
  try {
    res.json(await readManifest());
  } catch (e) {
    next(e);
  }
});

// ── public download for the headless bridge binary ──────────────────────────
// GET /desktop/bridge/:os/:arch → streams the prebuilt standalone edge-bridge
// binary for that platform. The binaries live as assets on the (PRIVATE)
// edge-bridge release; this route fetches the latest with a server-side token
// and streams it, so `packaging/install.sh` can download WITHOUT any token
// (public), on or off the tailnet. No-op (503) until the operator sets
// EDGE_BRIDGE_REPO_API + EDGE_BRIDGE_REPO_TOKEN.
const OS_OK = new Set(["linux", "darwin", "windows"]);
const ARCH_OK = new Set(["x64", "arm64"]);
let assetCache: { at: number; map: Record<string, string> } | null = null;

async function latestAssetUrls(repoApi: string, token: string): Promise<Record<string, string>> {
  if (assetCache && Date.now() - assetCache.at < 5 * 60_000) return assetCache.map;
  const r = await fetch(`${repoApi}/releases/latest`, { headers: { authorization: `token ${token}` } });
  if (!r.ok) throw new Error(`release lookup ${r.status}`);
  const rel = (await r.json()) as { assets?: Array<{ name: string; browser_download_url: string }> };
  const map: Record<string, string> = {};
  for (const a of rel.assets ?? []) map[a.name] = a.browser_download_url;
  assetCache = { at: Date.now(), map };
  return map;
}

desktopUpdatesRouter.get("/bridge/:os/:arch", async (req, res, next) => {
  try {
    const os = String(req.params.os);
    const arch = String(req.params.arch);
    if (!OS_OK.has(os) || !ARCH_OK.has(arch)) return void res.status(404).json({ error: { code: "bad_platform", message: "os ∈ linux|darwin|windows, arch ∈ x64|arm64" } });
    const repoApi = process.env.EDGE_BRIDGE_REPO_API;
    const token = process.env.EDGE_BRIDGE_REPO_TOKEN;
    if (!repoApi || !token)
      return void res.status(503).json({
        error: {
          code: "not_configured",
          // The install scripts surface this message verbatim, so it must
          // carry the actual fix, not just name the failure.
          message:
            "This instance does not host bridge downloads (EDGE_BRIDGE_REPO_API / EDGE_BRIDGE_REPO_TOKEN are unset). Download the bridge from your bridge distribution instead, or set those env vars to a release repo and restart.",
        },
      });

    const assetName = `cobblr-bridge-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
    const map = await latestAssetUrls(repoApi, token);
    const url = map[assetName];
    if (!url) return void res.status(404).json({ error: { code: "no_asset", message: `no ${assetName} in the latest release` } });

    const upstream = await fetch(url, { headers: { authorization: `token ${token}` } });
    if (!upstream.ok || !upstream.body) return void res.status(502).json({ error: { code: "upstream", message: `asset fetch ${upstream.status}` } });
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-disposition", `attachment; filename="${assetName}"`);
    const len = upstream.headers.get("content-length");
    if (len) res.setHeader("content-length", len);
    // Stream (don't buffer a ~100 MB binary in memory).
    const { Readable } = await import("node:stream");
    Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
  } catch (e) {
    next(e);
  }
});
