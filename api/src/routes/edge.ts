// /orgs/:slug/edge — the GENERIC edge-bridge surface. A bridge is a kernel
// concept (a dial-out tunnel from the user's site); modules are merely its
// consumers (digifab attaches machine managers, core-ai routes AI calls, sync
// connectors reach LAN sources). So the wire the bridge speaks, the pane of
// glass, and the self-update release all live HERE — a workspace can install
// a bridge before enabling any module, and enabling a module later just
// attaches it to the bridge that's already connected.
//
//   bridge  ──POST /register──►  cloud   (announce; opens the channel)
//   bridge  ──GET  /poll    ──►  cloud   (long-poll; next request or 204)
//   bridge  ──POST /respond ──►  cloud   (returns {id,status,body})
//   page    ──GET  /status  ──►  workspace agents + the caller's personal agent
//   page    ──GET  /consumers ─►  registered consumer modules (+ enabled flag)
//   bridge  ──GET  /release(/bundle) ──► self-update artifact
//
// digifab's historic /orgs/:slug/modules/digifab/edge/* stays alive as a thin
// wire-compatible alias over the same platform().edge primitives, so bridges
// in the field keep polling + self-updating without a reinstall.

import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import {
  DriverFetchError,
  declareDriver,
  fetchDriverBundle,
  isSafeKind,
  listDeclared,
  listOrgDrivers,
  manifestFor,
  undeclareDriver,
} from "../platform/edge-drivers.js";
import { requireAuth } from "../auth/middleware.js";
import { requireRole } from "../auth/capability.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import { createPairingCode, redeemPairingCode } from "../platform/edge-pairing.js";
import { WINDOWS_INSTALL_SCRIPT } from "../platform/edge-bridge-install-windows-script.js";
import { INSTALL_SCRIPT } from "../platform/edge-bridge-install-script.js";
import { makeIpLimiter, overLimit, rateLimited } from "../platform/ip-limiter.js";
import { edgeBridgeName, edgeChannelKey, parseBridgeReport, parsePollLanes, parseRelayResponse } from "@cobblr/platform-contract/edge-channel";

export const edgeRouter = Router({ mergeParams: true });
edgeRouter.use(requireAuth, withTenant);

/** Channel key for this request — `orgId` for the default bridge, or
 *  `orgId::<name>` when the bridge polls with ?bridge=<name>, derived the one
 *  way every sender derives it (@cobblr/platform-contract/edge-channel). */
function channelKeyOf(req: Request): string {
  return edgeChannelKey(req.tenant!.org.id, req.query.bridge);
}

/** The bridge's own id, when it polls with ?bridge=<name>. Null means the
 *  workspace's default bridge — same convention as channelKeyOf above, so a
 *  workspace with several sites scopes drivers the way it scopes channels. */
function bridgeIdOf(req: Request): string | null {
  return edgeBridgeName(req.query.bridge);
}

/** What a registering bridge says about itself (its version and machine), and
 *  the token it authenticated with, whose name becomes the bridge's name. An
 *  older bridge sends no body; that is simply nothing to record. */
export function bridgeReportOf(req: Request): ReturnType<typeof parseBridgeReport> {
  return parseBridgeReport(req.body, req.session?.api_token_id ?? null);
}

// ── The wire (spoken by the bridge, authed with a devices:edge token) ──

edgeRouter.post("/register", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  // Express 4 does not forward a rejected promise, so an unhandled DB error
  // here leaves the bridge's request open until something times it out.
  try {
    await platform().edge.relayTouch(channelKeyOf(req), bridgeReportOf(req));
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

edgeRouter.get("/poll", async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  const item = await platform().edge.relayPoll(channelKeyOf(req), { signal: ac.signal, lanes: parsePollLanes(req.query.lanes) });
  if (item) res.json(item);
  else res.status(204).end();
});

edgeRouter.post("/respond", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const parsed = parseRelayResponse(req.body);
  if (!parsed) {
    res.status(400).json({ error: { code: "bad_body", message: "id + numeric status required" } });
    return;
  }
  try {
    await platform().edge.relayRespond(channelKeyOf(req), parsed);
    res.json({ ok: true });
  } catch (e) {
    next(e);
    return;
  }
});

