// Which of the models THIS box actually has should run a capability.
//
// The provider ships a menu — llama3.2, llava, phi3 — chosen when those were
// the obvious answers. A real box (measured 2026-08-25) had qwen3 and gemma4
// and not one name from that list, which meant every photo scan resolved to
// `llava`, a model it did not have, and 404ed. The menu is a guess about
// somebody else's disk; /api/tags is the answer.
//
// So: when the model we were going to send is not installed, ask what is, and
// pick the best fit for the capability rather than failing. Pure and tested,
// because "which model is a vision model" is a judgement that will need editing
// as names change, and it should be editable in one place.

/** Name fragments that mark a model as able to SEE, best first. */
const VISION: RegExp[] = [
  /qwen[\d.]*-?vl/i, // qwen2.5vl, qwen3-vl — strongest small VLMs
  /minicpm-?v/i,
  /granite.*vision/i,
  /llama.*vision/i,
  /(^|[^a-z])gemma3/i, // gemma3 is multimodal; gemma2 is not
  /internvl/i,
  /pixtral/i,
  /moondream/i,
  /llava/i, // the old default: still works, still last
];

/** Name fragments that mark a model as a decent TOOL CALLER, best first.
 *  Ordered by what the bench measured and by what each family advertises. */
const TOOLS: RegExp[] = [
  /qwen3/i,
  /qwen2\.5(?!vl)/i,
  /command-?r/i,
  /granite3/i,
  /mistral|mixtral|nemo/i,
  /llama3\.[13]/i,
  /llama3/i,
];

/** Models that must never be picked automatically for real work. */
const AVOID = /embed|guard|moderation|reranker/i;

export type PickCapability = "vision" | "text";

/** The capability a name is being picked for. Vision covers every surface that
 *  sends an image; everything else is a text/tool turn. */
export function pickKind(capability: string): PickCapability {
  return /image|vision|extract-text|rank-images/.test(capability) ? "vision" : "text";
}

/**
 * The best installed model for this capability, or null when the box has
 * nothing suitable — in which case the caller should say so rather than send a
 * name that will 404.
 */
export function pickInstalledModel(capability: string, installed: readonly string[]): string | null {
  const usable = installed.filter((m) => !AVOID.test(m));
  if (!usable.length) return null;
  const order = pickKind(capability) === "vision" ? VISION : TOOLS;
  for (const pattern of order) {
    // Among equals prefer the SHORTER name: "qwen3:14b" over
    // "qwen3:14b-instruct-q8_0", which is the same model said longer.
    const hits = usable.filter((m) => pattern.test(m)).sort((a, b) => a.length - b.length);
    if (hits.length) return hits[0]!;
  }
  // Vision is a real capability: a text-only model cannot fake it, so a box with
  // no VLM gets null and an honest error rather than a confident wrong answer.
  if (pickKind(capability) === "vision") return null;
  return usable.sort((a, b) => a.length - b.length)[0]!;
}
