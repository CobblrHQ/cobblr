// OpenAI's models, as its own /v1/models reports them for a key (#5417).
//
// The adapter wrote gpt-4o, gpt-4o-mini and o1-mini into code per job, the
// same stale-list shape that kept Claude's picker on 4.5; and the rule that
// read the listing stopped at gpt-5.x, so a key that could use GPT-6 was
// offered GPT-5.5 at best. Now a model is a TIER and a version: gpt-6-luna is
// Luna 6, gpt-5.4-mini is mini 5.4, gpt-5.5 is GPT 5.5. Each tier has a
// "latest" that moves when the listing does (never sent: the router resolves
// it), and every exact version can be pinned.
//
// OPENAI_FALLBACK_MODELS is the one list written down, for when the listing
// cannot be read; a test fails when it lacks a tier's newest model in the
// recorded listing (fixtures/openai-models.json). OPENAI_PRICES is the one
// price table the cost ledger reads; a listed model it does not name logs no
// cost rather than $0.

import type { AiCapability } from "@cobblr/platform-contract";
import type { AiListedModel, AiModelCatalog } from "@cobblr/platform-contract/ai-models";

export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

/** A general text model the chat-completions adapter can drive: gpt-4o,
 *  gpt-4.1, gpt-5 and later, with their tiers. Not a dated snapshot (the
 *  alias names the same model), and none of the special-purpose variants
 *  (-pro, -codex, -chat, -image, -audio, gpt-oss). */
const GENERAL = /^gpt-(4o|4\.1|[5-9](?:\.\d+)?)(?:-(mini|nano|luna|terra|sol|astra))?$/;
/** Tiers, lightest first. "gpt" is the untiered model (gpt-5.5). */
export const OPENAI_FAMILY_ORDER = ["nano", "mini", "luna", "gpt", "terra", "sol", "astra"] as const;
/** The light tiers, never handed a plan or a document. Every GENERAL model
 *  takes an image, so the image jobs need no rule of their own. */
const LIGHT = new Set(["nano", "mini", "luna"]);
/** The top tier, priced like it: never on a high-volume job. */
const TOP = new Set(["astra"]);
const EMBEDDING = /^text-embedding-/;

const IMAGE_JOBS = new Set<AiCapability>(["classify-image", "identify-image", "identify-glance", "split-image", "rank-images", "extract-text", "document-read"]);
const FULLER_JOBS = new Set<AiCapability>(["plan-changes", "document-read"]);
const TEXT_JOBS = new Set<AiCapability>(["chat", "plan-changes", "design-workspace", "summarise", "match-to-catalog", ...IMAGE_JOBS]);
const LIGHT_JOBS = new Set<AiCapability>(["summarise", "classify-image", "identify-image", "identify-glance", "split-image", "rank-images", "extract-text", "match-to-catalog"]);

const LATEST = /^gpt-(?:(nano|mini|luna|terra|sol|astra)-)?latest$/;
export const openAiLatestId = (family: string): string => (family === "gpt" ? "gpt-latest" : `gpt-${family}-latest`);

/** The default per job: a tier's latest, never a version. */
export const OPENAI_DEFAULT_FAMILY: Partial<Record<AiCapability, string>> = {
  chat: "luna",
  summarise: "luna",
  "match-to-catalog": "luna",
  "classify-image": "luna",
  "identify-image": "luna",
  "identify-glance": "luna",
  "split-image": "luna",
  "rank-images": "luna",
  "extract-text": "luna",
  // The fuller tier: a plan that deletes or reshapes, a document whose
  // values are kept, and the workspace's first impression.
  "design-workspace": "sol",
  "plan-changes": "sol",
  "document-read": "sol",
};

/** A reasoning model takes no temperature: the adapter leaves it out. */
export function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-[5-9])/.test(model);
}

/** For when the listing cannot be read: each tier's newest in the recorded
 *  listing, and gpt-4o and gpt-4o-mini, which existing pins name. */
export const OPENAI_FALLBACK_MODELS: readonly AiListedModel[] = [
  { id: "gpt-6-luna" },
  { id: "gpt-6.1-sol" },
  { id: "gpt-6-astra" },
  { id: "gpt-5.6-terra" },
  { id: "gpt-5.5" },
  { id: "gpt-5.4-mini" },
  { id: "gpt-5.4-nano" },
  { id: "gpt-4o" },
  { id: "gpt-4o-mini" },
  { id: "text-embedding-3-small" },
  { id: "text-embedding-3-large" },
];