// AI-REACH: exempt the bridge's own file transport (a devices:edge token moving bytes for a relayed call), never an operation a person or Cobb starts
// Files through the bridge: GET (with Range) a file Cobblr sends, HEAD how much
// of a delivery Cobblr holds, PUT (with Content-Range) the delivery itself.
// Streamed both ways, outside every JSON parser.
const blobRoute = async (req: Request, res: Response, next: NextFunction) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  try {
    await platform().edge.serveBlob(channelKeyOf(req), String(req.params.id ?? ""), req, res);
  } catch (e) {
    next(e);
  }
};
edgeRouter.get("/blobs/:id", blobRoute);
// UI-REACH: a bridge's own file transport for a relayed call
edgeRouter.put("/blobs/:id", blobRoute);

// ── Pane of glass ──

// Workspace agents + whether the CALLER has a personal (account-scoped) agent
// connected — e.g. the AI relay from /me/connections, which serves every
// workspace its user routes it to and is therefore not keyed by this org.
// `personal.backs` names the caller's personal connections that route through
// that agent (the edge-bridge AI provider), so the page can say WHAT the agent
// is instead of an opaque "your personal agent".
edgeRouter.get("/status", async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const userId = req.session!.id;
  const connected = await platform().edge.hasChannel(userId);
  let backs: string[] = [];
  if (connected) {
    const rows = await meta
      .selectFrom("user_credentials")
      .select(["label", "provider_id"])
      .where("user_id", "=", userId)
      .where("provider_id", "=", "edge-bridge")
      .execute();
    backs = rows.map((r) => r.label || "Local AI (edge bridge)");
  }
  res.json({
    agents: await platform().edge.relayAgents(req.tenant!.org.id),
    personal: { connected, backs },
    stale_after_ms: 60_000,
  });
});

// Every bridge this workspace has, online or not, by name (#3904). The page
// and every bridge picker read this; the ids stay out of sight.
edgeRouter.get("/bridges", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  try {
    res.json({ bridges: await platform().edge.listBridges(req.tenant!.org.id) });
  } catch (e) {
    next(e);
  }
});

const Rename = z.object({ bridge: z.string().min(1).nullable(), name: z.string().trim().min(1).max(120) });
edgeRouter.post("/bridges/rename", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const parsed = Rename.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_body", message: "a bridge (null for your first one) and a name are required" } });
    return;
  }
  try {
    const ok = await platform().edge.renameBridge(req.tenant!.org.id, parsed.data.bridge, parsed.data.name);
    if (!ok) {
      res.status(404).json({ error: { code: "no_such_bridge", message: "This workspace has no bridge by that id." } });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

const PairingBody = z.object({ name: z.string().trim().min(1).max(120), bridge: z.string().trim().max(60).nullable().optional() });
// A one-time code the installer on the box trades for the bridge's token
// (POST /api/v1/edge/pair), so the token itself is never pasted anywhere.
// AI-REACH: exempt — installing a bridge is done at a keyboard on the box that
// runs it; the assistant has nothing to type the code into.
edgeRouter.post("/pairing-codes", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const parsed = PairingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_body", message: "Give the bridge a name." } });
    return;
  }
  try {
    res.status(201).json(
      await createPairingCode({
        orgId: req.tenant!.org.id,
        userId: req.session!.id,
        name: parsed.data.name,
        bridge: edgeBridgeName(parsed.data.bridge ?? null),
      }),
    );
  } catch (e) {
    next(e);
  }
});

const Disconnect = z.object({ bridge: z.string().min(1).nullable() });
// Cut a bridge off: its key is revoked, so its next check-in is refused.
edgeRouter.post("/bridges/disconnect", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const parsed = Disconnect.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_body", message: "Which bridge? (null for your first one)" } });
    return;
  }
  try {
    const r = await platform().edge.disconnectBridge(req.tenant!.org.id, parsed.data.bridge);
    if (!r) {
      res.status(404).json({ error: { code: "no_such_bridge", message: "This workspace has no bridge by that id." } });
      return;
    }
    res.json({ ok: true, also_cut: r.alsoCut });
  } catch (e) {
    next(e);
  }
});

