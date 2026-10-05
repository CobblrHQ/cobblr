// Platform device seam runtime — registered driver providers that build
// a DeviceDriver from a connection ref. The connection/driver OWNER registers the
// provider (digifab today; core-devices after the connections move); consumers
// (the core-devices actuator, etc.) call getDriver() without owning connections.
// See docs/architecture/core-devices-extraction.md §2.

import type {
  DeviceDriver,
  DeviceDriverProvider,
  DeviceConnectionStore,
  MachineStationVerifier,
  MachineStationRequest,
  MachineRecordsProvider,
} from "@cobblr/platform-contract";

let provider: DeviceDriverProvider | null = null;
const typedProviders = new Map<string, DeviceDriverProvider>();
let store: DeviceConnectionStore | null = null;

export function registerDriverProvider(p: DeviceDriverProvider, types?: readonly string[]): void {
  if (types?.length) { for (const type of types) typedProviders.set(type, p); }
  else provider = p;
}

export async function getDriver(orgId: string, connectionRef: string): Promise<DeviceDriver | null> {
  if (typedProviders.size && store) {
    const connection = await store.getInternal(orgId, connectionRef);
    const typed = connection && typedProviders.get(connection.type);
    if (typed) return typed(orgId, connectionRef);
  }
  if (!provider) return null;
  return provider(orgId, connectionRef);
}

export function registerConnectionStore(s: DeviceConnectionStore): void {
  store = s;
}

export function connections(): DeviceConnectionStore {
  if (!store) throw new Error("device connection store not registered — core-devices must load");
  return store;
}

let stationVerifier: MachineStationVerifier | null = null;
export function registerStationVerifier(verifier: MachineStationVerifier): void { stationVerifier = verifier; }
export async function authorizeAtStation(orgId: string, request: MachineStationRequest) {
  if (!stationVerifier) throw new Error("Install machine station support before Start.");
  return stationVerifier(orgId, request);
}

let machineProvider: MachineRecordsProvider | null = null;
export function registerMachineRecords(p: MachineRecordsProvider): void { machineProvider = p; }
export async function machineRecords(orgId: string, userId?: string | null) {
  if (!machineProvider) throw new Error("Install Machines before preparing a manufacturing job.");
  return machineProvider.list(orgId, userId);
}
export async function machineRecord(orgId: string, kind: string, id: string, userId?: string | null) {
  if (!machineProvider) throw new Error("Install Machines before authorizing this station.");
  return machineProvider.get(orgId, kind, id, userId);
}
