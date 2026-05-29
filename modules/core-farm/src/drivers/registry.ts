// Driver registry — maps a connection's `type` to a FarmDriver instance.
// New farm backends register here behind the one interface.

import type { FarmConnectionConfig, FarmDriver } from "./types.js";
import { fdmMonsterFactory } from "./fdm-monster.js";
import { MockFarmDriver } from "./mock.js";

export const FARM_TYPES = ["fdm_monster", "mock"] as const;
export type FarmType = (typeof FARM_TYPES)[number];

// The mock keeps in-memory job state, so it must be the SAME instance
// across requests for a given connection (else a poll can't see the job
// a send created). Real drivers are stateless HTTP clients — a fresh one
// per call is fine.
const mockInstances = new Map<string, MockFarmDriver>();

export function driverFor(
  type: string,
  cfg: FarmConnectionConfig,
  connectionId: string,
): FarmDriver {
  if (type === "fdm_monster") return fdmMonsterFactory(cfg);
  if (type === "mock") {
    let m = mockInstances.get(connectionId);
    if (!m) {
      m = new MockFarmDriver();
      mockInstances.set(connectionId, m);
    }
    return m;
  }
  throw new Error(`unknown farm type: ${type}`);
}
