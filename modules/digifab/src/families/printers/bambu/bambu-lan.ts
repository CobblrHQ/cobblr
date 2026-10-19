// A Bambu printer's LAN access (hybrid): the host and access code stored per
// printer in its Bambu connection's credentials (creds.bambu_lan, keyed by
// serial), and the edge-routed LAN driver built from them, which the core's
// send, controls and camera prefer over the cloud (core/families.ts
// preferredDriver).
import { platform } from "@cobblr/platform-contract";
import { buildEdgeRelay } from "../../../jobs-core.js";
import { EdgeAdapterDriver } from "../../../drivers/edge-adapter.js";
import type { MachineDriver } from "../../../drivers/types.js";

/** Per-printer transport mode: all cloud / prefer LAN (cloud fallback) / LAN only
 *  (cloud off, accept losing cloud-only history). Default = prefer_lan once LAN
 *  is configured. */
export type BambuLanMode = "cloud" | "prefer_lan" | "lan_only";
export type BambuLan = { host: string; access_code: string; mode?: BambuLanMode };
export function bambuLanMode(lan: BambuLan | undefined): BambuLanMode {
  return lan?.mode ?? (lan?.host ? "prefer_lan" : "cloud");
}
export function parseBambuLan(creds: Record<string, unknown>): Record<string, BambuLan> {
  try {
    const m = JSON.parse(String(creds.bambu_lan ?? "{}")) as Record<string, BambuLan>;
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

/** Build the edge-routed `bambu` LAN driver for one printer — the bridge dials
 *  the printer over `mqtts://host:8883` (+ FTPS file push) using the access code.
 *  Each printer is its own bridge instance (`bambu-<serial>`); rides the org's
 *  default bridge channel (same bridge that serves the workspace's other LAN
 *  machines). */
export function buildBambuLanDriver(orgId: string, serial: string, lan: BambuLan, bridge?: string | null): MachineDriver {
  const baseUrl = `cobblr-edge://bambu-${serial}`;
  const relay = buildEdgeRelay(orgId, baseUrl, { driver: "bambu", transport: "lan", host: lan.host, serial, accessCode: lan.access_code, ...(bridge ? { bridge } : {}) } as Record<string, unknown>, null);
  return new EdgeAdapterDriver({ baseUrl, apiKey: null, username: null, password: null, extra: {} }, relay);
}

/** If this connection is Bambu AND `deviceId` has LAN config, return the LAN
 *  driver (for file-push/control); else null (cloud handles it). */
export async function bambuLanDriverFor(orgId: string, connectionRef: string, deviceId: string): Promise<MachineDriver | null> {
  const conn = await platform().devices.connections().getInternal(orgId, connectionRef);
  if (!conn || conn.type !== "bambu" || !conn.credentials_enc) return null;
  const creds = await platform().integrations.decryptCredentials(orgId, conn.credentials_enc);
  const lan = parseBambuLan(creds)[deviceId];
  // "All cloud" mode ignores LAN even if the host/code are stored.
  if (!lan?.host || !lan?.access_code || bambuLanMode(lan) === "cloud") return null;
  return buildBambuLanDriver(orgId, deviceId, lan);
}
