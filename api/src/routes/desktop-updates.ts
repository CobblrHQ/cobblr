// /api/v1/desktop/updates — the auto-update feed for the Cobblr Edge Helper
// (the Tauri desktop app). ACCOUNT-LEVEL / non-tenant: desktop releases are
// instance-global, not per-workspace.
//
// The helper's updater polls
//   GET /desktop/updates/:target/:arch/:version
// (target ∈ darwin|linux|windows, arch ∈ x86_64|aarch64|…) and expects the
// Tauri v2 DYNAMIC contract:
//   • 204 No Content            → you're on the latest
//   • 200 { version, pub_date, url, signature, notes }  → download + install
//
// Releases are held in a small JSON manifest, published by CI (tauri-action) or
// an operator via POST /publish (super-admin gated). This lets a PRIVATE helper
// repo still auto-update through the hosted instance — no public GitHub release
// needed. Manifest path: env DESKTOP_UPDATES_FILE (default ./data/desktop-releases.json).

import { Router } from "express";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { requireAuth, requirePlatformAdmin } from "../auth/middleware.js";

export const desktopUpdatesRouter = Router();

const MANIFEST_FILE = process.env.DESKTOP_UPDATES_FILE || "./data/desktop-releases.json";

/** One platform's latest release. `key` is `<target>-<arch>` (e.g. darwin-aarch64). */
interface ReleaseEntry {
  version: string;
  url: string;
  signature: string;
  notes?: string;
  pub_date?: string;
}
type Manifest = Record<string, ReleaseEntry>;

async function readManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await fs.readFile(MANIFEST_FILE, "utf8")) as Manifest;
  } catch {
    return {}; // no releases published yet → every helper is "up to date"
  }
}
async function writeManifest(m: Manifest): Promise<void> {
  await fs.mkdir(dirname(MANIFEST_FILE), { recursive: true });
  await fs.writeFile(MANIFEST_FILE, JSON.stringify(m, null, 2));
}

/** semver a > b (numeric x.y.z; a pre-release/build suffix is ignored). */
export function versionGt(a: string, b: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map((n) => parseInt(n, 10) || 0);
  const [a0 = 0, a1 = 0, a2 = 0] = parse(a);
  const [b0 = 0, b1 = 0, b2 = 0] = parse(b);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

// ── the updater poll (unauthenticated — it's a public feed) ─────────────────
desktopUpdatesRouter.get("/updates/:target/:arch/:version", async (req, res, next) => {
  try {
    const { target, arch, version } = req.params;
    const manifest = await readManifest();
    const entry = manifest[`${target}-${arch}`] ?? manifest[target!]; // arch-specific, else target-wide
    if (!entry || !versionGt(entry.version, version!)) {
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
  } catch (e) {
    next(e);
  }
});

// ── publish a release (super-admin / CI) ─────────────────────────────────────
const PublishBody = z.object({
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
    const m = await readManifest();
    if (parsed.data.manifest) {
      Object.assign(m, parsed.data.manifest);
    } else {
      const { platform, version, url, signature, notes, pub_date } = parsed.data;
      if (!platform || !version || !url || !signature) return void res.status(400).json({ error: { code: "bad_body", message: "platform, version, url, signature required" } });
      m[platform] = { version, url, signature, ...(notes ? { notes } : {}), pub_date: pub_date ?? new Date().toISOString() };
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
    if (!repoApi || !token) return void res.status(503).json({ error: { code: "not_configured", message: "bridge binary hosting not configured" } });

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
