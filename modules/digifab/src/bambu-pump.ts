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

// sweep-pools: deferred-release ok — polls only orgs with live Bambu
// connections (a handful); the 15s deferred pool close in tenant.ts covers it.
import mqtt, { type MqttClient } from "mqtt";
import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { DigifabDB } from "./db.js";
import { bambuMqttHost, BAMBU_REGIONS, usernameFromToken, BambuCloud, type BambuRegion } from "./drivers/bambu-cloud.js";
import { mapCloudPrintStatus } from "./drivers/bambu-cloud-driver.js";
import { putBambuStatus, type BambuLiveStatus } from "./bambu-status-store.js";
import { evaluatePrintRules } from "./print-rules.js";

/** The print name from a Bambu report — the friendly subtask name, else the
 *  gcode filename (path + extension stripped). Used as both {{model}} and the
 *  print-session key for cadence resets. */
function modelOf(raw: Record<string, unknown>): string | null {
  if (typeof raw.subtask_name === "string" && raw.subtask_name.trim()) return raw.subtask_name.trim();
  if (typeof raw.gcode_file === "string" && raw.gcode_file.trim()) {
    return raw.gcode_file.replace(/^.*[\\/]/, "").replace(/\.(gcode|3mf)(\.\w+)?$/i, "").trim() || null;
  }
  return null;
}

/** Evaluate the user's print-update rules for one printer (best-effort). */
async function fireRulesFor(
  db: Kysely<DigifabDB>,
  orgId: string,
  connId: string,
  serial: string,
  status: BambuLiveStatus,
  prevState: string | null,
  model: string | null,
): Promise<void> {
  try {
    const link = await db
      .selectFrom("digifab_device_links")
      .select(["remote_device_name", "machine_label"])
      .where("connection_id", "=", connId)
      .where("remote_device_id", "=", serial)
      .executeTakeFirst();
    const deviceName = link?.machine_label || link?.remote_device_name || serial;
    await evaluatePrintRules(db, orgId, connId, serial, {
      deviceName,
      state: status.state,
      prevState,
      percent: status.progress,
      layer: status.layer_num,
      total_layers: status.total_layers,
      remaining_min: status.remaining_min,
      model,
      nozzle: status.temps.nozzle?.actual ?? null,
      bed: status.temps.bed?.actual ?? null,
      jobKey: model,
    });
  } catch {
    /* a rule failing never breaks telemetry */
  }
}
import { buildBambuLanDriver, parseBambuLan, bambuLanMode } from "./jobs-core.js";

const RECONCILE_MS = 60_000;
const LAN_POLL_MS = 15_000; // LAN telemetry (prefer-LAN / LAN-only printers)
const BOOT_DELAY_MS = 30_000;

interface PumpClient {
  client: MqttClient;
  orgId: string;
  region: string;
  serials: Set<string>;
  // Bambu streams partial reports; keep the merged `print` object per printer so
  // a delta that only carries `mc_percent` doesn't wipe the temps.
  accum: Map<string, Record<string, unknown>>;
  // Per-serial last mapped state + the in-flight print, so we can record an
  // OBSERVED print (printing → completed/failed) into history. Reset per session;
  // a print that finishes while the pump is down is missed (best-effort).
  lastState: Map<string, string>;
  printStart: Map<string, { file: string | null; at: Date }>;
  token: string;
  dumped: Set<string>; // serials whose full report we've logged once (debug)
}

// Keyed by connection id (a globally-unique uuid → tenant-safe).
const clients = new Map<string, PumpClient>();
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let lanHandle: ReturnType<typeof setInterval> | null = null;

export function startBambuPump(): void {
  if (intervalHandle) return;
  // SINGLE-PROCESS-SAFE: each api holds its OWN MQTT subscriptions and its own
  // LAN reads — telemetry has to be watched per process, and the status write
  // is last-writer-wins on the same numbers. What must NOT double is the
  // side effect further down: evaluatePrintRules claims each fire slot with a
  // compare-and-set (print-rules.ts claimFire), so two pumps watching one
  // printer still post once. That was found the hard way — a workspace's
  // printer posted its progress to Discord twice, every time (2026-08-29).
  intervalHandle = setInterval(safeReconcile, RECONCILE_MS);
  setTimeout(safeReconcile, BOOT_DELAY_MS); // let the platform finish wiring first
  lanHandle = setInterval(() => void pollLanTelemetry().catch(() => {}), LAN_POLL_MS);
  console.log(`[digifab] bambu cloud pump started — reconcile every ${RECONCILE_MS / 1000}s, LAN poll every ${LAN_POLL_MS / 1000}s`);
}