// Which modules can attach to a bridge — data-driven from the consumer
// registry, flagged with whether each is enabled in THIS workspace so the page
// can offer "Enable" instead of a dead link. Never hardcode a module here.
edgeRouter.get("/consumers", async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const rows = await meta
    .selectFrom("org_modules")
    .select("module_name")
    .where("org_id", "=", req.tenant!.org.id)
    .execute();
  const enabled = new Set(rows.map((r) => r.module_name));
  res.json({
    consumers: platform()
      .edge.listConsumers()
      .map((c) => ({ ...c, enabled: enabled.has(c.module) })),
  });
});

// ── Self-update release ──

edgeRouter.get("/release", (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  res.set("Cache-Control", "no-store").json(platform().edge.getRelease());
});

edgeRouter.get("/release/bundle", (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  res.set("Cache-Control", "no-store").type("text/javascript").send(platform().edge.getReleaseBundle());
});

// The bootstrap loader — lets the install command use a stock public node
// image (no private registry): wget this, run it, and it pulls the bundle.
edgeRouter.get("/release/loader", (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  res.set("Cache-Control", "no-store").type("text/javascript").send(platform().edge.getReleaseLoader());
});

// ── Driver packages ──
//
// The same shape as the release above, for a second artifact: the bridge polls
// the manifest and fetches only what changed. Cobblr PROXIES the bytes and
// stores none of them, so a breach here exposes no third-party code.

edgeRouter.get("/drivers", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  try {
    const entries = await listOrgDrivers(req.tenant!.org.id, bridgeIdOf(req));
    res.set("Cache-Control", "no-store").json(manifestFor(entries));
  } catch (err) {
    next(err);
  }
});

edgeRouter.get("/drivers/:kind", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const kind = String(req.params.kind ?? "");
  // Checked here as well as on the bridge: neither end trusts the other to
  // have done it, and this one becomes a filename over there.
  if (!isSafeKind(kind)) {
    res.status(400).json({ error: "invalid driver kind" });
    return;
  }
  try {
    const entry = (await listOrgDrivers(req.tenant!.org.id, bridgeIdOf(req))).find((e) => e.kind === kind);
    if (!entry) {
      res.status(404).json({ error: "driver not declared for this workspace" });
      return;
    }
    const js = await fetchDriverBundle(entry);
    res.set("Cache-Control", "no-store").type("text/javascript").send(js);
  } catch (err) {
    if (err instanceof DriverFetchError) {
      // The source failed, not us. The bridge keeps what it had and retries.
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  }
});

// ── Declaring a driver (the workspace's own settings surface) ──
//
// OWNER/ADMIN only. Serving driver bytes to a machine on somebody's network is
// a privileged operation, not an ordinary workspace edit, and the spec says so
// (docs/design-decisions/managed-edge-bridge.md, "the trust boundary").

const DriverDecl = z.object({
  kind: z.string().min(1).max(64),
  version: z.string().min(1).max(64),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 hex characters"),
  source: z.string().url(),
  bridgeId: z.string().max(60).nullable().optional(),
});

// What THIS workspace declared, source included. Distinct from GET /drivers,
// which is the bridge's view and deliberately carries no source.
//
// NOT /drivers/declared: that would be shadowed by /drivers/:kind, which is
// declared earlier and would happily match kind="declared". A separate path is
// sturdier than depending on route order that a later edit can reshuffle.
edgeRouter.get("/driver-declarations", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  try {
    res.json({ drivers: await listDeclared(req.tenant!.org.id) });
  } catch (err) {
    next(err);
  }
});

edgeRouter.post("/drivers", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const parsed = DriverDecl.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "invalid driver" });
    return;
  }
  // The kind becomes a filename on the bridge. Rejected here so a bad one is
  // never stored, rather than only when a bridge refuses it later.
  if (!isSafeKind(parsed.data.kind)) {
    res.status(400).json({ error: "kind must be lowercase letters, digits and hyphens" });
    return;
  }
  try {
    await declareDriver(req.tenant!.org.id, parsed.data);
    // Deliberately does NOT push to the bridge. It converges on its next poll,
    // which means this works while the bridge is offline and cannot half-apply.
    res.status(201).json({ ok: true, kind: parsed.data.kind });
  } catch (err) {
    next(err);
  }
});

