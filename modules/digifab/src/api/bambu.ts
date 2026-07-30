// /api/v1/orgs/:slug/modules/digifab/bambu — the cloud-login connect wizard.
//
// The Bambu account token is a SECRET, so it never reaches the browser: the
// multi-step flow (login → email/2FA code → pick printer → create) is held in a
// short-lived SERVER-SIDE session keyed by an opaque id. The browser only ever
// sees the printer list (names/models/online), never the token or access codes.
// On create we store the token + the chosen printer's LAN access code ENCRYPTED.
//
// All three modes are LIVE. CLOUD gives telemetry + light/pause/resume/stop over
// Bambu's MQTT; full control (start, jog, home, set-temp, camera) comes over the
// LAN via the Cobblr edge-bridge — either a pure-LAN connection or, more commonly,
// per-printer LAN access layered on a cloud login (HYBRID — see fleet.ts).

import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import { tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { BambuCloud, BambuCloudError, BAMBU_REGIONS, type BambuRegion, type BambuCloudDevice } from "../drivers/bambu-cloud.js";
import { sendBambuCommand } from "../bambu-pump.js";

export const bambuRouter = Router({ mergeParams: true });

// ── short-lived server-side auth sessions (token never leaves the server) ────
interface AuthSession {
  region: BambuRegion;
  email: string;
  token?: string;
  tfaKey?: string;
  awaiting?: "email" | "tfa";
  username?: string | null;
  devices?: BambuCloudDevice[];
  createdAt: number;
}
const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map<string, AuthSession>();

function prune(): void {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
}
function putSession(s: AuthSession): string {
  prune();
  const id = randomUUID();
  sessions.set(id, s);
  return id;
}

/** Strip secrets — the browser sees names/models/online, never the access code. */
function publicDevices(devices: BambuCloudDevice[]): Array<{ dev_id: string; name: string; model?: string; online: boolean; print_status?: string }> {
  return devices.map((d) => ({ dev_id: d.dev_id, name: d.name, model: d.model, online: d.online, print_status: d.print_status }));
}

/** Per-mode capability disclosure (the author's "tell them the limits"). */
export function modeCapabilities(mode: string): { monitor: boolean; control: boolean; available: boolean; note: string } {
  switch (mode) {
    case "cloud":
      return { monitor: true, control: true, available: true, note: "Live status, temps & progress, plus chamber light and pause/resume/stop over the cloud. Jog, home, set-temp, starting a print and the camera need LAN. Bambu blocks raw G-code over the cloud. Add per-printer LAN access (hybrid) to unlock those without giving up cloud telemetry." };
    case "lan":
      return { monitor: true, control: true, available: true, note: "Full control (start, pause, cancel, jog, home, set temps, live camera) over your LAN via the Cobblr edge-bridge. Needs Developer Mode (LAN access code) on the printer and a bridge on the same network." };
    case "hybrid":
      return { monitor: true, control: true, available: true, note: "Best of both: cloud login for live status anywhere, plus per-printer LAN access (edge-bridge + Developer Mode) for full control and the camera. Cloud keeps reporting even when the bridge is offline." };
    default:
      return { monitor: false, control: false, available: false, note: "Unknown mode." };
  }
}

async function finishAuth(s: AuthSession): Promise<void> {
  const cloud = new BambuCloud(s.region);
  s.devices = await cloud.listDevices(s.token!);
  s.username = await cloud.resolveUsername(s.token!).catch(() => null);
  s.awaiting = undefined;
}

function cloudError(res: import("express").Response, e: unknown): void {
  const msg = e instanceof BambuCloudError ? e.message : (e as Error).message;
  res.status(e instanceof BambuCloudError && e.cloudflare ? 502 : 400).json({ error: { code: "bambu_cloud", message: msg } });
}

// ── POST /login {region, email, password} ────────────────────────────────────
const LoginBody = z.object({
  region: z.enum(BAMBU_REGIONS),
  email: z.string().min(3).max(200),
  password: z.string().min(1).max(200),
});
bambuRouter.post("/login", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  const { region, email, password } = parsed.data;
  const cloud = new BambuCloud(region);
  try {
    const r = await cloud.login(email, password);
    if (r.kind === "error") return void res.status(400).json({ error: { code: "bambu_cloud", message: r.detail } });
    if (r.kind === "needEmailCode") {
      await cloud.requestEmailCode(email);
      const session = putSession({ region, email, awaiting: "email", createdAt: Date.now() });
      return void res.json({ status: "need_email_code", session });
    }
    if (r.kind === "needTfa") {
      const session = putSession({ region, email, awaiting: "tfa", tfaKey: r.tfaKey, createdAt: Date.now() });
      return void res.json({ status: "need_tfa", session });
    }
    // direct token
    const s: AuthSession = { region, email, token: r.accessToken, createdAt: Date.now() };
    await finishAuth(s);
    const session = putSession(s);
    res.json({ status: "ready", session, devices: publicDevices(s.devices!) });
  } catch (e) {
    cloudError(res, e);
  }
}));

