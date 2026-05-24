// core-ai platform service.
//
// Three responsibilities mirroring core-integrations:
//   1. Provider registry — modules register at load time; this
//      layer resolves them at invoke time.
//   2. Per-workspace dispatch — looks up the workspace's configured
//      provider for the requested capability, decrypts credentials,
//      calls the provider, writes audit + cache rows on the tenant
//      DB.
//   3. Cache — sha256(capability|provider|model|input) → result.
//      Cheap rejections (no-providers, capability-unsupported)
//      surface as typed errors.
//
// See docs/design-decisions/core-ai.md.

import { createHash } from "node:crypto";
import type {
  AiCapability,
  AiProviderDef,
  PlatformAi,
} from "@cobblr/platform-contract";
import { getTenantDb } from "../db/tenant.js";
import * as integrationsImpl from "./integrations.js";

const providers = new Map<string, AiProviderDef>();

export function registerProvider(p: AiProviderDef): void {
  providers.set(p.id, p);
}

export function listProviders(): ReturnType<PlatformAi["listProviders"]> {
  return Array.from(providers.values()).map((p) => ({
    id: p.id,
    label: p.label,
    credentials: p.describeCredentials(),
    capabilities: p.capabilities,
  }));
}

export function getProvider(id: string): AiProviderDef | null {
  return providers.get(id) ?? null;
}

function hashInput(
  capability: string,
  provider_id: string,
  model: string,
  input: unknown,
): string {
  return createHash("sha256")
    .update(`${capability}|${provider_id}|${model}|${JSON.stringify(input)}`)
    .digest("hex");
}

interface ProviderRow {
  id: string;
  provider_id: string;
  credentials_enc: string;
  enabled: boolean;
  config: Record<string, unknown>;
}

interface CapabilityDefaultRow {
  capability: string;
  provider_id: string;
  model: string;
  config: Record<string, unknown>;
}

interface CacheRow {
  cache_key: string;
  result: Record<string, unknown>;
  cost_cents: number | null;
  hit_count: number;
}

/** Resolve which provider + model to use for a capability. Order:
 *   1. Explicit request override (`req.provider_id` + `req.model`).
 *   2. Workspace's `core_ai_capability_defaults` row.
 *   3. First installed provider that declares this capability +
 *      whatever defaultModel it ships with.
 *   4. Throw — capability unconfigured. */
async function resolveProviderAndModel(
  orgId: string,
  capability: AiCapability,
  override?: { provider_id?: string; model?: string },
): Promise<{ row: ProviderRow; model: string }> {
  const tdb = (await getTenantDb(orgId)) as unknown as {
    selectFrom: (t: string) => {
      selectAll: () => {
        where: (col: string, op: string, val: unknown) => {
          where: (col: string, op: string, val: unknown) => {
            executeTakeFirst: () => Promise<ProviderRow | undefined>;
            execute: () => Promise<ProviderRow[]>;
          };
          executeTakeFirst: () => Promise<ProviderRow | undefined>;
          execute: () => Promise<ProviderRow[]>;
        };
      };
      select: (cols: string[]) => {
        where: (col: string, op: string, val: unknown) => {
          executeTakeFirst: () => Promise<CapabilityDefaultRow | undefined>;
        };
      };
    };
  };
  let providerId = override?.provider_id;
  let model = override?.model;
  if (!providerId) {
    const defaultRow = await tdb
      .selectFrom("core_ai_capability_defaults")
      .select(["capability", "provider_id", "model", "config"])
      .where("capability", "=", capability)
      .executeTakeFirst();
    if (defaultRow) {
      providerId = defaultRow.provider_id;
      model = model ?? defaultRow.model;
    }
  }
  if (!providerId) {
    // Fallback: first provider that supports this capability.
    const rows = await tdb
      .selectFrom("core_ai_providers")
      .selectAll()
      .where("enabled", "=", true)
      .execute();
    for (const candidate of rows) {
      const def = providers.get(candidate.provider_id);
      if (def?.capabilities[capability]) {
        providerId = candidate.provider_id;
        model = model ?? def.capabilities[capability]?.defaultModel ??
          def.capabilities[capability]?.models[0];
        break;
      }
    }
  }
  if (!providerId) {
    throw new Error(`no provider configured for capability ${capability}`);
  }
  const row = await tdb
    .selectFrom("core_ai_providers")
    .selectAll()
    .where("provider_id", "=", providerId)
    .where("enabled", "=", true)
    .executeTakeFirst();
  if (!row) {
    throw new Error(`provider ${providerId} not installed (or disabled) in this workspace`);
  }
  const def = providers.get(providerId);
  if (!def) {
    throw new Error(`provider ${providerId} not registered with the platform`);
  }
  if (!model) {
    model = def.capabilities[capability]?.defaultModel ??
      def.capabilities[capability]?.models[0];
  }
  if (!model) {
    throw new Error(`provider ${providerId} does not support ${capability}`);
  }
  return { row, model };
}

function truncate(s: string, n = 200): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

