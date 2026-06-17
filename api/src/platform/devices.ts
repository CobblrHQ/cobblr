// Platform device seam runtime — a single registered driver provider that builds
// a DeviceDriver from a connection ref. The connection/driver OWNER registers the
// provider (digifab today; core-devices after the connections move); consumers
// (the core-devices actuator, etc.) call getDriver() without owning connections.
// See docs/architecture/core-devices-extraction.md §2.

import type {
  DeviceDriver,
  DeviceDriverProvider,
  DeviceConnectionStore,
} from "@cobblr/platform-contract";

let provider: DeviceDriverProvider | null = null;
let store: DeviceConnectionStore | null = null;

export function registerDriverProvider(p: DeviceDriverProvider): void {
  provider = p;
}

export async function getDriver(orgId: string, connectionRef: string): Promise<DeviceDriver | null> {
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
