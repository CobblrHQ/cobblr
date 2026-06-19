// /api/v1/orgs/:slug/modules/digifab/bambu — the cloud-login connect wizard.
//
// The Bambu account token is a SECRET, so it never reaches the browser: the
// multi-step flow (login → email/2FA code → pick printer → create) is held in a
// short-lived SERVER-SIDE session keyed by an opaque id. The browser only ever
// sees the printer list (names/models/online), never the token or access codes.
// On create we store the token + the chosen printer's LAN access code ENCRYPTED.
//
// Phase 1 ships CLOUD mode (monitor-only — see BambuCloudDriver). LAN/hybrid
// control is disclosed but disabled until the edge-bridge path (Phase 3).

import { Router } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { platform } from "@cobblr/platform-contract";
import { tenantContext } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { BambuCloud, BambuCloudError, BAMBU_REGIONS, type BambuRegion, type BambuCloudDevice } from "../drivers/bambu-cloud.js";

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
      return { monitor: true, control: false, available: true, note: "Live status, temps & progress. Remote start/pause isn't possible over the cloud — Bambu blocks third-party control." };
    case "lan":
      return { monitor: true, control: true, available: false, note: "Full control (start/pause/cancel) — needs Developer Mode on the printer + the Cobblr edge-bridge on your network. Coming soon." };
    case "hybrid":
      return { monitor: true, control: true, available: false, note: "Cloud login + local control. Needs Developer Mode + the edge-bridge. Coming soon." };
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
  if (!s) return void res.status(410).json({ error: { code: "expired", message: "Login session expired — start again" } });
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
  if (!s?.token || !s.devices) return void res.status(410).json({ error: { code: "expired", message: "Login session expired — start again" } });

  const ctx = tenantContext(req);
  const mode = parsed.data.mode;
  const credDevices = s.devices.map((d) => ({ serial: d.dev_id, accessCode: d.access_code ?? "", name: d.name, model: d.model ?? "" }));
  const configDevices = s.devices.map((d) => ({ serial: d.dev_id, name: d.name, model: d.model ?? null, online: d.online }));
  const row = await platform().devices.connections().create(ctx.org.id, {
    type: "bambu",
    label: parsed.data.label?.trim() || `Bambu (${s.email})`,
    base_url: "bambu-cloud://account",
    // Secrets + per-device access codes ride in the encrypted creds blob.
    creds: { token: s.token, mqttUser: s.username ?? "", region: s.region, mode, account_email: s.email, devices: credDevices },
    // Non-secret display copy for the UI (no access codes).
    config: { mode, region: s.region, account_email: s.email, devices: configDevices },
  });
  sessions.delete(parsed.data.session); // one-shot
  void platform().events.emit("digifab.connection.created", { orgId: ctx.org.id, rowId: row.id });
  res.status(201).json({ connection: row, devices: publicDevices(s.devices), capabilities: caps });
}));
