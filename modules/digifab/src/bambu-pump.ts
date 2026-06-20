// The live Bambu cloud pump. A "Bambu Lab" connection in CLOUD mode is an
// account; its status over plain HTTP is slow + coarse. Bambu also exposes a
// per-printer MQTT stream on its cloud broker (the same one the official app
// uses), which pushes temps / progress / state in real time. This worker holds
// ONE MQTT connection per Bambu account and writes each report into
// digifab_bambu_status; the fleet reads it (fresh) and overlays it on the card.
//
// Shape: a reconcile loop (every RECONCILE_MS) enumerates every org with digifab
// enabled, finds its cloud Bambu connections, and ensures an MQTT client per
// connection — opening new ones, closing ones whose connection was removed. Each
// client subscribes to `device/<serial>/report`, asks for a full `pushall` on
// connect, then merges the deltas Bambu streams and writes the latest snapshot.
//
// Monitor-only, like the cloud driver: we never publish a control command, only
// subscribe + the one pushall request. Cross-tenant pool discipline: the message
// handler writes through the cached tenant pool; a closed client releases it.

import mqtt, { type MqttClient } from "mqtt";
import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "./db.js";
import { bambuMqttHost, BAMBU_REGIONS, usernameFromToken, type BambuRegion } from "./drivers/bambu-cloud.js";
import { mapCloudPrintStatus } from "./drivers/bambu-cloud-driver.js";
import { putBambuStatus, type BambuLiveStatus } from "./bambu-status-store.js";

const RECONCILE_MS = 60_000;
const BOOT_DELAY_MS = 30_000;

interface PumpClient {
  client: MqttClient;
  orgId: string;
  region: string;
  serials: Set<string>;
  // Bambu streams partial reports; keep the merged `print` object per printer so
  // a delta that only carries `mc_percent` doesn't wipe the temps.
  accum: Map<string, Record<string, unknown>>;
}

// Keyed by connection id (a globally-unique uuid → tenant-safe).
const clients = new Map<string, PumpClient>();
let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startBambuPump(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(safeReconcile, RECONCILE_MS);
  setTimeout(safeReconcile, BOOT_DELAY_MS); // let the platform finish wiring first
  console.log(`[digifab] bambu cloud pump started — reconcile every ${RECONCILE_MS / 1000}s`);
}

export function stopBambuPump(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  for (const [connId] of clients) closeClient(connId);
}

async function safeReconcile(): Promise<void> {
  try {
    await reconcile();
  } catch (err) {
    console.error("[digifab] bambu pump reconcile failed:", (err as Error).message);
  }
}

interface CloudCreds {
  token?: string;
  mqttUser?: string;
  region?: string;
  mode?: string;
  devices?: { serial?: string }[];
}

async function reconcile(): Promise<void> {
  const meta = platform().db.meta as unknown as Kysely<{
    orgs: { id: string };
    org_modules: { org_id: string; module_name: string };
  }>;
  let orgs: { id: string }[];
  try {
    orgs = await meta
      .selectFrom("orgs")
      .innerJoin("org_modules", "org_modules.org_id", "orgs.id")
      .select(["orgs.id"])
      .where("org_modules.module_name", "=", "digifab")
      .execute();
  } catch (err) {
    console.warn("[digifab] bambu pump — meta read failed:", (err as Error).message);
    return;
  }

  const wanted = new Set<string>();
  const store = platform().devices.connections();
  for (const org of orgs) {
    let conns;
    try {
      conns = (await store.list(org.id)).filter(
        (c) => c.type === "bambu" && c.enabled && (c.config as { mode?: string }).mode === "cloud",
      );
    } catch {
      continue;
    }
    for (const c of conns) {
      wanted.add(c.id);
      if (clients.has(c.id)) continue; // already streaming
      try {
        const internal = await store.getInternal(org.id, c.id);
        if (!internal?.credentials_enc) continue;
        const creds = (await platform().integrations.decryptCredentials(org.id, internal.credentials_enc)) as CloudCreds;
        const token = String(creds.token ?? "");
        // The stored mqttUser can be blank (login-time resolveUsername failed);
        // the username is also encoded in the JWT, so derive it as a fallback.
        const user = String(creds.mqttUser ?? "") || usernameFromToken(token) || "";
        const serials = (creds.devices ?? []).map((d) => String(d.serial ?? "")).filter(Boolean);
        if (!token || !user || serials.length === 0) {
          console.warn(`[digifab] bambu pump — skip ${c.id}: token=${!!token} user=${!!user} printers=${serials.length}`);
          continue;
        }
        console.log(`[digifab] bambu pump — opening MQTT for ${c.id} (${serials.length} printer(s))`);
        openClient(c.id, org.id, String(creds.region ?? "North America"), user, token, serials);
      } catch (err) {
        console.warn(`[digifab] bambu pump — could not open ${c.id}:`, (err as Error).message);
      }
    }
  }

  // Close clients whose connection was removed / disabled / switched off cloud.
  for (const [connId, pc] of clients) {
    if (!wanted.has(connId)) {
      closeClient(connId);
      void platform().tenants.releaseIdleDb(pc.orgId);
    }
  }
}

