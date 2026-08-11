// "What kinds are in this bin?" — one vision read over the assortment's photo.
//
// The whole point of assortments is that nobody types in fifty adapters. That
// only holds if describing the jumble is nearly free, and a photo the user has
// already taken is the cheapest input there is: the picture IS the description.
//
// This asks a different question from the scan inbox's identify pass. That one
// asks "what is this ONE item?"; this asks "what KINDS are in here, and roughly
// how many of each?". Both ride the same `identify-image` capability, which
// honours a caller-supplied prompt (see core-ai/providers/identify-prompt.ts —
// custom prompts used to be silently dropped, and that is fixed).
//
// See docs/design-decisions/assorted-contents.md.

import { platform } from "@cobblr/platform-contract";

export interface SuggestedKind {
  name: string;
  approximate_qty: number;
}

const KINDS_PROMPT = `You are looking at a photo of a storage bin holding an
assortment of loose items, jumbled together.

List the distinct KINDS of thing you can see, not individual items. A "kind" is
what a person would call a group of them: "DB25 gender changer", "USB-A cable",
"HDMI coupler". Estimate roughly how many of each are visible.

Rules:
- Only what you can actually see. Do not infer what is probably under the pile.
- Prefer the specific name when it is legible, the generic one when it is not.
- Estimates are expected to be rough. Round; do not agonise.
- At most 12 kinds. If there are more, list the most numerous.

Respond ONLY with JSON: {"kinds":[{"name":"...","approximate_qty":7}]}`;

/** Parse defensively: a model can return the array bare, wrapped, or fenced. */
export function parseKinds(raw: unknown): SuggestedKind[] {
  let val: unknown = raw;
  if (typeof val === "string") {
    const fenced = val.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try {
      val = JSON.parse(fenced);
    } catch {
      return [];
    }
  }
  const list =
    Array.isArray(val) ? val
    : Array.isArray((val as { kinds?: unknown })?.kinds) ? (val as { kinds: unknown[] }).kinds
    : Array.isArray((val as { items?: unknown })?.items) ? (val as { items: unknown[] }).items
    : [];

  const out: SuggestedKind[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name.trim() : "";
    if (!name) continue;
    const n = Number(e.approximate_qty ?? e.qty ?? e.count);
    out.push({
      name: name.slice(0, 160),
      // A kind with no usable number is still worth offering: the user knows
      // what is in their own bin and can fix the count. Dropping it would lose
      // the harder half of the work (the naming) over the easy half.
      approximate_qty: Number.isFinite(n) && n > 0 ? Math.round(n) : 1,
    });
    if (out.length >= 12) break;
  }
  return out;
}

/** Ask the model what kinds are in the photo. Returns [] rather than throwing:
 *  a failed suggestion should leave the user typing, not staring at an error. */
export async function suggestKindsFromPhoto(
  orgId: string,
  fileId: string,
  userId?: string | null,
): Promise<SuggestedKind[]> {
  const f =
    (await platform().files.read(orgId, fileId, "original")) ??
    (await platform().files.read(orgId, fileId, "medium"));
  if (!f) return [];
  try {
    const r = await platform().ai.invoke({
      orgId,
      capability: "identify-image",
      input: {
        image_b64: Buffer.from(f.bytes).toString("base64"),
        image_media_type: f.mimeType,
        prompt: KINDS_PROMPT,
      },
      source: { kind: "inventory:assortment-kinds", id: fileId },
      userId: userId ?? undefined,
    });
    return parseKinds((r as { output?: unknown })?.output ?? r);
  } catch {
    return [];
  }
}
