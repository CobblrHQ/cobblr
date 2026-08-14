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
import type { Request } from "express";
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

export const edgeRouter = Router({ mergeParams: true });
edgeRouter.use(requireAuth, withTenant);

/** Channel key for this request — `orgId` for the default bridge, or
 *  `orgId::<name>` when the bridge polls with ?bridge=<name>. Same format as
 *  digifab's edgeChannelKey, so consumers reach bridges registered via either
 *  the generic wire or the legacy digifab alias. */
function channelKeyOf(req: Request): string {
  const orgId = req.tenant!.org.id;
  const b = req.query.bridge;
  return typeof b === "string" && b ? `${orgId}::${b.slice(0, 60)}` : orgId;
}

/** The bridge's own id, when it polls with ?bridge=<name>. Null means the
 *  workspace's default bridge — same convention as channelKeyOf above, so a
 *  workspace with several sites scopes drivers the way it scopes channels. */
function bridgeIdOf(req: Request): string | null {
  const b = req.query.bridge;
  return typeof b === "string" && b ? b.slice(0, 60) : null;
}

// ── The wire (spoken by the bridge, authed with a devices:edge token) ──

edgeRouter.post("/register", (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  platform().edge.relayTouch(channelKeyOf(req));
  res.json({ ok: true });
});

edgeRouter.get("/poll", async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const ac = new AbortController();
  req.on("close", () => ac.abort());
  const item = await platform().edge.relayPoll(channelKeyOf(req), { signal: ac.signal });
  if (item) res.json(item);
  else res.status(204).end();
});

const Respond = z.object({ id: z.string().min(1), status: z.number().int(), body: z.unknown().optional() });
edgeRouter.post("/respond", (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  const parsed = Respond.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "bad_body", message: "id + numeric status required" } });
    return;
  }
  platform().edge.relayRespond(channelKeyOf(req), parsed.data);
  res.json({ ok: true });
});

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
  const connected = platform().edge.hasChannel(userId);
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
    agents: platform().edge.relayAgents(req.tenant!.org.id),
    personal: { connected, backs },
    stale_after_ms: 60_000,
  });
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