export function stopBambuPump(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  if (lanHandle) clearInterval(lanHandle);
  intervalHandle = null;
  lanHandle = null;
  for (const [connId] of clients) closeClient(connId);
}

/** Publish a command to a Bambu over the cloud MQTT connection the pump already
 *  holds — the SAME broker + request topic the official app uses. Returns false
 *  if there's no live client for that connection. The printer may still reject it
 *  (Bambu "Authorization Control" is a printer-side decision we can't see from the
 *  publish) — so a `true` here means "sent", not "obeyed". */
/** Publish a raw Bambu MQTT payload to a printer's request topic via the live
 *  cloud connection the pump holds (the broker the app uses). Returns false if no
 *  live client for that printer. The low-level seam the cloud driver's runControl
 *  builds on. */
export function publishBambu(connId: string, serial: string, payload: Record<string, unknown>): boolean {
  const pc = clients.get(connId);
  if (!pc || !pc.serials.has(serial)) return false;
  try {
    pc.client.publish(`device/${serial}/request`, JSON.stringify(payload));
    return true;
  } catch (e) {
    console.warn(`[digifab] bambu publish failed (${serial}):`, (e as Error).message);
    return false;
  }
}

/** Named-command convenience (the experimental cloud-test endpoint). */
export function sendBambuCommand(connId: string, serial: string, command: string): boolean {
  const seq = String(Date.now() % 100000);
  let payload: Record<string, unknown> | null = null;
  switch (command) {
    case "pause": payload = { print: { sequence_id: seq, command: "pause" } }; break;
    case "resume": payload = { print: { sequence_id: seq, command: "resume" } }; break;
    case "stop": payload = { print: { sequence_id: seq, command: "stop" } }; break;
    case "light_on": payload = { system: { sequence_id: seq, command: "ledctrl", led_node: "chamber_light", led_mode: "on" } }; break;
    case "light_off": payload = { system: { sequence_id: seq, command: "ledctrl", led_node: "chamber_light", led_mode: "off" } }; break;
    case "nudge": payload = { print: { sequence_id: seq, command: "gcode_line", param: "G91\nG1 Z3 F600\nG90\n" } }; break;
    default: return false;
  }
  const ok = publishBambu(connId, serial, payload);
  if (ok) console.log(`[digifab] bambu cloud command '${command}' → ${serial} (sent)`);
  return ok;
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

// LAN telemetry — for printers in prefer_lan / lan_only mode, pull their full
// report over the on-site bridge and write it as the live status. For lan_only
// it's the source of truth (cloud may be off at the printer); for prefer_lan
// it's the LAN-first source (cloud, if connected, is the fallback). Same report
// payload as cloud, so the fleet/detail render identically.
async function pollLanTelemetry(): Promise<void> {
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
  } catch {
    return;
  }
  const store = platform().devices.connections();
  for (const org of orgs) {
    let touched = false;
    try {
      const conns = (await store.list(org.id)).filter((c) => c.type === "bambu" && c.enabled);
      for (const c of conns) {
        const internal = await store.getInternal(org.id, c.id);
        if (!internal?.credentials_enc) continue;
        const creds = await platform().integrations.decryptCredentials(org.id, internal.credentials_enc);
        for (const [serial, lan] of Object.entries(parseBambuLan(creds))) {
          if (bambuLanMode(lan) === "cloud" || !lan.host || !lan.access_code) continue;
          try {
            const devices = await buildBambuLanDriver(org.id, serial, lan).listDevices();
            const raw = devices[0]?.raw;
            if (raw && typeof raw === "object" && Object.keys(raw).length) {
              const db = (await platform().tenants.getDb(org.id)) as Kysely<DigifabDB>;
              touched = true;
              const status = deriveStatus(raw as Record<string, unknown>);
              // prev state before we overwrite it — for the started/done transitions.
              const prevRow = await db.selectFrom("digifab_bambu_status").select(["state"]).where("connection_id", "=", c.id).where("serial", "=", serial).executeTakeFirst().catch(() => undefined);
              await putBambuStatus(db, c.id, serial, status);
              await db.updateTable("digifab_bambu_status").set({ report: JSON.stringify(raw) as unknown as Record<string, unknown> }).where("connection_id", "=", c.id).where("serial", "=", serial).execute().catch(() => {});
              await fireRulesFor(db, org.id, c.id, serial, status, prevRow?.state ?? null, modelOf(raw as Record<string, unknown>));
            }
          } catch {
            /* LAN unreachable (bridge offline / printer off) — keep the existing status */
          }
        }
      }
    } catch {
      /* skip this org this tick */
    } finally {
      if (touched) await platform().tenants.releaseIdleDb(org.id).catch(() => {});
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
  const pc: PumpClient = { client, orgId, region, serials: new Set(serials), accum: new Map(), lastState: new Map(), printStart: new Map(), token, dumped: new Set() };
  clients.set(connId, pc);

  client.on("connect", () => {
    console.log(`[digifab] bambu pump — MQTT connected ${connId}, subscribing ${serials.length} printer(s)`);
    for (const serial of serials) {
      client.subscribe(`device/${serial}/report`, { qos: 0 });
      // Ask for a full snapshot now; subsequent messages are deltas.
      client.publish(`device/${serial}/request`, JSON.stringify({ pushing: { sequence_id: "0", command: "pushall" } }));
    }
    // Capture EVERYTHING from the cloud history (model name, cover, weight, time)
    // — dump it to the logs once + store every task raw, keyed by task id.
    void dumpAndStoreCloudTasks(connId, orgId, region, token).catch((e) =>
      console.warn(`[digifab] bambu cloud-tasks dump failed (${connId}):`, (e as Error).message),
    );
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
  // Store the full live report (raw) + dump it once so we can see every field.
  await db.updateTable("digifab_bambu_status").set({ report: JSON.stringify(merged) as unknown as Record<string, unknown> }).where("connection_id", "=", connId).where("serial", "=", serial).execute().catch(() => {});
  if (!pc.dumped.has(serial)) {
    pc.dumped.add(serial);
    console.log(`[bambu-dump] REPORT keys ${serial}:`, Object.keys(merged).join(","));
    console.log(`[bambu-dump] REPORT ${serial}:`, JSON.stringify(merged).slice(0, 14000));
  }

  // Record an OBSERVED print on the printing → completed/failed transition, so a
  // print started from Bambu Studio (cloud Bambu is monitor-only) still lands in
  // history. Only when we actually saw it printing first — so the first report
  // after connect (an already-idle/finished printer) doesn't log a phantom.
  const newState = status.state ?? "";
  const prev = pc.lastState.get(serial);
  const file = (typeof merged.subtask_name === "string" && merged.subtask_name) || (typeof merged.gcode_file === "string" ? (merged.gcode_file as string) : null);
  if (newState === "printing" && prev !== "printing") {
    pc.printStart.set(serial, { file, at: new Date() });
    // Record the print IN PROGRESS now (ended_at null) so an externally-started
    // job shows in the list while it runs — deduped against an already-open row.
    const open = await db
      .selectFrom("digifab_observed_prints")
      .select("id")
      .where("connection_id", "=", connId)
      .where("serial", "=", serial)
      .where("status", "=", "printing")
      .where("ended_at", "is", null)
      .executeTakeFirst();
    if (!open) {
      await db
        .insertInto("digifab_observed_prints")
        .values({ connection_id: connId, serial, file_ref: file, status: "printing", started_at: new Date(), ended_at: null })
        .execute()
        .catch((e) => console.warn(`[digifab] observed-print start insert failed (${serial}):`, (e as Error).message));
    }
  } else if ((newState === "completed" || newState === "failed") && (prev === "printing" || prev === "paused")) {
    const start = pc.printStart.get(serial);
    pc.printStart.delete(serial);
    // Close the open in-progress row if one exists; else insert a terminal row.
    const open = await db
      .selectFrom("digifab_observed_prints")
      .select("id")
      .where("connection_id", "=", connId)
      .where("serial", "=", serial)
      .where("status", "=", "printing")
      .where("ended_at", "is", null)
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    if (open) {
      await db
        .updateTable("digifab_observed_prints")
        .set({ status: newState, ended_at: new Date(), ...((start?.file ?? file) ? { file_ref: start?.file ?? file } : {}) })
        .where("id", "=", open.id)
        .execute()
        .catch((e) => console.warn(`[digifab] observed-print close failed (${serial}):`, (e as Error).message));
    } else {
      await db
        .insertInto("digifab_observed_prints")
        .values({ connection_id: connId, serial, file_ref: start?.file ?? file, status: newState, started_at: start?.at ?? null, ended_at: new Date() })
        .execute()
        .catch((e) => console.warn(`[digifab] observed-print insert failed (${serial}):`, (e as Error).message));
    }
  } else if (prev === undefined && (newState === "completed" || newState === "failed") && file) {
    // BACKFILL: we connected to a printer ALREADY sitting on a finished print —
    // it completed while the pump was down, or before observed-capture shipped.
    // Record it once, deduped by Bambu's print start time (or a 12h window when
    // it's absent) so a pump restart doesn't re-log the same print.
    const startEpoch = Number(merged.gcode_start_time);
    const startedAt = Number.isFinite(startEpoch) && startEpoch > 0 ? new Date(startEpoch * 1000) : null;
    let q = db.selectFrom("digifab_observed_prints").select("id").where("connection_id", "=", connId).where("serial", "=", serial);
    q = startedAt ? q.where("started_at", "=", startedAt) : q.where("ended_at", ">", new Date(Date.now() - 12 * 3_600_000));
    const dup = await q.executeTakeFirst();
    if (!dup) {
      await db
        .insertInto("digifab_observed_prints")
        .values({ connection_id: connId, serial, file_ref: file, status: newState, started_at: startedAt, ended_at: new Date() })
        .execute()
        .catch((e) => console.warn(`[digifab] backfill insert failed (${serial}):`, (e as Error).message));
    }
  }
  await fireRulesFor(db, orgId, connId, serial, status, prev ?? null, file);
  if (newState) pc.lastState.set(serial, newState);
}

/** Fetch the cloud print-history, dump it to the logs (so we can see every field),
 *  and store every task raw (keyed by task id) — the model name, cover, weight,
 *  time live here, not in the MQTT report. */
async function dumpAndStoreCloudTasks(connId: string, orgId: string, region: string, token: string): Promise<void> {
  const r = (BAMBU_REGIONS as readonly string[]).includes(region) ? (region as BambuRegion) : "Other";
  const raw = await new BambuCloud(r).rawTasks(token, 50);
  console.log(`[bambu-dump] CLOUD TASKS ${connId}:`, JSON.stringify(raw).slice(0, 14000));
  const hits = raw && typeof raw === "object" && Array.isArray((raw as { hits?: unknown }).hits) ? (raw as { hits: Record<string, unknown>[] }).hits : [];
  if (hits.length === 0) return;
  const db = (await platform().tenants.getDb(orgId)) as Kysely<DigifabDB>;
  let stored = 0;
  for (const t of hits) {
    const taskId = String(t.id ?? t.designId ?? "");
    if (!taskId) continue;
    const rawVal = JSON.stringify(t) as unknown as Record<string, unknown>;
    await db
      .insertInto("digifab_bambu_tasks")
      .values({ connection_id: connId, task_id: taskId, raw: rawVal })
      .onConflict((oc) => oc.columns(["connection_id", "task_id"]).doUpdateSet({ raw: rawVal, captured_at: new Date() }))
      .execute()
      .then(() => { stored++; })
      .catch((e) => console.warn(`[digifab] task store failed (${taskId}):`, (e as Error).message));
  }
  console.log(`[bambu-dump] stored ${stored} cloud tasks for ${connId}`);
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
