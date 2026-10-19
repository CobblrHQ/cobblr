// A Bambu printer's LAN access, stored with its connection: the host and access
// code that let the on-site bridge push files and control the printer over its
// LAN while the cloud keeps doing telemetry. The access code is a credential, so
// it is stored encrypted in the connection's creds (creds.bambu_lan = { serial:
// { host, access_code, mode } }). The core's /fleet/:connectionId/:deviceId/lan
// routes and the printer modal call these through core/families.ts deviceLan.
import { platform } from "@cobblr/platform-contract";
import { optionalField, optionalText } from "@cobblr/platform-contract/optional-fields";
import { z } from "zod";
import { bambuLanMode, parseBambuLan, type BambuLan } from "../bambu/bambu-lan.js";

const LanBody = z.object({
  host: optionalText(200),
  access_code: optionalText(64),
  mode: optionalField(z.enum(["cloud", "prefer_lan", "lan_only"])),
});

async function readLanMap(orgId: string, connId: string): Promise<{ conn: { id: string; type: string; credentials_enc: string | null } | null; map: Record<string, BambuLan> }> {
  const conn = await platform().devices.connections().getInternal(orgId, connId);
  if (!conn) return { conn: null, map: {} };
  const creds = conn.credentials_enc ? await platform().integrations.decryptCredentials(orgId, conn.credentials_enc) : {};
  return { conn: { id: conn.id, type: conn.type, credentials_enc: conn.credentials_enc }, map: parseBambuLan(creds) };
}

/** The LAN state the printer modal shows: host only, never the access code. */
export async function readBambuLanAccess(orgId: string, connectionId: string, deviceId: string) {
  const { conn, map } = await readLanMap(orgId, connectionId);
  const cfg = map[deviceId];
  return { applicable: conn?.type === "bambu", configured: !!cfg, host: cfg?.host, mode: bambuLanMode(cfg), camera: !!cfg && bambuLanMode(cfg) !== "cloud" };
}

/** Turn LAN on or change its mode. Merges: host and access code on first enable; mode can change on its own later. */
export async function writeBambuLanAccess(orgId: string, connectionId: string, deviceId: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const parsed = LanBody.safeParse(body);
  if (!parsed.success) return { status: 400, body: { error: { code: "bad_body", message: "host + access_code required" } } };
  const { conn, map } = await readLanMap(orgId, connectionId);
  if (!conn || conn.type !== "bambu") return { status: 400, body: { error: { code: "not_bambu", message: "LAN access is for Bambu connections" } } };
  const prev = map[deviceId] ?? { host: "", access_code: "" };
  const host = (parsed.data.host ?? prev.host).trim();
  const access_code = (parsed.data.access_code ?? prev.access_code).trim();
  if (!host || !access_code) return { status: 400, body: { error: { code: "incomplete", message: "host + access_code required to enable LAN" } } };
  map[deviceId] = { host, access_code, mode: parsed.data.mode ?? prev.mode ?? "prefer_lan" };
  await platform().devices.connections().update(orgId, conn.id, { creds: { bambu_lan: JSON.stringify(map) } });
  return { status: 200, body: { ok: true, host, mode: map[deviceId]!.mode } };
}

/** Forget a printer's stored LAN access. */
export async function removeBambuLanAccess(orgId: string, connectionId: string, deviceId: string): Promise<{ status: number; body: unknown }> {
  const { conn, map } = await readLanMap(orgId, connectionId);
  if (!conn) return { status: 404, body: { error: { code: "not_found", message: "no such connection" } } };
  delete map[deviceId];
  await platform().devices.connections().update(orgId, conn.id, { creds: { bambu_lan: JSON.stringify(map) } });
  return { status: 200, body: { ok: true } };
}

/** The printers on a Bambu connection whose camera is reachable over its LAN. */
export async function bambuLanCameras(orgId: string, connection: { id: string; type: string }): Promise<ReadonlySet<string>> {
  const out = new Set<string>();
  if (connection.type !== "bambu") return out;
  try {
    const internal = await platform().devices.connections().getInternal(orgId, connection.id);
    if (internal?.credentials_enc) {
      for (const [id, lan] of Object.entries(parseBambuLan(await platform().integrations.decryptCredentials(orgId, internal.credentials_enc)))) {
        if (lan?.host && lan?.access_code && bambuLanMode(lan) !== "cloud") out.add(id);
      }
    }
  } catch {
    /* creds unreadable → no LAN camera flag, nothing else degrades */
  }
  return out;
}