function openClient(connId: string, orgId: string, region: string, user: string, token: string, serials: string[]): void {
  const r = (BAMBU_REGIONS as readonly string[]).includes(region) ? (region as BambuRegion) : "Other";
  const url = `mqtts://${bambuMqttHost(r)}:8883`;
  // Bambu's broker presents a cert Node doesn't chain to a public root; the
  // official app + pybambu skip verification here too. We only ever subscribe.
  const client = mqtt.connect(url, {
    username: user,
    password: token,
    rejectUnauthorized: false,
    reconnectPeriod: 30_000,
    connectTimeout: 15_000,
    clientId: `cobblr_${connId.slice(0, 8)}_${Date.now().toString(36)}`,
    protocolVersion: 4,
  });
  const pc: PumpClient = { client, orgId, region, serials: new Set(serials), accum: new Map() };
  clients.set(connId, pc);

  client.on("connect", () => {
    console.log(`[digifab] bambu pump — MQTT connected ${connId}, subscribing ${serials.length} printer(s)`);
    for (const serial of serials) {
      client.subscribe(`device/${serial}/report`, { qos: 0 });
      // Ask for a full snapshot now; subsequent messages are deltas.
      client.publish(`device/${serial}/request`, JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } }));
    }
  });

  client.on("message", (topic, payload) => {
    const serial = /^device\/(.+)\/report$/.exec(topic)?.[1];
    if (!serial) return;
    void handleReport(connId, orgId, serial, payload).catch((e) =>
      console.warn(`[digifab] bambu pump — report write failed (${serial}):`, (e as Error).message),
    );
  });

  client.on("error", (err) => console.warn(`[digifab] bambu pump — mqtt error (${connId}):`, err.message));
}

function closeClient(connId: string): void {
  const pc = clients.get(connId);
  if (!pc) return;
  try {
    pc.client.end(true);
  } catch {
    /* already gone */
  }
  clients.delete(connId);
}

/** Merge a (possibly partial) report into the printer's accumulator and persist
 *  the latest derived status. */
async function handleReport(connId: string, orgId: string, serial: string, payload: Buffer): Promise<void> {
  const pc = clients.get(connId);
  if (!pc) return;
  let msg: { print?: Record<string, unknown> };
  try {
    msg = JSON.parse(payload.toString("utf8"));
  } catch {
    return;
  }
  if (!msg.print || typeof msg.print !== "object") return;
  const merged = { ...(pc.accum.get(serial) ?? {}), ...msg.print };
  pc.accum.set(serial, merged);

  const status = deriveStatus(merged);
  const db = (await platform().tenants.getDb(orgId)) as Kysely<DigifabDB>;
  await putBambuStatus(db, connId, serial, status);
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Bambu `print` report → our normalized live status. */
export function deriveStatus(p: Record<string, unknown>): BambuLiveStatus {
  const nozzleActual = num(p.nozzle_temper);
  const bedActual = num(p.bed_temper);
  const chamberActual = num(p.chamber_temper);
  return {
    state: typeof p.gcode_state === "string" ? mapCloudPrintStatus(p.gcode_state, true) : null,
    stage: null,
    temps: {
      nozzle: nozzleActual != null ? { actual: nozzleActual, target: num(p.nozzle_target_temper) ?? undefined } : null,
      bed: bedActual != null ? { actual: bedActual, target: num(p.bed_target_temper) ?? undefined } : null,
      chamber: chamberActual != null ? { actual: chamberActual } : null,
    },
    progress: num(p.mc_percent),
    remaining_min: num(p.mc_remaining_time),
    layer_num: num(p.layer_num),
    total_layers: num(p.total_layer_num),
  };
}
