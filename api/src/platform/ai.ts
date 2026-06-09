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
// See docs/modules/core-ai.md.

import { createHash } from "node:crypto";
import type {
  AiCapability,
  AiEndpointPolicy,
  AiEntitlementGuard,
  AiProviderDef,
  PlatformAi,
} from "@cobblr/platform-contract";
import { getTenantDb } from "../db/tenant.js";
import * as integrationsImpl from "./integrations.js";
import { resolvePersonalProvider } from "./user-credentials.js";
import { env } from "../env.js";

const providers = new Map<string, AiProviderDef>();

export function registerProvider(p: AiProviderDef): void {
  providers.set(p.id, p);
}

// Pluggable entitlement guard. Open core registers none (allow-all →
// self-host is free); the hosted overlay registers one that gates the
// managed providers by plan/allowance. Last registration wins.
let entitlementGuard: AiEntitlementGuard | null = null;

export function registerEntitlementGuard(g: AiEntitlementGuard): void {
  entitlementGuard = g;
}

// SSRF policy for providers that fetch a workspace-supplied URL (the
// ollama base_url). Open core defaults to "lan" (a self-hosted Ollama
// is legitimately on the LAN); the hosted overlay calls
// setEndpointPolicy("strict") at boot so cloud blocks private/metadata.
// Fail-safe by image: the policy travels with the build, not an env.
let endpointPolicy: AiEndpointPolicy = "lan";

export function getEndpointPolicy(): AiEndpointPolicy {
  return endpointPolicy;
}

