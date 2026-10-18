// Claude's models, as Anthropic's own models endpoint reports them for a key.
//
// The adapter used to write claude-sonnet-4-5, claude-haiku-4-5 and
// claude-opus-4-5 into code per job, so a key that could use the 5.5
// generation was offered 4.5 and nothing else (#5417). Now the list comes
// from GET /v1/models, a job takes any listed model its RULE accepts, and the
// default per job is a family's "latest", which moves when the listing does.
//
// ANTHROPIC_FALLBACK_MODELS is the ONE list of Claude models written down, for
// when the listing cannot be read. The cloud overlay's managed provider
// imports it from "@cobblr/core-ai/providers/anthropic-models.js" rather than
// keeping a copy. A test holds it to a recorded listing
// (fixtures/anthropic-models.json): naming a model that listing no longer has
// fails it.
//
// ANTHROPIC_PRICES is the one price table the cost ledger reads for a Claude
// call, per model id. A listed model without a row is priced "unknown" and
// its calls log no cost rather than $0; a test fails on any model the
// recorded listing has that the table does not mention.

// EGRESS-FILE: vendor-fixed - the provider's API address, written in the code
import type { AiCapability } from "@cobblr/platform-contract";
import type { AiListedModel, AiModelCatalog } from "@cobblr/platform-contract/ai-models";

export const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";

/** claude-<family>-<major>[-<minor>][-<yyyymmdd>]. A dated id is the same
 *  model as its alias; the listing reports some models only dated. */
const ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?$/;

/** The alias a dated id stands for ("claude-haiku-4-5-20251001" →
 *  "claude-haiku-4-5"): the name a person picks and a pin is stored by. */
export function anthropicAlias(id: string): string {
  return id.replace(/-\d{8}$/, "");
}

const LATEST = /^claude-([a-z]+)-latest$/;

/** Whether a model takes `temperature`. Claude 5 and later answer it with a
 *  400 ("deprecated for this model"); a family's "latest" is the newest, so
 *  it is taken to be one of those. An id this cannot read is sent it, and a
 *  refusal is learned (refused-params.ts). */
export function anthropicTakesTemperature(model: string): boolean {
  if (LATEST.test(model)) return false;
  const m = ID.exec(model);
  return !m || Number(m[2]) < 5;
}

/** Lighter first: haiku, sonnet, opus, then anything newer by name. */
export const ANTHROPIC_FAMILY_ORDER = ["haiku", "sonnet", "opus"] as const;

/** How heavy a family is. A family nobody here has heard of yet is taken as
 *  the heaviest: it may do any job a person picks it for, but no light job
 *  (a photo, a summary) is offered a model priced like the top tier. */
function tierOf(family: string): number {
  const i = (ANTHROPIC_FAMILY_ORDER as readonly string[]).indexOf(family);
  return i < 0 ? ANTHROPIC_FAMILY_ORDER.length + 1 : i + 1;
}

/** Jobs that hand the model a picture. */
const IMAGE_JOBS = new Set<AiCapability>(["classify-image", "identify-image", "identify-glance", "split-image", "rank-images", "extract-text", "document-read"]);
/** Jobs a lighter model never gets: a plan that deletes or reshapes, a
 *  document whose values are kept. */
const FULLER_JOBS = new Set<AiCapability>(["plan-changes", "document-read"]);
/** High-volume jobs: offered the light and middle tiers, never the top one. */
const LIGHT_JOBS = new Set<AiCapability>(["summarise", "classify-image", "identify-image", "identify-glance", "split-image", "rank-images", "extract-text", "match-to-catalog"]);
/** Jobs a Claude model does at all. */
const CLAUDE_JOBS = new Set<AiCapability>([
  "chat",
  "plan-changes",
  "design-workspace",
  "summarise",
  "classify-image",
  "identify-image",
  "identify-glance",
  "split-image",
  "rank-images",
  "extract-text",
  "match-to-catalog",
  "document-read",
]);

export const anthropicLatestId = (family: string): string => `claude-${family}-latest`;

/** The default per job: a family's latest, never a version. */
export const ANTHROPIC_DEFAULT_FAMILY: Partial<Record<AiCapability, string>> = {
  chat: "haiku",
  // Sonnet rather than Haiku: this job runs a handful of times per workspace
  // and its answer is the whole first impression of the product.
  "design-workspace": "sonnet",
  // A plan that deletes or reshapes is the fuller model's to make.
  "plan-changes": "sonnet",
  // A document's values are kept, so the read gets the fuller model.
  "document-read": "sonnet",
  summarise: "haiku",
  "classify-image": "haiku",
  "identify-image": "haiku",
  "identify-glance": "haiku",
  "split-image": "haiku",
  "rank-images": "haiku",
  "extract-text": "haiku",
  "match-to-catalog": "haiku",
};

/** For when the listing cannot be read: the current generation and the one
 *  before it, which existing pins name. Refreshed only together with the
 *  recorded listing it is tested against. */
export const ANTHROPIC_FALLBACK_MODELS: readonly AiListedModel[] = [
  { id: "claude-haiku-5-5", label: "Haiku 5.5", vision: true },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", vision: true },
  { id: "claude-opus-5-5", label: "Opus 5.5", vision: true },
  { id: "claude-fable-5-1", label: "Fable 5.1", vision: true },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", vision: true },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5", vision: true },
  { id: "claude-opus-4-5", label: "Opus 4.5", vision: true },
];

/** Cents per million tokens. `over` is a higher rate the whole call pays once
 *  its prompt passes `above` tokens. Cache reads cost 0.1x the input rate,
 *  cache writes 1.25x. "unknown" is said on purpose: the call logs no cost
 *  and the AI log says the price is unknown. */
