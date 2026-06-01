// Hosted match-template (Phase 2) — the non-dev path.
//
// Phase 1 "match" = the driving model reads GET /templates and picks. That
// needs a model on the user's side (MCP / copy-paste). The HOSTED match is
// for users with NO model driving: a cheap core-ai call maps their intent to
// the nearest template + confidence, so the app can say "start from X?".
//
// Cost discipline (business-models/06, 08): one cheap call (haiku by default
// — the `chat` capability's cheap tier), minimal context (just the catalog's
// id/name/description/use_case, never the manifests). Degrades to the
// zero-inference catalog when no AI provider is configured — the feature is
// an accelerant, never a hard dependency.

import { platform } from "@cobblr/platform-contract";
import { listTemplates } from "./templates.js";

export interface TemplateMatch {
  /** Chosen template id, or null when nothing is a good fit / no provider. */
  template_id: string | null;
  /** 0..1; 0 when unmatched or degraded. */
  confidence: number;
  /** Short rationale, or a degrade reason ("no_ai_provider" | "no_match"). */
  reason: string;
  /** True when this came from the LLM; false when degraded to catalog-only. */
  ai: boolean;
}

function buildPrompt(intent: string): { system: string; user: string } {
  const cat = listTemplates()
    .map((t) => `- id="${t.id}" name="${t.name}" — ${t.description} (fits: ${t.use_case.join("; ")})`)
    .join("\n");
  const system =
    "You match a user's app idea to the single nearest starter template, or to none if nothing is close. " +
    'Reply with ONLY a JSON object: {"template_id": <id|null>, "confidence": <0..1>, "reason": <short string>}. ' +
    "Pick null (confidence 0) if no template is a reasonable starting point — do not force a bad fit.";
  const user = `TEMPLATES:\n${cat}\n\nUSER WANTS: "${intent}"\n\nWhich template id is the best starting point?`;
  return { system, user };
}

/** Tolerant parse — models wrap JSON in prose/fences. Mirrors core-scan. */
function parseMatch(result: unknown): { template_id: unknown; confidence: unknown; reason: unknown } | null {
  const raw =
    (typeof result === "object" && result !== null
      ? ((result as { content?: string; text?: string }).content ?? (result as { content?: string; text?: string }).text)
      : undefined) ?? "";
  if (!raw) return null;
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/**
 * Map a plain-English intent to the nearest template via one cheap LLM call.
 * Never throws on missing-provider / model failure — degrades to
 * { template_id: null, ai: false } so the caller falls back to catalog-read.
 */
export async function matchTemplateHosted(orgId: string, intent: string): Promise<TemplateMatch> {
  const valid = new Set(listTemplates().map((t) => t.id));
  const { system, user } = buildPrompt(intent);

  let result: unknown;
  try {
    const r = await platform().ai.invoke({
      orgId,
      capability: "chat",
      input: { messages: [{ role: "system", content: system }, { role: "user", content: user }] },
      source: { kind: "core-authoring:match-template", id: orgId },
    });
    result = r.result;
  } catch (e) {
    // No provider configured, or the call failed — degrade, don't error.
    const msg = e instanceof Error ? e.message : String(e);
    return { template_id: null, confidence: 0, reason: msg.includes("no provider") ? "no_ai_provider" : "ai_error", ai: false };
  }

  const parsed = parseMatch(result);
  if (!parsed) return { template_id: null, confidence: 0, reason: "unparseable", ai: true };

  // Guard the model's answer: only accept a real catalog id.
  const id = typeof parsed.template_id === "string" && valid.has(parsed.template_id) ? parsed.template_id : null;
  let confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;
  if (!id) confidence = 0;
  const reason = typeof parsed.reason === "string" ? parsed.reason : id ? "matched" : "no_match";

  return { template_id: id, confidence, reason, ai: true };
}
