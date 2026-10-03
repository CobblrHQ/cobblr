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

import { askInOrder, listInOrder } from "./chain.js";
import { aiRefusal, refusalCodeOf, type AiAttempt } from "@cobblr/platform-contract/ai-refusal";
import { providerError, providerReasonOf, redactSecrets, REASONS_ANOTHER_PROVIDER_MAY_ANSWER } from "@cobblr/platform-contract/provider-reason";
import { createHash } from "node:crypto";
import type {
  AiCapability,
  AiEndpointPolicy,
  AiEntitlementGuard,
  AiProviderDef,
  AiReportedModels,
  PlatformAi,
} from "@cobblr/platform-contract";
import { aiCapabilityChain, isChatTurn, isFloatingModel, type AiChainStep } from "@cobblr/platform-contract";
import { getTenantDb } from "../db/tenant.js";
import { meta } from "../db/meta.js";
import * as integrationsImpl from "./integrations.js";
import { resolvePersonalProvider, type ResolvedPersonalProvider } from "./user-credentials.js";
import { signMcpReadGrant } from "../auth/jwt.js";
import { mcpRelayUrl } from "./public-url.js";
import { env } from "../env.js";
import { fullText, thumbnailImages } from "./ai-log.js";
import { isCooling, noteAnswered, noteBusy } from "./ai-busy-cooldown.js";
import { aiAnswerText } from "@cobblr/platform-contract/ai-answer";

/** True when the chat input carries workspace tool defs (the AI wants to read
 *  the workspace) — the only case where the bridge MCP relay is relevant. */
function inputHasTools(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const t = (input as Record<string, unknown>).tools;
  return Array.isArray(t) && t.length > 0;
}

/** Does this chat call need its tools relayed over MCP instead of sent as
 *  function definitions?
 *
 *  TWO ways to be that kind of backend, and reading only the first is what left
 *  the managed bridge with no tools at all (staging, 2026-08-15):
 *    · a BYO connection says so per connection — `mcp_relay: "bridge"`;
 *    · the PROVIDER is always one and has no credentials to carry a flag —
 *      `relaysToolsViaMcp` in its registration.
 *
 *  A named rule rather than an inline `||`, so the second case can't be
 *  dropped again without a test going red. */
export function needsMcpToolRelay(
  credentials: Record<string, unknown> | undefined,
  provider: Pick<AiProviderDef, "relaysToolsViaMcp"> | undefined | null,
): boolean {
  return credentials?.mcp_relay === "bridge" || provider?.relaysToolsViaMcp === true;
}

/** The workspace slug for an org id (from cobblr_meta) — the MCP endpoint is
 *  addressed by slug (`?workspace=<slug>`), and the grant is pinned to it. */
async function orgSlugOf(orgId: string): Promise<string | null> {
  const r = await meta
    .selectFrom("orgs")
    .select("slug")
    .where("id", "=", orgId)
    .executeTakeFirst();
  return r?.slug ?? null;
}

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
  // Sorted by rank, so the picker's order (and therefore its default) is a decision
  // rather than a consequence of which register() call came first. Unranked providers
  // keep their registration order after the ranked ones.
  return Array.from(providers.values())
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.rank ?? Number.MAX_SAFE_INTEGER) - (b.p.rank ?? Number.MAX_SAFE_INTEGER) || a.i - b.i)
    .map(({ p }) => ({
    id: p.id,
    label: p.label,
    ...(p.modelNotes ? { modelNotes: p.modelNotes } : {}),
    credentials: p.describeCredentials(),
    capabilities: p.capabilities,
    setup: p.setup,
    // Carried, not just sorted by. A consumer that re-merges these with another
    // registry (the connections catalogue does) has to be able to re-sort, and
    // a picker whose default is providers[0] should be able to say WHY.
    rank: p.rank,
  }));
}

export function getProvider(id: string): AiProviderDef | null {
  return providers.get(id) ?? null;
}

/**
 * The cache key must identify the REQUEST WE ACTUALLY SEND, not the caller's
 * input. Those are not the same thing, and the gap was a real bug:
 *
 * For `identify-image`, `extract-text`, `match-to-catalog` and `summarise`, the
 * PROMPT is a constant the provider adapter injects — it is not in `input`. So the
 * key didn't include it, and **editing one of those prompts invalidated nothing.**
 * Every image already in the cache kept returning the answer generated by the OLD
 * prompt, forever (cache rows have no TTL). The prompt-eval harness — whose entire
 * job is to tell you whether a prompt change helped — was scoring stale replies.
 *
 * `promptFingerprint` closes it: the adapter hashes the prompt it will send, and
 * that hash joins the key. A prompt edit now invalidates exactly the entries it
 * should. Capabilities whose prompt IS in `input` (`chat`, `classify-image`) were
 * always keyed correctly and are unaffected.
 */
function hashInput(
  capability: string,
  provider_id: string,
  model: string,
  input: unknown,
  promptFp: string | null,
): string {
  return createHash("sha256")
    .update(`${capability}|${provider_id}|${model}|${promptFp ?? ""}|${JSON.stringify(input)}`)
    .digest("hex");
}

interface InvokeResult {
  result: unknown;
  provider_id: string;
  model: string;
  cached: boolean;
  input_tokens?: number;
  output_tokens?: number;
  cost_cents?: number;
  duration_ms: number;
}

/**
 * In-flight calls, keyed by org + cache key. A byte-identical CACHEABLE request
 * that arrives while an identical one is still calling the provider awaits that
 * one instead of firing its own — single-flight coalescing.
 *
 * Without it, N callers racing on the same input (the classic: N split children
 * each reading the SAME parent photo) each miss the cache — the first write hasn't
 * landed yet — so each pays for an identical provider call, and the cache write
 * comment `Duplicate key on concurrent identical invocations is fine` was quietly
 * admitting the waste. The entry lives only for the duration of the call.
 */
