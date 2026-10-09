// OpenAI's models, as its own /v1/models reports them for a key (#5417).
//
// The adapter wrote gpt-4o, gpt-4o-mini and o1-mini into code per job, the
// same stale-list shape that kept Claude's picker on 4.5. Now a job takes any
// listed GPT model its rule accepts. OpenAI's ids carry no family-and-version
// shape a "latest" could follow (gpt-4o, gpt-4.1, gpt-5, each with -mini and
// -nano tiers that are priced and behave differently), so every entry here is
// an exact version: nothing moves on its own.
//
// OPENAI_FALLBACK_MODELS is the one list written down, for when the listing
// cannot be read. OPENAI_PRICES is the one price table the cost ledger reads;
// a listed model it does not name logs no cost rather than $0.

import type { AiCapability } from "@cobblr/platform-contract";
import type { AiListedModel, AiModelCatalog } from "@cobblr/platform-contract/ai-models";

export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

/** A general text model the chat-completions adapter can drive: gpt-4o,
 *  gpt-4.1, gpt-5 and later, with their tiers. Not a dated snapshot (the
 *  alias names the same model), and none of the special-purpose variants. */
const GENERAL = /^gpt-(4o|4\.1|[5-9](\.\d+)?)(-(mini|nano))?$/;
/** The light tiers, never handed a plan or a document. Every GENERAL model
 *  takes an image, so the image jobs need no rule of their own. */
const LIGHT = /-(mini|nano)$/;
const EMBEDDING = /^text-embedding-/;

const IMAGE_JOBS = new Set<AiCapability>(["classify-image", "identify-image", "identify-glance", "split-image", "rank-images", "extract-text", "document-read"]);
const FULLER_JOBS = new Set<AiCapability>(["plan-changes", "document-read"]);
const TEXT_JOBS = new Set<AiCapability>(["chat", "plan-changes", "design-workspace", "summarise", "match-to-catalog", ...IMAGE_JOBS]);

/** A reasoning model takes no temperature: the adapter leaves it out. */
export function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-[5-9])/.test(model);
}

export const OPENAI_FALLBACK_MODELS: readonly AiListedModel[] = [
  { id: "gpt-4o" },
  { id: "gpt-4o-mini" },
  { id: "text-embedding-3-small" },
  { id: "text-embedding-3-large" },
];

/** Cents per million tokens; "unknown" logs no cost. */
export const OPENAI_PRICES: Readonly<Record<string, { input: number; output: number } | "unknown">> = {
  "gpt-4o": { input: 250, output: 1000 },
  "gpt-4o-mini": { input: 15, output: 60 },
  "text-embedding-3-small": { input: 2, output: 0 },
  "text-embedding-3-large": { input: 13, output: 0 },
};

export function openAiCostCents(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = OPENAI_PRICES[model];
  if (!p || p === "unknown") return null;
  return Math.ceil((inputTokens * p.input + outputTokens * p.output) / 1_000_000);
}

export const openAiCatalog: AiModelCatalog = {
  parse: () => null,
  familyLabel: (family) => family,
  latestId: (family) => family,
  familyOfLatest: () => null,
  canDo(capability, model) {
    if (capability === "embed-text") return EMBEDDING.test(model.id);
    if (!TEXT_JOBS.has(capability) || !GENERAL.test(model.id)) return false;
    if (FULLER_JOBS.has(capability) && LIGHT.test(model.id)) return false;
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

/** The adapter's per-job declaration, from the fallback and the rules. */
export function openAiCapabilities(): Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> {
  const DEFAULTS: Partial<Record<AiCapability, string>> = {
    chat: "gpt-4o-mini",
    // The bigger model: rare, heavy, and the answer is either recognisable as
    // their own things or they give up.
    "design-workspace": "gpt-4o",
    // The full model: a plan that deletes or reshapes is a serious action,
    // and a document's values are kept.
    "plan-changes": "gpt-4o",
    "document-read": "gpt-4o",
    "embed-text": "text-embedding-3-small",
  };
  const out: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> = {};
  for (const cap of [...TEXT_JOBS, "embed-text" as AiCapability]) {
    const models = OPENAI_FALLBACK_MODELS.filter((m) => openAiCatalog.canDo(cap, m)).map((m) => m.id);
    if (!models.length) continue;
    out[cap] = { models, defaultModel: DEFAULTS[cap] ?? (models.includes("gpt-4o-mini") ? "gpt-4o-mini" : models[0]) };
  }
  return out;
}