export function setEndpointPolicy(p: AiEndpointPolicy): void {
  endpointPolicy = p;
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
    // Fallback: first INSTALLED provider that supports this capability.
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
    // Zero-config fallback: a registered CREDENTIAL-LESS ("managed") provider
    // that supports this capability. It brings its own credentials, so it needs
    // no per-workspace install or secret; whether THIS workspace may use it is
    // the entitlement guard's call in invoke(). Open core registers no such
    // provider (and no guard), so this is inert there — but on the hosted
    // overlay it makes managed AI AUTO-ON for entitled workspaces: a paying
    // subscriber gets AI with zero setup instead of having to add a provider.
    for (const [id, def] of providers) {
      if (def.capabilities[capability] && Object.keys(def.describeCredentials()).length === 0) {
        providerId = id;
        model = model ?? def.capabilities[capability]?.defaultModel ??
          def.capabilities[capability]?.models[0];
        break;
      }
    }
  }
  if (!providerId) {
    throw new Error(`no provider configured for capability ${capability}`);
  }
  const def = providers.get(providerId);
  if (!def) {
    throw new Error(`provider ${providerId} not registered with the platform`);
  }
  let row = await tdb
    .selectFrom("core_ai_providers")
    .selectAll()
    .where("provider_id", "=", providerId)
    .where("enabled", "=", true)
    .executeTakeFirst();
  if (!row) {
    // A "credential-less" provider (describeCredentials() → {}) needs no
    // per-workspace row — it supplies its own credentials (e.g. a managed
    // provider reading an instance key). Synthesize a virtual row so the
    // workspace doesn't have to "install" something it has no secret for.
    // Whether the workspace may USE it is the entitlement guard's call,
    // not a row-existence check. Credentialed providers still require a row.
    const needsCreds = Object.keys(def.describeCredentials()).length > 0;
    if (needsCreds) {
      throw new Error(`provider ${providerId} not installed (or disabled) in this workspace`);
    }
    row = { id: `virtual:${providerId}`, provider_id: providerId, credentials_enc: "", enabled: true, config: {} };
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

// Full text for the activity log: JSON, but redact images + clamp any long
// string (base64), then cap the whole thing — so a vision payload can't balloon
// the log. Readable for chat/text; safe for everything else.
function fullText(obj: unknown, cap = 20_000): string {
  const json = JSON.stringify(obj, (k, v) => {
    if (k === "image_b64" || k === "images" || k === "image") return "[image]";
    if (typeof v === "string" && v.length > 4000) return v.slice(0, 200) + "…[clamped]";
    return v;
  });
  if (!json) return "";
  return json.length <= cap ? json : json.slice(0, cap) + "…[truncated]";
}

export const invoke: PlatformAi["invoke"] = async (req) => {
  // Instance kill-switch: when AI is disabled for the whole deployment,
  // refuse before touching any per-workspace config. Same error family as
  // "no provider configured" so every caller's existing degrade path
  // (the ai:false contract) handles it with no per-feature changes.
  if (!env.COBBLR_AI_ENABLED) {
    throw new Error("no provider configured: AI features are disabled for this instance (COBBLR_AI_ENABLED=false)");
  }
  // Personal (user-scoped) connections — DEFAULT-OFF. When the caller hasn't
  // forced a provider, a credential the user (or a member, per its routing
  // policy) has routed to this workspace can supply the provider + secret,
  // instead of the workspace's own config. Returns null when nothing's routed,
  // so this is byte-for-byte the old path until someone opts in. An explicit
  // provider override (e.g. the eval harness) always wins over a personal cred.
  let personalCredentials: Record<string, unknown> | undefined;
  let resolved: { row: ProviderRow; model: string } | null = null;
  if (!req.provider_id) {
    const personal = await resolvePersonalProvider(
      req.orgId,
      req.userId ?? null,
      (pid) => !!providers.get(pid)?.capabilities[req.capability],
    );
    if (personal) {
      const pdef = providers.get(personal.providerId);
      const pmodel =
        req.model ??
        pdef?.capabilities[req.capability]?.defaultModel ??
        pdef?.capabilities[req.capability]?.models[0];
      if (pdef && pmodel) {
        resolved = {
          row: {
            id: `personal:${personal.credentialId}`,
            provider_id: personal.providerId,
            credentials_enc: "",
            enabled: true,
            config: {},
          },
          model: pmodel,
        };
        personalCredentials = personal.credentials;
      }
    }
  }
  const { row, model } =
    resolved ??
    (await resolveProviderAndModel(req.orgId, req.capability, {
      provider_id: req.provider_id,
      model: req.model,
    }));

  // Entitlement gate (hosted overlay only — open core registers no guard).
  // Denials surface in the "no provider" error family so existing degrade
  // paths (ai:false) handle them with no per-feature changes.
  if (entitlementGuard) {
    const verdict = await entitlementGuard({
      orgId: req.orgId,
      capability: req.capability,
      providerId: row.provider_id,
      model,
    });
    if (!verdict.allow) {
      throw new Error(`no provider available: ${verdict.reason ?? "not entitled for this workspace"}`);
    }
  }

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
        user_id: req.userId ?? null,
        input_summary: truncate(JSON.stringify(req.input)),
        output_summary: truncate(JSON.stringify(hit.result)),
        input_full: fullText(req.input),
        output_full: fullText(hit.result),
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

  // Real call. A personal (user-scoped) credential supplies its own already-
  // decrypted secret; otherwise decrypt the workspace row (a virtual
  // credential-less row has no ciphertext — the provider brings its own).
  const credentials =
    personalCredentials ??
    (row.credentials_enc
      ? await integrationsImpl.decryptCredentials(req.orgId, row.credentials_enc)
      : {});
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
    user_id: req.userId ?? null,
    input_summary: truncate(JSON.stringify(req.input)),
    output_summary: ok ? truncate(JSON.stringify(payload.result)) : null,
    input_full: fullText(req.input),
    output_full: ok ? fullText(payload.result) : null,
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
    user_id: string | null;
    input_summary: string;
    output_summary: string | null;
    input_full: string;
    output_full: string | null;
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
    // source_id is a UUID column, but callers sometimes pass a non-UUID handle
    // (a barcode, a product name) as source.id — that would make the whole audit
    // insert throw, silently dropping the call from the AI log. Coerce anything
    // that isn't a UUID to null so observability never loses a row over it.
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const safeRow = {
      ...row,
      source_id: row.source_id && UUID.test(row.source_id) ? row.source_id : null,
    };
    await tdb.insertInto("core_ai_calls").values(safeRow).execute();
  } catch (err) {
    console.error("[core-ai] audit insert failed:", err);
  }
}