edgeRouter.delete("/drivers/:kind", async (req, res, next) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const kind = String(req.params.kind ?? "");
  if (!isSafeKind(kind)) {
    res.status(400).json({ error: "invalid driver kind" });
    return;
  }
  try {
    await undeclareDriver(req.tenant!.org.id, kind, bridgeIdOf(req));
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// ── Pairing: the one door a bridge uses before it has a token ──
//
// Mounted at /api/v1/edge, outside any workspace and without auth: the
// installer has only the code. The code is short, so this door is limited per
// IP; a wrong or spent code gets the same answer as an expired one.
export const edgePairRouter = Router();
const pairLimiter = makeIpLimiter(60_000, 10);


/** This instance's address as the person's browser reached it, which is the
 *  one the installer must reach too. Refused when the Host is not a hostname. */
export function publicOrigin(req: Request): string | null {
  const host = (req.get("x-forwarded-host") ?? req.get("host") ?? "").split(",")[0]!.trim();
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) return null;
  return `${req.protocol}://${host}`;
}

// The installer the one-liner pipes into sh, with this instance's address
// written in. Public: it carries no secret, only where to trade the code.
// AI-REACH: exempt — a shell script for a machine, not an action.
edgePairRouter.get("/install.sh", (req, res) => {
  const origin = publicOrigin(req);
  if (!origin) return void res.status(400).type("text/plain").send("echo 'cobblr bridge: bad Host header' >&2; exit 1\n");
  // Never cached: the script names the address it was asked for.
  res.setHeader("cache-control", "no-store");
  res.type("text/x-shellscript").send(INSTALL_SCRIPT.split("@@COBBLR_URL@@").join(origin));
});

// AI-REACH: exempt — a shell script run on the Mac.
edgePairRouter.get("/install-mac.sh", (req, res) => {
  const origin = publicOrigin(req);
  if (!origin) return void res.status(400).type("text/plain").send("exit 1\n");
  res.setHeader("cache-control", "no-store");
  res.type("text/x-shellscript").send(INSTALL_SCRIPT.replace("NATIVE_DEFAULT=0", "NATIVE_DEFAULT=1").split("@@COBBLR_URL@@").join(origin));
});

// AI-REACH: exempt — a PowerShell installer run on the bridge computer.
edgePairRouter.get("/install-windows.ps1", (req, res) => {
  const origin = publicOrigin(req);
  if (!origin) return void res.status(400).type("text/plain").send("throw 'Invalid Cobblr address'\n");
  res.setHeader("cache-control", "no-store");
  res.type("text/plain").send(WINDOWS_INSTALL_SCRIPT.split("@@COBBLR_URL@@").join(origin));
});

// AI-REACH: exempt — spoken by the installer on the bridge's box, never by a person or the assistant.
// UI-REACH: spoken by the installer on the bridge's box
edgePairRouter.post("/pair", async (req, res, next) => {
  if (overLimit(pairLimiter, req)) return void rateLimited(res);
  try {
    const r = await redeemPairingCode((req.body as { code?: unknown } | undefined)?.code);
    if (!r.ok) {
      res.status(r.reason === "unknown" ? 404 : 403).json({
        error: {
          code: r.reason === "unknown" ? "pairing_code_unusable" : "pairing_not_allowed",
          message:
            r.reason === "unknown"
              ? "That code is wrong, expired or already used. Make a new one in Cobblr under Configuration → Devices."
              : "Whoever made this code can no longer add bridges to that workspace. Ask an owner or admin for a new one.",
        },
      });
      return;
    }
    res.json({
      relay_path: `/api/v1/orgs/${r.slug}/edge`,
      token: r.token,
      bridge: r.bridge,
      name: r.name,
    });
  } catch (e) {
    next(e);
  }
});