export const invoke: PlatformAi["invoke"] = async (req) => {
  const { row, model } = await resolveProviderAndModel(req.orgId, req.capability, {
    provider_id: req.provider_id,
    model: req.model,
  });
  const def = providers.get(row.provider_id)!;
  const cacheKey = hashInput(req.capability, row.provider_id, model, req.input);

  const tdb = (await getTenantDb(req.orgId)) as unknown as {
    selectFrom: (t: string) => {
      selectAll: () => {
        where: (col: string, op: string, val: unknown) => {
          executeTakeFirst: () => Promise<CacheRow | undefined>;
        };
      };
    };
    updateTable: (t: string) => {
      set: (v: unknown) => {
        where: (col: string, op: string, val: unknown) => { execute: () => Promise<unknown> };
      };
    };
    insertInto: (t: string) => {
      values: (v: Record<string, unknown>) => {
        onConflict?: (c: unknown) => { execute: () => Promise<unknown> };
        execute: () => Promise<unknown>;
      };
    };
  };

  // Cache lookup.
  if (!req.bypass_cache) {
    const hit = await tdb
      .selectFrom("core_ai_cache")
      .selectAll()
      .where("cache_key", "=", cacheKey)
      .executeTakeFirst();
    if (hit) {
      await tdb
        .updateTable("core_ai_cache")
        .set({ hit_count: (hit.hit_count ?? 0) + 1, last_hit_at: new Date() })
        .where("cache_key", "=", cacheKey)
        .execute();
      const ms = 0;
      await writeAuditRow(req.orgId, {
        provider_id: row.provider_id,
        capability: req.capability,
        model,
        cached: true,
        ok: true,
        cost_cents: 0,
        duration_ms: ms,
        input_summary: truncate(JSON.stringify(req.input)),
        output_summary: truncate(JSON.stringify(hit.result)),
        source_kind: req.source?.kind ?? null,
        source_id: req.source?.id ?? null,
        error: null,
        input_tokens: null,
        output_tokens: null,
      });
      return {
        result: hit.result,
        provider_id: row.provider_id,
        model,
        cached: true,
        cost_cents: 0,
        duration_ms: ms,
      };
    }
  }

  // Real call.
  const credentials = await integrationsImpl.decryptCredentials(req.orgId, row.credentials_enc);
  const start = Date.now();
  let ok = false;
  let errMsg: string | null = null;
  let payload: Awaited<ReturnType<AiProviderDef["invoke"]>> = { result: null };
  try {
    payload = await def.invoke({
      orgId: req.orgId,
      rowId: row.id,
      capability: req.capability,
      model,
      credentials,
      input: req.input,
      config: row.config ?? {},
    });
    ok = true;
  } catch (err) {
    errMsg = (err as Error).message;
  }
  const duration_ms = Date.now() - start;

  await writeAuditRow(req.orgId, {
    provider_id: row.provider_id,
    capability: req.capability,
    model,
    cached: false,
    ok,
    cost_cents: payload.cost_cents ?? null,
    duration_ms,
    input_summary: truncate(JSON.stringify(req.input)),
    output_summary: ok ? truncate(JSON.stringify(payload.result)) : null,
    source_kind: req.source?.kind ?? null,
    source_id: req.source?.id ?? null,
    error: errMsg,
    input_tokens: payload.input_tokens ?? null,
    output_tokens: payload.output_tokens ?? null,
  });

  if (!ok) {
    throw new Error(`core-ai invoke failed: ${errMsg}`);
  }

  // Cache write (only on success + not bypassed).
  if (!req.bypass_cache) {
    try {
      await tdb
        .insertInto("core_ai_cache")
        .values({
          cache_key: cacheKey,
          capability: req.capability,
          result: payload.result as Record<string, unknown>,
          cost_cents: payload.cost_cents ?? null,
          hit_count: 0,
        })
        .execute();
    } catch (err) {
      // Duplicate key on concurrent identical invocations is fine.
      console.error("[core-ai] cache write failed:", err);
    }
  }

  return {
    result: payload.result,
    provider_id: row.provider_id,
    model,
    cached: false,
    input_tokens: payload.input_tokens,
    output_tokens: payload.output_tokens,
    cost_cents: payload.cost_cents,
    duration_ms,
  };
};

async function writeAuditRow(
  orgId: string,
  row: {
    provider_id: string;
    capability: string;
    model: string;
    cached: boolean;
    ok: boolean;
    cost_cents: number | null;
    duration_ms: number;
    input_summary: string;
    output_summary: string | null;
    source_kind: string | null;
    source_id: string | null;
    error: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
  },
): Promise<void> {
  try {
    const tdb = (await getTenantDb(orgId)) as unknown as {
      insertInto: (t: string) => {
        values: (v: Record<string, unknown>) => { execute: () => Promise<unknown> };
      };
    };
    await tdb.insertInto("core_ai_calls").values(row).execute();
  } catch (err) {
    console.error("[core-ai] audit insert failed:", err);
  }
}