export type ModelPrice = { input: number; output: number; over?: { above: number; input: number; output: number } } | "unknown";

export const ANTHROPIC_PRICES: Readonly<Record<string, ModelPrice>> = {
  "claude-fable-5-1": { input: 1000, output: 5000 },
  "claude-fable-5": { input: 1000, output: 5000 },
  "claude-opus-5-5": { input: 400, output: 2000 },
  "claude-opus-5": { input: 500, output: 2500 },
  "claude-opus-4-8": { input: 500, output: 2500 },
  "claude-opus-4-7": { input: 500, output: 2500 },
  "claude-opus-4-6": { input: 500, output: 2500 },
  "claude-opus-4-5": { input: 500, output: 2500 },
  "claude-sonnet-5-5": { input: 200, output: 1000 },
  "claude-sonnet-5": { input: 200, output: 1000 },
  "claude-sonnet-4-6": { input: 300, output: 1500 },
  "claude-sonnet-4-5": { input: 300, output: 1500 },
  "claude-haiku-5-5": { input: 10, output: 50, over: { above: 100_000, input: 50, output: 250 } },
  "claude-haiku-4-5": { input: 100, output: 500 },
};

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** What a call cost, in cents, rounded up; null when the model's price is
 *  unknown, so the ledger never records a guess as $0. */
export function anthropicCostCents(model: string, usage: AnthropicUsage): number | null {
  const micro = anthropicCostMicroCents(model, usage);
  return micro === null ? null : Math.ceil(micro / 1_000_000);
}

/** The same cost unrounded, in millionths of a cent: what one cheap call's
 *  cache saving is measured in, since a whole cent hides it. */
export function anthropicCostMicroCents(model: string, usage: AnthropicUsage): number | null {
  const price = ANTHROPIC_PRICES[anthropicAlias(model)];
  if (!price || price === "unknown") return null;
  const read = usage.cache_read_input_tokens ?? 0;
  const write = usage.cache_creation_input_tokens ?? 0;
  const prompt = usage.input_tokens + read + write;
  const rate = price.over && prompt > price.over.above ? price.over : price;
  return usage.input_tokens * rate.input + read * rate.input * 0.1 + write * rate.input * 1.25 + usage.output_tokens * rate.output;
}

interface ListedPage {
  data?: Array<{ id?: unknown; display_name?: unknown; capabilities?: { image_input?: { supported?: unknown } } }>;
  has_more?: boolean;
  last_id?: string | null;
}

/** A /v1/models response, read: one entry per alias, in the listing's order. */
export function anthropicListed(pages: readonly ListedPage[]): AiListedModel[] {
  const out = new Map<string, AiListedModel>();
  for (const page of pages) {
    for (const m of page.data ?? []) {
      if (typeof m.id !== "string") continue;
      const id = anthropicAlias(m.id);
      if (out.has(id)) continue;
      const vision = m.capabilities?.image_input?.supported;
      out.set(id, {
        id,
        ...(typeof m.display_name === "string" ? { label: m.display_name } : {}),
        ...(typeof vision === "boolean" ? { vision } : {}),
      });
    }
  }
  return [...out.values()];
}

export const anthropicCatalog: AiModelCatalog = {
  parse(id) {
    const m = ID.exec(anthropicAlias(id));
    if (!m) return null;
    return { family: m[1]!, version: m[3] !== undefined ? [Number(m[2]), Number(m[3])] : [Number(m[2])] };
  },
  familyLabel: (family) => family.charAt(0).toUpperCase() + family.slice(1),
  latestId: anthropicLatestId,
  familyOfLatest: (id) => LATEST.exec(id)?.[1] ?? null,
  familyOrder: ANTHROPIC_FAMILY_ORDER,
  canDo(capability, model) {
    if (!CLAUDE_JOBS.has(capability)) return false;
    const parsed = anthropicCatalog.parse(model.id);
    if (!parsed) return false;
    if (IMAGE_JOBS.has(capability) && model.vision === false) return false;
    const tier = tierOf(parsed.family);
    if (FULLER_JOBS.has(capability) && tier < 2) return false;
    if (LIGHT_JOBS.has(capability) && tier > 2) return false;
    return true;
  },
  async list(credentials) {
    const apiKey = String(credentials.api_key ?? "");
    if (!apiKey) throw new Error("anthropic: missing api_key");
    const pages: ListedPage[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const url = `${ANTHROPIC_MODELS_URL}?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
      const res = await fetch(url, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`anthropic: listing models answered ${res.status}`);
      const page = (await res.json()) as ListedPage;
      pages.push(page);
      if (!page.has_more || !page.last_id) break;
      after = page.last_id;
    }
    return anthropicListed(pages);
  },
  fallback: ANTHROPIC_FALLBACK_MODELS,
};

/** The adapter's per-job declaration, derived from the fallback and the
 *  rules: what a surface with no listing at hand offers, and the default
 *  (a family's latest) each job starts on. */
export function anthropicCapabilities(): Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> {
  const out: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>> = {};
  for (const cap of CLAUDE_JOBS) {
    const usable = ANTHROPIC_FALLBACK_MODELS.filter((m) => anthropicCatalog.canDo(cap, m));
    const families = [...new Set(usable.map((m) => anthropicCatalog.parse(m.id)!.family))];
    const family = ANTHROPIC_DEFAULT_FAMILY[cap] ?? families[0];
    out[cap] = {
      models: [...families.map(anthropicLatestId), ...usable.map((m) => m.id)],
      ...(family ? { defaultModel: anthropicLatestId(family) } : {}),
    };
  }
  return out;
}
