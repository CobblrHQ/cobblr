// Boot: size this api's pools to the server it talks to (connection-budget.ts).
import { metaPool } from "./meta.js";
import { sweepGate } from "./sweep-gate.js";
import { CONFIGURED_TENANT_POOLS, TENANT_POOL_MAX, setTenantPoolCap } from "./tenant.js";
import { connectionBudget, recordAppliedBudget } from "./connection-budget.js";
import { LOCK_CONNECTIONS } from "../platform/exclusive.js";
import { notePassFailure } from "../platform/pass-failures.js";

export async function applyConnectionBudget(): Promise<void> {
  try {
    const { rows } = await metaPool.query<{ max: string; su: string; rs: string | null }>(
      `select current_setting('max_connections') as max,
              current_setting('superuser_reserved_connections') as su,
              current_setting('reserved_connections', true) as rs`,
    );
    const maxConnections = Number(rows[0]?.max);
    const reserved = Number(rows[0]?.su ?? 0) + Number(rows[0]?.rs ?? 0);
    if (!Number.isFinite(maxConnections) || maxConnections <= 0) return;
    const b = connectionBudget({
      maxConnections,
      reserved,
      metaPoolMax: Number((metaPool as unknown as { options?: { max?: number } }).options?.max) || 10,
      lockConnections: LOCK_CONNECTIONS,
      tenantPoolMax: TENANT_POOL_MAX,
      configuredTenantPools: CONFIGURED_TENANT_POOLS,
      configuredSweepPools: sweepGate.ceiling,
    });
    setTenantPoolCap(b.tenantPools);
    sweepGate.setLimit(b.sweepPools);
    recordAppliedBudget({ ...b, maxConnections });
    console.log(
      `[db] connection budget: server allows ${maxConnections}, this api ${b.perApi} (at most ${b.worstCase} held); workspace pools ${b.tenantPools} of ${CONFIGURED_TENANT_POOLS}, sweeps ${b.sweepPools}${b.lowered ? " (lowered to fit the server)" : ""}${b.fits ? "" : "; two apis at their worst do NOT fit"}`,
    );
  } catch (err) {
    notePassFailure("applyConnectionBudget", null, err);
    console.warn("[db] could not read the server's connection limit; keeping the configured pool sizes:", (err as Error).message);
  }
}