// ── POST /code {session, code} — email verify OR 2FA ─────────────────────────
const CodeBody = z.object({ session: z.string().uuid(), code: z.string().min(1).max(20) });
bambuRouter.post("/code", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const parsed = CodeBody.safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  prune();
  const s = sessions.get(parsed.data.session);
  if (!s) return void res.status(410).json({ error: { code: "expired", message: "Login session expired. Start again" } });
  const cloud = new BambuCloud(s.region);
  try {
    if (s.awaiting === "email") s.token = await cloud.submitEmailCode(s.email, parsed.data.code);
    else if (s.awaiting === "tfa") s.token = await cloud.submitTfaCode(s.tfaKey!, parsed.data.code);
    else return void res.status(400).json({ error: { code: "no_challenge", message: "Nothing to verify" } });
    await finishAuth(s);
    res.json({ status: "ready", session: parsed.data.session, devices: publicDevices(s.devices!) });
  } catch (e) {
    cloudError(res, e);
  }
}));

// ── POST /create {session, mode, label?} ─────────────────────────────────────
// One connection = the whole Bambu ACCOUNT. ALL the account's printers are
// stored (and returned), each linkable to a 3D-printer machine — the FDM-Monster
// "one manager, many devices" model. The browser gets the device list back so a
// caller (the New-3D-printer modal) can pre-fill + link the right printer.
const CreateBody = z.object({
  session: z.string().uuid(),
  mode: z.enum(["cloud", "lan", "hybrid"]),
  label: z.string().min(1).max(120).optional(),
});
bambuRouter.post("/create", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const parsed = CreateBody.safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  const caps = modeCapabilities(parsed.data.mode);
  if (!caps.available) return void res.status(400).json({ error: { code: "mode_unavailable", message: caps.note } });
  prune();
  const s = sessions.get(parsed.data.session);
  if (!s?.token || !s.devices) return void res.status(410).json({ error: { code: "expired", message: "Login session expired. Start again" } });

  const ctx = tenantContext(req);
  const mode = parsed.data.mode;
  const credDevices = s.devices.map((d) => ({ serial: d.dev_id, accessCode: d.access_code ?? "", name: d.name, model: d.model ?? "" }));
  const configDevices = s.devices.map((d) => ({ serial: d.dev_id, name: d.name, model: d.model ?? null, online: d.online }));
  const creds = { token: s.token, mqttUser: s.username ?? "", region: s.region, mode, account_email: s.email, devices: credDevices };
  const config = { mode, region: s.region, account_email: s.email, devices: configDevices };
  const store = platform().devices.connections();

  // Idempotent on the account: signing into the SAME Bambu account again refreshes
  // its existing connection (new token + device list, id preserved so machine
  // links survive) instead of spawning a duplicate that would split the fleet view
  // and clutter the account picker. Matched on the non-secret account_email.
  const email = s.email.toLowerCase();
  const existing = (await store.list(ctx.org.id))
    .find((c) => c.type === "bambu" && String((c.config as { account_email?: string }).account_email ?? "").toLowerCase() === email);

  let row;
  if (existing) {
    // Keep the user's chosen label + the same id; refresh secrets, mode, devices.
    row = await store.update(ctx.org.id, existing.id, { config, creds: creds as unknown as Record<string, string | null> });
    if (!row) return void res.status(500).json({ error: { code: "update_failed", message: "Couldn't refresh the Bambu connection" } });
  } else {
    row = await store.create(ctx.org.id, {
      type: "bambu",
      label: parsed.data.label?.trim() || `Bambu (${s.email})`,
      base_url: "bambu-cloud://account",
      // Secrets + per-device access codes ride in the encrypted creds blob;
      // config is the non-secret display copy (no access codes).
      creds,
      config,
    });
    void platform().events.emit("digifab.connection.created", { orgId: ctx.org.id, rowId: row.id });
  }
  sessions.delete(parsed.data.session); // one-shot
  res.status(existing ? 200 : 201).json({ connection: row, devices: publicDevices(s.devices), capabilities: caps });
}));

// ── GET /capabilities — the per-mode capability table, one source of truth ────
// So the UI can show what a connection can do (monitor/control) + WHY, and which
// modes are actually available, without duplicating the rules client-side.
bambuRouter.get("/capabilities", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin", "member")) return;
  res.json({ modes: { cloud: modeCapabilities("cloud"), lan: modeCapabilities("lan"), hybrid: modeCapabilities("hybrid") } });
}));

// ── POST /command — send a control command to a cloud Bambu over the MQTT the
// pump already holds (same broker the app uses). EXPERIMENTAL: the printer's
// Authorization Control may reject it; `sent:true` means published, not obeyed.
// Start with a harmless visible one (light_on/off, nudge) to confirm it works
// before pause/resume/stop.
const CommandBody = z.object({
  connection_id: z.string().min(1),
  serial: z.string().min(1),
  command: z.enum(["pause", "resume", "stop", "light_on", "light_off", "nudge"]),
});
bambuRouter.post("/command", asyncHandler(async (req, res) => {
  if (!requireRole(req, res, "owner", "admin")) return;
  const parsed = CommandBody.safeParse(req.body);
  if (!parsed.success) return badBody(res, parsed.error);
  const sent = sendBambuCommand(parsed.data.connection_id, parsed.data.serial, parsed.data.command);
  if (!sent) {
    return void res.status(503).json({ error: { code: "no_pump", message: "No live cloud stream for that printer right now. Try again in a moment." } });
  }
  res.json({ sent: true });
}));
