import type { ResolvedEntity } from "@cobblr/platform-contract/entity-resolvers";

// ── Device substrate seam ────────────────────────────────────────────────────
// Lets a device-touching consumer (the core-devices actuator today; core-print,
// other modules later) reach a DEVICE without owning the connection table or the
// driver registry. The owner of those (digifab today; core-devices after the
// connections move) REGISTERS a provider; consumers call getDriver(). This is the
// `platform().devices` half of the core-devices extraction
// (docs/architecture/core-devices-extraction.md §2) — start of the substrate move
// that doesn't require migrating the connections table.

/** The generic device contract — what EVERY connection can do. Fabrication
 *  drivers (digifab) extend this with file→job→status; a structural superset is
 *  assignable here, so a MachineDriver satisfies it. */
export interface DeviceDriver {
  testConnection?(): Promise<{ ok: boolean; detail?: string }>;
  listDevices?(): Promise<Array<{ id: string; name: string; state?: string | null; enabled?: boolean }>>;
  /** The actuator verb — fire a parameterised command-and-forget. */
  runCommand?(command: string, params: Record<string, unknown>): Promise<{ ok: boolean; ref?: string; detail?: string; data?: Record<string, unknown> }>;
  /** The sensor verb — a point reading. */
  readSensor?(deviceId: string): Promise<{ value: number; unit?: string; at?: string }>;
}

/** Build a driver from a connection ref (id OR label). null when unresolved. */
export type DeviceDriverProvider = (orgId: string, connectionRef: string) => Promise<DeviceDriver | null>;

/** A device connection as returned to clients — NEVER includes credentials. */
export interface DeviceConnectionPublic {
  id: string;
  type: string;
  label: string;
  base_url: string;
  /** WHETHER a credential is stored, never what it is. Callers need this to say
   *  "this needs a token and has none" without being handed the secret, and it
   *  cannot be inferred from `config`: credentials live encrypted in their own
   *  column, so `config` is empty on a connection that authenticates perfectly
   *  well. Reading `config.api_key` to answer this reports "no token" for every
   *  connection that has one. */
  has_credentials: boolean;
  config: Record<string, unknown>;
  enabled: boolean;
  capabilities: Record<string, unknown>;
  last_sync_at: string | Date | null;
  last_sync_status: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

/** Internal shape for building a driver — carries the encrypted credentials. */
export interface DeviceConnectionInternal {
  id: string;
  type: string;
  base_url: string;
  credentials_enc: string;
}

export interface DeviceConnectionCreate {
  type: string;
  label: string;
  base_url: string;
  /** Raw credential fields — the store encrypts them. */
  creds?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface DeviceConnectionPatch {
  label?: string;
  base_url?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  /** Raw credential fields to merge; a null value clears that field. */
  creds?: Record<string, unknown>;
}

/** The connection store — implemented by the owner of the connections table
 *  (core-devices); a connection-MANAGING consumer (digifab's CRUD routes) calls
 *  it so the table can live in one place without cross-module table access. */
export interface DeviceConnectionStore {
  list(orgId: string): Promise<DeviceConnectionPublic[]>;
  /** Public shape (no creds) by id. */
  get(orgId: string, id: string): Promise<DeviceConnectionPublic | null>;
  /** Internal shape (with creds) by id OR case-insensitive label — for driver building. */
  getInternal(orgId: string, ref: string): Promise<DeviceConnectionInternal | null>;
  create(orgId: string, input: DeviceConnectionCreate): Promise<DeviceConnectionPublic>;
  update(orgId: string, id: string, patch: DeviceConnectionPatch): Promise<DeviceConnectionPublic | null>;
  remove(orgId: string, id: string): Promise<boolean>;
  /** Stamp the cached probe result (capabilities + last_sync) after a test. */
  setProbe(orgId: string, id: string, capabilities: Record<string, unknown>, status: string): Promise<void>;
}

export interface MachineStationRequest { machine_kind: string; machine_id: string; purpose: "placement" | "reflow" | "inspection"; token: string }
export type MachineStationVerifier = (orgId: string, request: MachineStationRequest) => Promise<{ id: string; label: string }>;

export interface MachineRecordsProvider {
  list(orgId: string, userId?: string | null): Promise<Array<{ kind: string; record: ResolvedEntity }>>;
  get(orgId: string, kind: string, id: string, userId?: string | null): Promise<ResolvedEntity | null>;
}

export interface PlatformDevices {
  registerMachineRecords(provider: MachineRecordsProvider): void;
  machineRecords(orgId: string, userId?: string | null): ReturnType<MachineRecordsProvider["list"]>;
  machineRecord(orgId: string, kind: string, id: string, userId?: string | null): ReturnType<MachineRecordsProvider["get"]>;
  registerStationVerifier(verifier: MachineStationVerifier): void;
  authorizeAtStation(orgId: string, request: MachineStationRequest): Promise<{ id: string; label: string }>;
  /** The connection/driver owner registers this at boot (one provider). */
  registerDriverProvider(provider: DeviceDriverProvider, types?: readonly string[]): void;
  /** Resolve a connection ref to a driver via the registered provider. */
  getDriver(orgId: string, connectionRef: string): Promise<DeviceDriver | null>;
  /** The connections-table owner (core-devices) registers the store at boot. */
  registerConnectionStore(store: DeviceConnectionStore): void;
  /** The connection store, for a connection-managing consumer (digifab CRUD).
   *  Throws if no store is registered (core-devices always registers one). */
  connections(): DeviceConnectionStore;
}
