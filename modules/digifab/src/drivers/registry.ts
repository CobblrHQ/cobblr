// Driver registry — resolves a connection's driver `type` (key) to a live
// MachineDriver. Built-ins (fdm_monster, mock) are code; everything else is an
// INSTALLED driver from digifab_drivers (declarative manifest or, later,
// edge-adapter) — so a user adds a new machine manager without a deploy.
// See docs/modules/digifab-drivers.md.

import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import type { ManagerConfig, MachineDriver } from "./types.js";
import { fdmMonsterFactory } from "./fdm-monster.js";
import { MockDriver } from "./mock.js";
import { DeclarativeDriver } from "./declarative.js";
import { EdgeAdapterDriver, type EdgeRelay } from "./edge-adapter.js";
import { BambuCloudDriver } from "./bambu-cloud-driver.js";
import { ElegooSdcpDriver } from "./elegoo-sdcp.js";
import { DriverManifest } from "./manifest.js";

/** Built-in drivers — always available, ship in code, reference impls. */
export const BUILTIN_DRIVERS = [
  { key: "fdm_monster", name: "FDM Monster", kind: "builtin" as const },
  { key: "edge_adapter", name: "Edge adapter (your bridge)", kind: "builtin" as const },
  { key: "bambu", name: "Bambu Lab", kind: "builtin" as const },
  // SDCP is WebSocket+UDP, not REST — can't be a declarative manifest, so it
  // ships as code like Bambu. Hardware-unverified (see the driver header).
  { key: "elegoo_sdcp", name: "Elegoo (SDCP)", kind: "builtin" as const },
  { key: "mock", name: "Mock (test)", kind: "builtin" as const },
];
const BUILTIN_KEYS = new Set(BUILTIN_DRIVERS.map((d) => d.key));

// The mock keeps in-memory job state, so it must be the SAME instance
// across requests for a connection. HTTP drivers are stateless.
const mockInstances = new Map<string, MockDriver>();

/** Resolve the driver for a connection's `type` (key). Built-in or installed. */
export async function resolveDriver(
  db: Kysely<DigifabDB>,
  type: string,
  cfg: ManagerConfig,
  connectionId: string,
  relay?: EdgeRelay | null,
): Promise<MachineDriver> {
  if (type === "fdm_monster") return fdmMonsterFactory(cfg);
  // A tunnelled edge_adapter connection routes through the cloud→edge relay
  // (base_url cobblr-edge://); a direct one dials the bridge URL.
  if (type === "edge_adapter") return new EdgeAdapterDriver(cfg, relay ?? null);
  // Bambu Lab: cloud-mode does telemetry + light/pause/stop over Bambu's API
  // (creds in cfg.extra.creds); full control + the camera route over the LAN
  // edge-bridge (edge_adapter), either pure-LAN or per-printer hybrid.
  if (type === "bambu") return new BambuCloudDriver(cfg, connectionId);
  // Elegoo Centauri (and other SDCP V3 printers): UDP discovery + WS commands
  // + chunked HTTP upload, all on the printer itself. Stateless per call.
  if (type === "elegoo_sdcp") return new ElegooSdcpDriver(cfg);
  if (type === "mock") {
    let m = mockInstances.get(connectionId);
    if (!m) {
      m = new MockDriver();
      mockInstances.set(connectionId, m);
    }
    return m;
  }
  // Installed driver.
  const row = await db
    .selectFrom("digifab_drivers")
    .select(["kind", "spec"])
    .where("key", "=", type)
    .where("enabled", "=", true)
    .executeTakeFirst();
  if (!row) throw new Error(`unknown driver: ${type}`);
  if (row.kind === "declarative") {
    const manifest = DriverManifest.parse(row.spec);
    return new DeclarativeDriver(manifest, cfg);
  }
  throw new Error(`driver kind "${row.kind}" is not supported yet`);
}

/** Keys a connection may use: built-ins + this workspace's installed drivers. */
export async function availableDriverKeys(db: Kysely<DigifabDB>): Promise<string[]> {
  const installed = await db.selectFrom("digifab_drivers").select("key").where("enabled", "=", true).execute();
  return [...BUILTIN_KEYS, ...installed.map((r) => r.key)];
}