const inFlight = new Map<string, Promise<InvokeResult>>();

interface ProviderRow {
  id: string;
  provider_id: string;
  credentials_enc: string;
  enabled: boolean;
  config: Record<string, unknown>;
  /** The connection's own name ("Claude bridge (Sam)"): a workspace
   *  provider's label, or a personal connection's. */
  label?: string | null;
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

/**
 * The workspace's per-job choice, if it made one.
 *
 * `credential_id` names a PERSONAL connection routed here; `provider_id` alone
 * names one of the workspace's own installed providers. Either way the row is
 * an explicit instruction from an owner, and until now nothing read it when a
 * personal connection was in play: a personal key short-circuited resolution
 * entirely, so the per-job settings on the AI page silently did nothing and the
 * key's model could not be chosen at all (reported 2026-09-04, "it should be
 * usable and configurable within that workspace completely, just like a
 * workspace key").
 *
 * Fail-safe: any error reads as "no choice made", which is the old behaviour.
 */
async function workspaceJobChoice(
  orgId: string,
  capability: AiCapability,
): Promise<{ credentialId: string | null; providerId: string | null; model: string | null } | null> {
  try {
    const tdb = (await getTenantDb(orgId)) as unknown as {
      selectFrom: (t: string) => {
        select: (c: string[]) => {
          where: (a: string, b: string, c: unknown) => {
            executeTakeFirst: () => Promise<
              { credential_id?: string | null; provider_id?: string | null; model?: string | null } | undefined
            >;
          };
        };
      };
    };
    // A job split out of an older one (planning a change out of chat) asks
    // the AI the workspace chose for the older job, with the new job's own
    // model: choosing Claude for chat means a change is planned by Claude
    // too, by its fuller model, not by whichever provider was added first.
    const chain = aiCapabilityChain(capability);
    for (const [i, served] of chain.entries()) {
      const row = await tdb
        .selectFrom("core_ai_capability_defaults")
        .select(["credential_id", "provider_id", "model"])
        .where("capability", "=", served)
        .executeTakeFirst();
      if (!row) continue;
      return {
        credentialId: row.credential_id ?? null,
        providerId: row.provider_id ?? null,
        model: i === 0 ? (row.model ?? null) : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveProviderAndModel(
  orgId: string,
  capability: AiCapability,
  override?: { provider_id?: string; model?: string },
  /** Workspace providers already asked for this call (the fallback, #3819). */
  exclude?: ReadonlySet<string>,
): Promise<{ row: ProviderRow; model: string; picked: boolean }> {
  const tdb = (await getTenantDb(orgId)) as unknown as {
    selectFrom: (t: string) => {
      selectAll: () => {
        where: (col: string, op: string, val: unknown) => {
          where: (col: string, op: string, val: unknown) => {
            executeTakeFirst: () => Promise<ProviderRow | undefined>;
            execute: () => Promise<ProviderRow[]>;
          };
          orderBy: (col: string, dir: "asc" | "desc") => {
            orderBy: (col: string, dir: "asc" | "desc") => { execute: () => Promise<ProviderRow[]> };
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
  // A model somebody NAMED (the call, or the workspace's choice for the job)
  // is never swapped behind their back; a provider's own default may be.
  let picked = !!override?.model;
  if (!providerId) {
    const defaultRow = await tdb
      .selectFrom("core_ai_capability_defaults")
      .select(["capability", "provider_id", "model", "config"])
      .where("capability", "=", capability)
      .executeTakeFirst();
    if (defaultRow && !exclude?.has(defaultRow.provider_id)) {
      providerId = defaultRow.provider_id;
      picked = picked || !!defaultRow.model;
      model = model ?? defaultRow.model;
    }
  }
  if (!providerId) {
    // The choice made for the older job a new one was split from (planning a
    // change out of chat): the same rule the personal-connection path reads.
    const inherited = await workspaceJobChoice(orgId, capability);
    if (inherited?.providerId && !inherited.credentialId && !exclude?.has(inherited.providerId)) providerId = inherited.providerId;
  }
  if (!providerId) {
    // Fallback: the INSTALLED providers that support this capability, the
    // one added first asked first. With no order this was whichever row
    // Postgres returned, so the same workspace could ask its providers in a
    // different order from one call to the next, and no screen could say
    // which (#3842).
    const rows = await tdb
      .selectFrom("core_ai_providers")
      .selectAll()
      .where("enabled", "=", true)
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .execute();
    outer: for (const served of aiCapabilityChain(capability)) {
      for (const candidate of rows) {
        if (exclude?.has(candidate.provider_id)) continue;
        const def = providers.get(candidate.provider_id);
        if (def?.capabilities[served]) {
          providerId = candidate.provider_id;
          model = model ?? def.capabilities[served]?.defaultModel ??
            def.capabilities[served]?.models[0];
          break outer;
        }
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
    outer: for (const served of aiCapabilityChain(capability)) {
      for (const [id, def] of providers) {
        // Skip providers that opt out of zero-config auto-selection — they need
        // per-user setup before they work (e.g. the edge bridge needs a connected
        // agent), so auto-picking one turns a "no provider" case into a runtime
        // error from the unset provider instead of a clean no_ai_provider.
        if (def.autoSelectable === false) continue;
        if (exclude?.has(id)) continue;
        if (def.capabilities[served] && Object.keys(def.describeCredentials()).length === 0) {
          providerId = id;
          model = model ?? def.capabilities[served]?.defaultModel ??
            def.capabilities[served]?.models[0];
          break outer;
        }
      }
    }
  }
  if (!providerId) {
    throw aiRefusal("no_provider", `no provider configured for capability ${capability}`);
  }
  const def = providers.get(providerId);
  if (!def) {
    throw aiRefusal("no_provider", `provider ${providerId} not registered with the platform`);
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
      throw aiRefusal("no_provider", `provider ${providerId} not installed (or disabled) in this workspace`);
    }
    row = { id: `virtual:${providerId}`, provider_id: providerId, credentials_enc: "", enabled: true, config: {} };
  }
  if (!model) {
    for (const served of aiCapabilityChain(capability)) {
      model = def.capabilities[served]?.defaultModel ?? def.capabilities[served]?.models[0];
      if (model) break;
    }
  }
  if (!model) {
    throw aiRefusal("no_provider", `provider ${providerId} does not support ${capability}`);
  }
  return { row, model, picked };
}

function truncate(s: string, n = 200): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

/** What a person would recognise this call by, for the activity log.
 *
 *  This used to be the first 200 characters of `JSON.stringify(input)`. For a
 *  chat those 200 characters are the SYSTEM PROMPT — the longest, most
 *  repetitive, least identifying part — while the user's actual message sits at
 *  the END of the messages array and never appeared at all. `input_full` is
 *  capped and truncates from the same end, so the question was unrecoverable
 *  from either field: the log recorded which preamble was used, not what anyone
 *  asked. Found while reviewing chat records to see which questions repeat, a
 *  review the log could not answer about itself (2026-08-18).
 *
 *  Prefer the last user message; fall back to a named text field; only then to
 *  the old behaviour, so non-chat capabilities are unaffected. */
export function summariseInput(input: Record<string, unknown>): string {
  const raw = (input as { messages?: unknown }).messages;
  const msgs = Array.isArray(raw) ? (raw as Array<{ role?: unknown; content?: unknown }>) : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === "user" && typeof m.content === "string" && m.content.trim()) {
      return truncate(m.content.trim());
    }
  }
  for (const k of ["prompt", "text", "question"]) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string" && v.trim()) return truncate(v.trim());
  }
  return truncate(JSON.stringify(input));
}

/** Would an AI call work for this workspace/user right now? The cheap,
 *  read-only twin of invoke()'s gauntlet — kill-switch → personal
 *  connection → workspace/managed provider → entitlement guard — so the
 *  UI can warn *before* a feature silently degrades (the scan inbox's
 *  "no AI is hooked up" notice). Never throws; never calls a provider. */
export type AiAvailabilityReason =
  | "ok"
  | "operator_disabled"
  | "not_entitled"
  | "no_provider"
  | "workspace_disabled";
/** Where an available AI call would be served from — drives honest UI copy
 *  ("provided by your plan" vs "your own key" vs a workspace provider). */
export type AiSource = "personal" | "workspace" | "managed";

export async function checkAvailability(
  orgId: string,
  userId: string | null,
  capability: AiCapability = "chat",
): Promise<{ available: boolean; reason: AiAvailabilityReason; source?: AiSource }> {
  if (!env.COBBLR_AI_ENABLED) return { available: false, reason: "operator_disabled" };
  // A user's OWN personal connection always works — it's their key, not the
  // workspace's — so it wins even when the workspace turned shared AI off.
  const personal = await resolvePersonalProvider(
    orgId,
    userId,
    (pid) => !!providers.get(pid)?.capabilities[capability],
    "ai-provider",
    capability,
  ).catch(() => null);
  if (personal) return { available: true, reason: "ok", source: "personal" };
  // Workspace opted out of shared/managed AI (the personal check above already
  // let a personal key through; this blocks the workspace + managed defaults).
  const org = await meta.selectFrom("orgs").select("ai_disabled").where("id", "=", orgId).executeTakeFirst().catch(() => null);
  if (org?.ai_disabled) {
    // Still report WHAT WOULD serve AI if the workspace turned it back on, so the
    // UI can say "AI is available from your plan - flip the switch" rather than
    // leaving the user unsure whether anything is there. `source` undefined means
    // nothing would be available even once re-enabled (no provider connected).
    let source: AiSource | undefined;
    try {
      const { row } = await resolveProviderAndModel(orgId, capability);
      source = String(row.id).startsWith("virtual:") ? "managed" : "workspace";
    } catch {
      source = undefined;
    }
    return { available: false, reason: "workspace_disabled", source };
  }
  try {
    const { row, model } = await resolveProviderAndModel(orgId, capability);
    if (entitlementGuard) {
      const verdict = await entitlementGuard({
        orgId,
        capability,
        providerId: row.provider_id,
        model,
      });
      if (!verdict.allow) return { available: false, reason: "not_entitled" };
    }
    // A credential-less provider resolves to a synthesized `virtual:` row — that
    // is the managed/plan provider; a real row is a workspace-owned key.
    const source: AiSource = String(row.id).startsWith("virtual:") ? "managed" : "workspace";
    return { available: true, reason: "ok", source };
  } catch {
    return { available: false, reason: "no_provider" };
  }
}

/** How many providers one call may ask, the first included. */
const MAX_PROVIDERS_PER_CALL = 3;

/** A provider this call asked, as the fallback tracks it: by the row that
 *  served it, so a personal connection and a workspace provider of the same
 *  kind are two different doors. */
interface TriedProvider extends AiAttempt {
  rowId: string;
}

/** What a person reads for the connection that served (or was asked for)
 *  a call: its own name when it has one, the provider's otherwise. "Local AI
 *  (via edge bridge)" names a kind of thing; "Claude bridge (Sam)" names the
 *  one somebody set up, which is what they recognise. Every surface that
 *  names an AI (the card's "Answered by", the fallback attempts, a refusal,
 *  the order on the AI page, the AI log) reads it from here. */
function nameOf(row: Pick<ProviderRow, "provider_id" | "label">): string {
  return row.label?.trim() || labelOf(row.provider_id);
}

function labelOf(providerId: string): string {
  return providers.get(providerId)?.label ?? providerId;
}

/** A provider-side failure another provider may well not have (busy, a
 *  limit, a key, a retired model, no answer), on a call nobody pinned to one
 *  provider. A refusal of the request itself is not a reason to shop around,
 *  and neither is a call the person pinned (the chat's model pill, an
 *  explicit provider). */
export function mayAskAnotherProvider(err: unknown, req: { provider_id?: string; credential_id?: string; cache_only?: boolean }): boolean {
  if (req.provider_id || req.credential_id || req.cache_only) return false;
  if (refusalCodeOf(err) !== "provider_error") return false;
  const reason = providerReasonOf(err);
  return !!reason && (REASONS_ANOTHER_PROVIDER_MAY_ANSWER as readonly string[]).includes(reason);
}

/** The single entry point. It asks the provider this workspace chose for the
 *  job; when that one fails for a provider-side reason, it asks the next one
 *  the workspace lists for the job, in the workspace's order, up to three.
 *  The answer says who answered and who was asked first (#3819). */
export const invoke: PlatformAi["invoke"] = async (req) => {
  const { result: r, asked: tried, current } = await askInOrder<TriedProvider, { rowId?: string; providerId?: string; model?: string; label?: string }, Awaited<ReturnType<typeof invokeRaw>>>({
    max: MAX_PROVIDERS_PER_CALL,
    newCurrent: () => ({}),
    attempt: (asked, current) => invokeRaw(req, asked, current),
    record: (current, err) =>
      current.rowId
        ? {
            rowId: current.rowId,
            provider_id: current.providerId ?? "",
            label: current.label ?? labelOf(current.providerId ?? ""),
            model: current.model ?? "",
            reason: providerReasonOf(err) ?? "unknown",
          }
        : null,
    mayAskAnother: (err) => mayAskAnotherProvider(err, req),
    isCandidateFailure: (err) => refusalCodeOf(err) === "provider_error",
    finish: (err, asked) => withAttempts(err, [...asked]),
  });
  const answered_after = tried.length ? tried.map(({ rowId: _rowId, ...a }) => a) : undefined;
  if (answered_after) {
    console.warn(
      `[ai] ${req.capability} answered by ${r.provider_id}/${r.model} after ${answered_after.map((a) => `${a.provider_id}/${a.model} (${a.reason})`).join(", ")}`,
    );
  }
  return {
    ...r,
    text: aiAnswerText(r.result),
    provider_label: current.label ?? labelOf(r.provider_id),
    provider_kind_label: labelOf(r.provider_id),
    ...(answered_after ? { answered_after } : {}),
  };
};

/** The refusal with every provider asked before it on it. */
function withAttempts(err: unknown, tried: TriedProvider[]): unknown {
  if (!tried.length || refusalCodeOf(err) === null) return err;
  const e = err as { code: Parameters<typeof aiRefusal>[0]; message: string; reason?: string; door?: "personal" | "workspace"; retryAfterSec?: number; providerId?: string; providerLabel?: string; model?: string };
  return aiRefusal(e.code, e.message, {
    reason: e.reason ?? null,
    ...(e.door ? { door: e.door } : {}),
    ...(e.retryAfterSec !== undefined ? { retryAfterSec: e.retryAfterSec } : {}),
    ...(e.providerId ? { providerId: e.providerId } : {}),
    ...(e.providerLabel ? { providerLabel: e.providerLabel } : {}),
    ...(e.model ? { model: e.model } : {}),
    attempts: tried.map(({ rowId: _rowId, ...a }) => a),
  });
}

/** Pauses before asking a busy provider again inside one call. A provider
 *  that says "high demand" usually clears within seconds; two more asks over
 *  about ten seconds is the difference between a name and "try again". */
let busyRetryDelaysMs: readonly number[] = [2_000, 6_000];
/** Tests shorten the pauses; nothing else calls this. */
export function setBusyRetryDelaysForTest(delays: readonly number[]): void {
  busyRetryDelaysMs = delays;
}

/** The provider a call asks next, given the ones it has already asked: the
 *  router's one decision, step by step. `invokeRaw` asks it once per attempt
 *  and `aiChainFor` walks it to list the whole order, so the order a person
 *  is shown is the order the router uses, by construction (#3842). */
async function nextCandidate(
  req: Pick<Parameters<PlatformAi["invoke"]>[0], "orgId" | "userId" | "capability" | "provider_id" | "model" | "credential_id" | "costPolicy">,
  tried: readonly TriedProvider[],
): Promise<{ row: ProviderRow; model: string; picked: boolean; personalCredentials?: Record<string, unknown>; personal: ResolvedPersonalProvider | null }> {
  const triedPersonal = new Set(tried.filter((t) => t.rowId.startsWith("personal:")).map((t) => t.rowId.slice("personal:".length)));
  const triedWorkspace = new Set(tried.filter((t) => !t.rowId.startsWith("personal:")).map((t) => t.provider_id));
  // Instance kill-switch: when AI is disabled for the whole deployment,
  // refuse before touching any per-workspace config. Same error family as
  // "no provider configured" so every caller's existing degrade path
  // (the ai:false contract) handles it with no per-feature changes.
  if (!env.COBBLR_AI_ENABLED) {
    throw aiRefusal("operator_disabled", "no provider configured: AI features are disabled for this instance (COBBLR_AI_ENABLED=false)");
  }
  // Personal (user-scoped) connections — DEFAULT-OFF. When the caller hasn't
  // forced a provider, a credential the user (or a member, per its routing
  // policy) has routed to this workspace can supply the provider + secret,
  // instead of the workspace's own config. Returns null when nothing's routed,
  // so this is byte-for-byte the old path until someone opts in. An explicit
  // provider override (e.g. the eval harness) always wins over a personal cred.
  let personalCredentials: Record<string, unknown> | undefined;
  let personalServed: ResolvedPersonalProvider | null = null;
  let resolved: { row: ProviderRow; model: string; picked: boolean } | null = null;
  // What did this workspace SAY should do this job? An explicit choice decides,
  // and only when there is none does a personal connection win by default.
  const choice = req.provider_id ? null : await workspaceJobChoice(req.orgId, req.capability);
  // A choice naming one of the workspace's OWN providers means the personal
  // path is skipped entirely: picking a provider for a job and being served by
  // somebody's routed key anyway is the bug this fixes.
  //
  // A per-CALL credential_id (the chat's model pill, one person's choice)
  // outranks both: it is the most specific thing anyone has said about this
  // call, and it names a personal connection by id, so the workspace path is
  // not consulted at all.
  const choseWorkspaceProvider =
    !req.credential_id && !!choice && !choice.credentialId && !!choice.providerId && !triedWorkspace.has(choice.providerId);
  if (!req.provider_id && !choseWorkspaceProvider) {
    const personal = await resolvePersonalProvider(
      req.orgId,
      req.userId ?? null,
      (pid) => !!providers.get(pid)?.capabilities[req.capability],
      "ai-provider",
      req.capability,
      req.credential_id ?? choice?.credentialId ?? null,
      triedPersonal,
    );
    if (personal) {
      personalServed = personal;
      const pdef = providers.get(personal.providerId);
      // The workspace's chosen model for this job applies to a personal
      // connection as much as to its own provider - that is what "configurable
      // like a workspace key" means. Only honoured when the choice actually
      // named THIS connection.
      const chosenModel =
        choice?.credentialId && choice.credentialId === personal.credentialId ? choice.model : null;
      // A call that named THIS connection and also a model gets that model;
      // one that named a different connection than the one that answered
      // gets nothing from the pill (req.model is only honoured for the
      // connection it was chosen with).
      const pmodel =
        req.model ??
        chosenModel ??
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
            // A connection's name is its owner's: somebody else's Share is
            // named by the kind of AI it is, as the Share offer keeps its
            // label private (a card is read by every member).
            label: req.userId && personal.ownerUserId === req.userId ? personal.label : null,
          },
          model: pmodel,
          picked: !!(req.model ?? chosenModel),
        };
        personalCredentials = personal.credentials;
      }
    }
  }
  // Per-workspace AI opt-out: if this workspace turned shared AI off, the
  // workspace/managed DEFAULT path is refused (same "no provider" family as the
  // instance kill-switch, so every caller's basic-mode degrade handles it). A
  // personal connection (resolved above) or an explicit forced provider still
  // go through — the opt-out is about the workspace's own default, not a user's
  // own key.
  if (!resolved && !req.provider_id) {
    const org = await meta.selectFrom("orgs").select("ai_disabled").where("id", "=", req.orgId).executeTakeFirst().catch(() => null);
    if (org?.ai_disabled) {
      throw aiRefusal("workspace_disabled", "no provider configured: AI is turned off for this workspace");
    }
  }
  const { row, model, picked } =
    resolved ??
    (await resolveProviderAndModel(
      req.orgId,
      req.capability,
      { provider_id: req.provider_id, model: req.model },
      triedWorkspace,
    ));
  if (req.costPolicy === "free" && !providers.get(row.provider_id)?.freeBackground) {
    return nextCandidate(req, [...tried, { rowId: row.id, provider_id: row.provider_id, label: nameOf(row), model, reason: "unknown" }]);
  }
  return { row, model: req.costPolicy === "free" ? providers.get(row.provider_id)?.freeBackgroundModel || model : model, picked, personalCredentials, personal: personalServed };
}

export type { AiChainStep } from "@cobblr/platform-contract";

/** Every provider a call for `capability` would ask, in the order it asks
 *  them. Walks `nextCandidate`, the function the router itself asks once per
 *  attempt, excluding each step as the fallback does, so this list cannot
 *  show an order the router does not use. `refusal` is why the walk stopped
 *  at nothing at all (AI off, no provider). */
export async function aiChainFor(
  orgId: string,
  userId: string | null,
  capability: AiCapability,
  opts: { limit?: number } = {},
): Promise<{ steps: AiChainStep[]; refusal?: { code: string; message: string } }> {
  const { steps, stoppedBy } = await listInOrder<TriedProvider, Awaited<ReturnType<typeof nextCandidate>>, AiChainStep>({
    limit: opts.limit ?? MAX_PROVIDERS_PER_CALL + 3,
    next: (asked) => nextCandidate({ orgId, userId: userId ?? undefined, capability }, asked),
    step: async (next, position) => {
      const { row, personal } = next;
      const def = providers.get(row.provider_id);
      let model = next.model;
      try {
        const credentials =
          next.personalCredentials ?? (row.credentials_enc ? await integrationsImpl.decryptCredentials(orgId, row.credentials_enc) : {});
        model = def?.resolveModel?.({ capability, model, credentials }).model ?? model;
      } catch {
        /* the router's own model stands */
      }
      const isPersonal = String(row.id).startsWith("personal:");
      return {
        step: {
          position,
          asked: position <= MAX_PROVIDERS_PER_CALL,
          provider_id: row.provider_id,
          label: nameOf(row),
          model,
          floating: isFloatingModel(model),
          source: isPersonal ? (personal && userId && personal.ownerUserId === userId ? "yours" : "shared") : String(row.id).startsWith("virtual:") ? "managed" : "workspace",
          ...(isPersonal && personal ? { credential_id: personal.credentialId, owner_user_id: personal.ownerUserId } : {}),
          ...(!isPersonal && !String(row.id).startsWith("virtual:") ? { provider_row_id: row.id } : {}),
        },
        asked: { rowId: row.id, provider_id: row.provider_id, label: nameOf(row), model, reason: "busy" },
      };
    },
  });
  return {
    steps,
    ...(stoppedBy !== undefined ? { refusal: { code: refusalCodeOf(stoppedBy) ?? "no_provider", message: (stoppedBy as Error).message } } : {}),
  };
}

const invokeRaw = async (
  req: Parameters<PlatformAi["invoke"]>[0],
  tried: readonly TriedProvider[] = [],
  current: { rowId?: string; providerId?: string; model?: string; label?: string } = {},
): Promise<Omit<Awaited<ReturnType<PlatformAi["invoke"]>>, "text">> => {
  const next = await nextCandidate(req, tried);
  const { row, model, picked } = next;
  const personalCredentials = next.personalCredentials;
  current.rowId = row.id;
  current.providerId = row.provider_id;
  current.model = model;
  current.label = nameOf(row);

  // Ask-Cobb-over-the-bridge (MCP tool relay). When the resolved chat provider
  // is a Claude-subscription bridge (the connection's `mcp_relay` flag — works
  // for the ollama/openai-compat AND the edge-bridge providers, workspace OR
  // personal connection), the bridge can't hand tool_calls back (claude -p
  // can't) — so instead we mint a short-lived, read-only, workspace-pinned grant
  // and pass it as `input.mcp`; the adapters forward it, and the bridge spawns
  // `claude -p --mcp-config` pointed at THIS instance's MCP endpoint. The `url`
  // is THIS instance's own MCP address (mcpRelayUrl) so one shared bridge can
  // serve many Cobblr instances — each grant is minted + validated by its own
  // instance (a staging grant never validates on prod). The grant is clamped
  // server-side (auth middleware `mcp-read:<slug>` → GET reads only), so
  // read-only holds regardless of the bridge. Reused as the real-call
  // credentials below so we decrypt once. See
  // docs/design-decisions/ask-cobb-bridge-mcp-tools.md.
  let earlyCredentials: Record<string, unknown> | undefined;
  if (isChatTurn(req.capability) && req.userId && inputHasTools(req.input)) {
    earlyCredentials =
      personalCredentials ??
      (row.credentials_enc ? await integrationsImpl.decryptCredentials(req.orgId, row.credentials_enc) : {});
    // Two ways to be a tool-relaying bridge: a BYO connection SAYS so per
    // connection (`mcp_relay: "bridge"`), or the provider itself is always one
    // and has no credentials to carry a flag — a managed bridge. Reading only
    // the credential left the managed case with NO tools whatsoever, and
    // nothing said so: the model answered "I don't have that tool", which
    // reads like a limitation rather than the fault it is (staging,
    // 2026-08-15).
    if (needsMcpToolRelay(earlyCredentials, providers.get(row.provider_id))) {
      const slug = await orgSlugOf(req.orgId);
      if (slug) {
        const grant = await signMcpReadGrant(req.userId, slug);
        // Endpoint = this instance's own hosted MCP surface (mcpRelayUrl).
        // When it has none, send no url and let the bridge fall back to its
        // own BRIDGE_MCP_RELAY_URL env.
        const url = mcpRelayUrl() || undefined;
        (req.input as Record<string, unknown>).mcp = { token: grant, workspace: slug, ...(url ? { url } : {}) };
        req.bypass_cache = true; // per-request grant — a tool-relay chat is never cacheable
      } else {
        // The grant needs a slug to pin to. Losing it means the turn runs with
        // no tools at all — say so, because the user only sees a confident
        // model claiming it cannot do things it can.
        console.warn(
          `[ai] chat wanted tools and ${row.provider_id} relays them via MCP, but org ${req.orgId} resolved no slug — this turn runs WITHOUT tools`,
        );
      }
    }
  }

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
      throw aiRefusal("not_entitled", `no provider available: ${verdict.reason ?? "not entitled for this workspace"}`);
    }
  }

  const def = providers.get(row.provider_id)!;
  // The prompt the adapter will inject (absent from `input` for the image
  // capabilities) joins the key, so editing a prompt actually invalidates the
  // replies it invalidates. See hashInput.
  const promptFp = def.promptFingerprint?.(req.capability, req.input) ?? null;
  const cacheKey = hashInput(req.capability, row.provider_id, model, req.input, promptFp);

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

  // Replay mode reads the cache by definition — a caller that asked for both
  // (or a code path that set bypass_cache along the way) must not silently
  // become a paid call.
  if (req.cache_only) req.bypass_cache = false;

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
        provider_label: nameOf(row),
        capability: req.capability,
        model,
        cached: true,
        ok: true,
        cost_cents: 0,
        duration_ms: ms,
        user_id: req.userId ?? null,
        input_summary: summariseInput(req.input),
        output_summary: truncate(JSON.stringify(hit.result)),
        input_full: fullText(await thumbnailImages(req.input)),
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
    // Replay mode with nothing to replay. Stop here rather than quietly calling
    // the provider — the whole point of cache_only is that it CANNOT spend a
    // token. Thrown in the "no provider" family so every caller's existing
    // degrade path (identify → null, matchmaker → keyword heuristic) handles it
    // with no per-feature changes.
    if (req.cache_only) {
      throw aiRefusal("replay_only", `no provider available: replay-only (no cached ${req.capability} result for this input)`);
    }
  }

  // Single-flight: if a byte-identical cacheable call is ALREADY talking to the
  // provider, ride its result instead of firing a second identical call. Skipped
  // for bypass_cache (a retry explicitly wants its OWN fresh sample) — coalescing
  // those would defeat the retry.
  const flightKey = `${req.orgId}::${cacheKey}`;
  if (!req.bypass_cache) {
    const leader = inFlight.get(flightKey);
    if (leader) {
      try {
        const shared = await leader;
        // A coalesced follower cost nothing — audit it like a cache hit, so spend
        // reporting stays honest and per-user attribution survives.
        await writeAuditRow(req.orgId, {
          provider_id: row.provider_id,
          provider_label: nameOf(row),
          capability: req.capability,
          model,
          cached: true,
          ok: true,
          cost_cents: 0,
          duration_ms: 0,
          user_id: req.userId ?? null,
          input_summary: summariseInput(req.input),
          output_summary: truncate(JSON.stringify(shared.result)),
          input_full: fullText(await thumbnailImages(req.input)),
          output_full: fullText(shared.result),
          source_kind: req.source?.kind ?? null,
          source_id: req.source?.id ?? null,
          error: null,
          input_tokens: null,
          output_tokens: null,
        });
        return { ...shared, cached: true, cost_cents: 0, duration_ms: 0 };
      } catch {
        // The leader FAILED. Don't inherit a transient failure across every
        // follower — fall through and make our own attempt.
      }
    }
  }

  // Real call. A personal (user-scoped) credential supplies its own already-
  // decrypted secret; otherwise decrypt the workspace row (a virtual
  // credential-less row has no ciphertext — the provider brings its own).
  const runReal = async (): Promise<InvokeResult> => {
  const credentials =
    personalCredentials ??
    earlyCredentials ??
    (row.credentials_enc
      ? await integrationsImpl.decryptCredentials(req.orgId, row.credentials_enc)
      : {});
  let ok = false;
  let errMsg: string | null = null;
  let failure: unknown = null;
  let payload: Awaited<ReturnType<AiProviderDef["invoke"]>> = { result: null };
  let duration_ms = 0;
  // The model actually sent, not the router's placeholder: the log, the
  // failure line and the refusal name it (#3819).
  // A model nobody named is handed to the adapter as "default", so its own
  // choice for the job applies and the result says so (chosen: false). A
  // job's menu default used to arrive here as a name, read as somebody's
  // choice, and never got a sibling when it was busy (#4573).
  const resolved = def.resolveModel?.({ capability: req.capability, model: picked ? model : "default", credentials }) ?? { model, chosen: true };
  // The LADDER: the model, then, for one nobody chose, the provider's other
  // models on the same key for this job, in its order (busyAlternates: a
  // floating alias, then pinned older versions). A rung that answered busy
  // lately is cooling down (ai-busy-cooldown.ts) and is skipped, so the call
  // starts where the last one was answered. A person's choice is always
  // asked, and only it.
  const ladder = resolved.chosen ? [resolved.model] : [...new Set([resolved.model, ...(def.busyAlternates?.(resolved.model, req.capability) ?? [])])];
  const rungs = resolved.chosen ? ladder : ladder.filter((m) => !isCooling(row.id, m, req.capability));
  let sent = rungs[0] ?? resolved.model;
  if (rungs.length && sent !== resolved.model) {
    console.warn(`[core-ai] ${req.capability} ${row.provider_id}: ${ladder.slice(0, ladder.indexOf(sent)).join(", ")} cooling down after "busy"; starting on ${sent}`);
  }
  let rung = 0;
  // A busy provider is asked again inside this one call before anything
  // gives up (#3819): it answered, it is only turning calls away for now.
  // Only the first rung is asked again; a rung after it is asked once.
  // Every ask is its own row in the AI log.
  for (let attempt = 0; rungs.length > 0; attempt++) {
  const start = Date.now();
  ok = false;
  errMsg = null;
  failure = null;
  try {
    payload = await def.invoke({
      orgId: req.orgId,
      rowId: row.id,
      capability: req.capability,
      model: sent,
      credentials,
      input: req.input,
      // Per-call knobs win over the workspace row: the calling surface knows
      // its own output size / determinism needs best.
      config: { ...(row.config ?? {}), ...(req.config ?? {}) },
      // Only reached here, past the cache: a cached reply has nothing to
      // watch arrive, and streaming one would be a lie about where it came
      // from.
      ...(req.onDelta ? { onDelta: req.onDelta } : {}),
    });
    ok = true;
  } catch (err) {
    errMsg = (err as Error).message;
    failure = err;
  }
  duration_ms = Date.now() - start;

  await writeAuditRow(req.orgId, {
    provider_id: row.provider_id,
    provider_label: nameOf(row),
    capability: req.capability,
    model: sent,
    cached: false,
    ok,
    cost_cents: payload.cost_cents ?? null,
    duration_ms,
    user_id: req.userId ?? null,
    input_summary: summariseInput(req.input),
    output_summary: ok ? truncate(JSON.stringify(payload.result)) : null,
    input_full: fullText(await thumbnailImages(req.input)),
    output_full: ok ? fullText(payload.result) : null,
    source_kind: req.source?.kind ?? null,
    source_id: req.source?.id ?? null,
    error: errMsg,
    input_tokens: payload.input_tokens ?? null,
    output_tokens: payload.output_tokens ?? null,
  });
  if (ok) {
    // A real answer of this job is what proves the model free again.
    if (!resolved.chosen) noteAnswered(row.id, sent, req.capability);
    if (sent !== resolved.model) console.warn(`[core-ai] ${req.capability} ${row.provider_id}/${resolved.model} busy; answered by ${sent}`);
    break;
  }
  const failedReason = providerReasonOf(failure);
  // Which provider, which model, and why: the line a person reading the log
  // needs, and the model was the part it never said.
  console.warn(`[core-ai] ${req.capability} ${row.provider_id}/${sent} failed (${failedReason ?? "unknown"}), attempt ${attempt + 1}: ${errMsg}`);
  if (failedReason !== "busy") break;
  const pause = rung === 0 ? busyRetryDelaysMs[attempt] : undefined;
  if (pause === undefined) {
    if (!resolved.chosen) {
      const ms = noteBusy(row.id, sent, req.capability);
      console.warn(`[core-ai] ${req.capability} ${row.provider_id}/${sent} stayed busy; cooling down for ${Math.round(ms / 60_000)} min`);
    }
    rung++;
    const next = rungs[rung];
    if (!next) break;
    console.warn(`[core-ai] ${req.capability} ${row.provider_id}/${sent} stayed busy; asking ${next} on the same key`);
    sent = next;
    continue;
  }
  const asked = (failure as { retryAfterSec?: number } | null)?.retryAfterSec;
  await new Promise((r) => setTimeout(r, asked && asked * 1000 <= 10_000 ? asked * 1000 : pause));
  }
  if (rungs.length === 0) {
    // Every model this key offers for the job is cooling down: the provider
    // is busy without being asked, and the router moves on, or the caller
    // waits (a document is never read by a lighter model instead).
    sent = resolved.model;
    errMsg = `${row.provider_id}: every model for ${req.capability} answered "busy" lately (${ladder.join(", ")}); cooling down`;
    failure = providerError(row.provider_id, "busy", errMsg, 503);
    console.warn(`[core-ai] ${errMsg}`);
  }

  if (!ok) {
    // The provider's reason and the credential's door ride the refusal, so a
    // surface can say "this key is not valid, replace it under ..." instead
    // of a status (provider-reason.ts). The adapter redacted the key already.
    throw aiRefusal("provider_error", `core-ai invoke failed: ${errMsg}`, {
      reason: providerReasonOf(failure),
      door: String(row.id).startsWith("personal:") ? "personal" : "workspace",
      retryAfterSec: (failure as { retryAfterSec?: number } | null)?.retryAfterSec,
      providerId: row.provider_id,
      providerLabel: nameOf(row),
      model: sent,
    });
  }

  // Cache write (only on success + not bypassed).
  if (!req.bypass_cache) {
    try {
      // Re-acquire the tenant pool: the provider call above can run for
      // minutes (a queued claude bridge), past the idle reaper — writing
      // on the pre-call handle throws "pool after end".
      const tdbAfter = (await getTenantDb(req.orgId)) as unknown as typeof tdb;
      await tdbAfter
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
    model: sent,
    cached: false,
    input_tokens: payload.input_tokens,
    output_tokens: payload.output_tokens,
    cost_cents: payload.cost_cents,
    duration_ms,
  };
  };

  // Become the leader: register the in-flight promise so concurrent identical
  // callers coalesce onto it, and clear it when done (guarded so a follower that
  // fell through and started its own call doesn't delete someone else's entry).
  const p = runReal();
  if (!req.bypass_cache) inFlight.set(flightKey, p);
  try {
    return await p;
  } finally {
    if (!req.bypass_cache && inFlight.get(flightKey) === p) inFlight.delete(flightKey);
  }
};

async function writeAuditRow(
  orgId: string,
  row: {
    provider_id: string;
    /** The connection's own name, so the log says which one (nameOf). */
    provider_label: string;
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

// ── What a connection says it serves ─────────────────────────────────────────
//
// A menu built from a provider TYPE's suggestions offered llama3.2 and qwen2.5
// under a Claude bridge that serves sonnet, opus and haiku, and the settings
// refused a model the box had pulled because it was not on the type's list
// (#4586). A provider whose models depend on its endpoint implements
// listModels; this asks it, for the workspace's own connection or a personal
// one routed here, and keeps the answer for a minute so a menu opened twice
// does not ask twice.

const REPORTED_TTL_MS = 60_000;

/** The model typed on the connection itself, if any: the person's own pin. */
function pinnedOf(credentials: Record<string, unknown>): string[] {
  const m = typeof credentials.model === "string" ? credentials.model.trim() : "";
  return m ? [m] : [];
}
const reported = new Map<string, { at: number; value: AiReportedModels }>();

export async function modelsReportedBy(
  orgId: string,
  userId: string | null,
  ref: { providerId?: string; credentialId?: string },
  opts: { fresh?: boolean } = {},
): Promise<AiReportedModels | null> {
  let providerId = ref.providerId ?? null;
  let credentials: Record<string, unknown> | null = null;
  if (ref.credentialId) {
    const personal = await resolvePersonalProvider(orgId, userId, () => true, "ai-provider", "chat", ref.credentialId).catch(() => null);
    if (!personal || personal.credentialId !== ref.credentialId) return null;
    providerId = personal.providerId;
    credentials = personal.credentials;
  }
  if (!providerId) return null;
  const def = providers.get(providerId);
  if (!def?.listModels) return null;
  const key = `${orgId}|${ref.credentialId ?? `ws:${providerId}`}`;
  const hit = reported.get(key);
  if (hit && !opts.fresh && Date.now() - hit.at < REPORTED_TTL_MS) return hit.value;
  let value: AiReportedModels;
  try {
    if (!credentials) {
      const tdb = (await getTenantDb(orgId)) as unknown as {
        selectFrom: (t: string) => {
          select: (c: string[]) => { where: (c: string, op: string, v: unknown) => { where: (c: string, op: string, v: unknown) => { executeTakeFirst: () => Promise<{ credentials_enc: string | null } | undefined> } } };
        };
      };
      const row = await tdb.selectFrom("core_ai_providers").select(["credentials_enc"]).where("provider_id", "=", providerId).where("enabled", "=", true).executeTakeFirst();
      if (!row) return null;
      credentials = row.credentials_enc ? await integrationsImpl.decryptCredentials(orgId, row.credentials_enc) : {};
    }
    const live = await def.listModels(credentials);
    value = { ok: true, models: [...new Set([...live, ...pinnedOf(credentials)])] };
  } catch (err) {
    value = { ok: false, error: redactSecrets((err as Error)?.message ?? String(err), Object.values(credentials ?? {})), models: pinnedOf(credentials ?? {}) };
  }
  reported.set(key, { at: Date.now(), value });
  return value;
}