/** Cents per million tokens, OpenAI's list prices (recorded with the
 *  listing); "unknown" logs no cost. */
export const OPENAI_PRICES: Readonly<Record<string, { input: number; output: number } | "unknown">> = {
  "gpt-4.1": { input: 200, output: 800 },
  "gpt-4.1-mini": { input: 40, output: 160 },
  "gpt-4.1-nano": { input: 10, output: 40 },
  "gpt-4o": { input: 250, output: 1000 },
  "gpt-4o-mini": { input: 15, output: 60 },
  "gpt-5": { input: 125, output: 1000 },
  "gpt-5-mini": { input: 25, output: 200 },
  "gpt-5-nano": { input: 5, output: 40 },
  "gpt-5.1": { input: 125, output: 1000 },
  "gpt-5.2": { input: 175, output: 1400 },
  "gpt-5.4": { input: 250, output: 1500 },
  "gpt-5.4-mini": { input: 75, output: 450 },
  "gpt-5.4-nano": { input: 20, output: 125 },
  "gpt-5.5": { input: 500, output: 3000 },
  "gpt-5.6-luna": { input: 20, output: 120 },
  "gpt-5.6-sol": { input: 200, output: 1000 },
  "gpt-5.6-terra": { input: 200, output: 1200 },
  "gpt-6-astra": { input: 1000, output: 5000 },
  "gpt-6-luna": { input: 10, output: 50 },
  "gpt-6-sol": { input: 200, output: 1000 },
  "gpt-6.1-sol": { input: 200, output: 1000 },
  "text-embedding-3-small": { input: 2, output: 0 },
  "text-embedding-3-large": { input: 13, output: 0 },
};

export function openAiCostCents(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = OPENAI_PRICES[model];
  if (!p || p === "unknown") return null;
  return Math.ceil((inputTokens * p.input + outputTokens * p.output) / 1_000_000);
}

export const openAiCatalog: AiModelCatalog = {
  parse(id) {
    const m = GENERAL.exec(id);
    // gpt-4o is known by that name, not a version: offered and pinned as
    // itself, outside every tier, so no tier's latest is ever it.
    if (!m || m[1] === "4o") return null;
    return { family: m[2] ?? "gpt", version: m[1]!.split(".").map(Number) };
  },
  familyLabel: (family) => (family === "gpt" ? "GPT" : `GPT ${family === "mini" || family === "nano" ? family : family.charAt(0).toUpperCase() + family.slice(1)}`),
  latestId: openAiLatestId,
  familyOfLatest: (id) => {
    const m = LATEST.exec(id);
    return m ? (m[1] ?? "gpt") : null;
  },
  familyOrder: OPENAI_FAMILY_ORDER,
  canDo(capability, model) {
    if (capability === "embed-text") return EMBEDDING.test(model.id);
    const tier = GENERAL.exec(model.id);
    if (!TEXT_JOBS.has(capability) || !tier) return false;
    const family = tier[2] ?? "gpt";
    if (FULLER_JOBS.has(capability) && LIGHT.has(family)) return false;
    if (LIGHT_JOBS.has(capability) && TOP.has(family)) return false;
    return true;
  },
  async list(credentials) {
    const apiKey = String(credentials.api_key ?? "");
    if (!apiKey) throw new Error("openai: missing api_key");
    const res = await fetch(OPENAI_MODELS_URL, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`openai: listing models answered ${res.status}`);
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? []).flatMap((m) => (typeof m.id === "string" ? [{ id: m.id }] : []));
  },
  fallback: OPENAI_FALLBACK_MODELS,
};

/** The adapter's per-job declaration, from the fallback and the rules: each
 *  tier's latest first, then the versions to pin; the default a tier's latest. */
export function openAiCapabilities(): Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> {
  const out: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> = {};
  for (const cap of TEXT_JOBS) {
    const usable = OPENAI_FALLBACK_MODELS.filter((m) => openAiCatalog.canDo(cap, m));
    const families = [...new Set(usable.flatMap((m) => openAiCatalog.parse(m.id)?.family ?? []))];
    const family = OPENAI_DEFAULT_FAMILY[cap] ?? families[0];
    out[cap] = { models: [...families.map(openAiLatestId), ...usable.map((m) => m.id)], ...(family ? { defaultModel: openAiLatestId(family) } : {}) };
  }
  const embed = OPENAI_FALLBACK_MODELS.filter((m) => EMBEDDING.test(m.id)).map((m) => m.id);
  out["embed-text"] = { models: embed, defaultModel: "text-embedding-3-small" };
  return out;
}
