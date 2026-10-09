// A starting list for "What's still here?" from one photo of a shelf or door.
//
// A vision model can list what it sees on one fridge door well enough to save
// ticking (about 13 of 16 on a door, one invented, in the local bench of
// #5400), and loops on a whole packed fridge. So this is a STARTING LIST and
// nothing more: the names it reads tick the matching records in the sheet,
// the person checks them, and nothing changes until they press the button.
// A name that matches nothing on record is shown to them as something to add,
// never created on its own.
import { ActionRefusal, platform } from "@cobblr/platform-contract";
import type { StocktakeItem } from "./stocktake.js";

/** What the model is asked. Names and counts only: the sheet needs no boxes. */
export const SHELF_PROMPT =
  "This photo shows ONE shelf, drawer or door of a fridge, freezer or pantry. " +
  "List each distinct item you can actually see (group identical ones into ONE " +
  "entry with a count). For each: a short everyday name (brand + what it is when " +
  "legible, e.g. \"Heinz ketchup\", \"eggs\", \"cheddar\") and how many. Do not " +
  "guess at things hidden behind others.\n\n" +
  'Reply with ONLY a JSON object: {"items": [{"name": <string>, "qty": <int >= 1>}]}.';

export interface SeenItem {
  name: string;
  qty: number;
}

const MAX_SEEN = 40;

/** The model's answer, shaped: named items, at most MAX_SEEN, counts at least 1. */
export function readSeen(text: string): SeenItem[] {
  const json = text.trim().startsWith("{") ? text.trim() : (text.match(/\{[\s\S]*\}/)?.[0] ?? "");
  let raw: unknown;
  try {
    raw = json ? JSON.parse(json) : null;
  } catch {
    return [];
  }
  const items = Array.isArray((raw as { items?: unknown } | null)?.items) ? ((raw as { items: unknown[] }).items as Array<Record<string, unknown>>) : [];
  const out: SeenItem[] = [];
  for (const it of items) {
    const name = typeof it.name === "string" ? it.name.trim().slice(0, 120) : "";
    if (!name) continue;
    const n = typeof it.qty === "number" && Number.isFinite(it.qty) ? Math.max(1, Math.round(it.qty)) : 1;
    out.push({ name, qty: n });
    if (out.length >= MAX_SEEN) break;
  }
  return out;
}

const STOP = new Set(["a", "an", "the", "of", "and", "with", "in", "jar", "bottle", "carton", "pack", "packet", "tub", "tin", "can", "box", "bag", "some", "half"]);

/** The words that name a thing: lower case, no punctuation, no sizes, no
 *  container words, each folded to its singular. */
export function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\d+(\.\d+)?\s*(g|kg|ml|l|oz|lb|pack|ct|x)\b/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w))
    .map((w) => (w.endsWith("ies") && w.length > 4 ? `${w.slice(0, -3)}y` : w.endsWith("es") && /(ch|sh|x|o)es$/.test(w) ? w.slice(0, -2) : w.endsWith("s") && !w.endsWith("ss") && w.length > 3 ? w.slice(0, -1) : w));
}

/** How alike two names are, 0..1. The same words are 1. Every word of one
 *  inside the other ("Eggs" in "Free range eggs", "Heinz ketchup" in "Heinz
 *  Tomato Ketchup 460g") is 0.9, just under, so an exact name wins a tie
 *  ("Milk" ticks Milk, not Oat milk). Otherwise the share of the LONGER
 *  name's words they have in common, so one shared word ("tomato") between
 *  a soup and a ketchup is not enough. */
export function nameMatch(a: string, b: string): number {
  const wa = new Set(nameWords(a));
  const wb = new Set(nameWords(b));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  if (shared === wa.size && shared === wb.size) return 1;
  if (shared === Math.min(wa.size, wb.size)) return 0.9;
  return shared / Math.max(wa.size, wb.size);
}

const ENOUGH = 0.5;

/** Which listed records the photo saw. Each record is ticked once, by the
 *  seen name that matches it best; a seen name matches one record at most. */
export function matchSeen(seen: readonly SeenItem[], items: readonly Pick<StocktakeItem, "id" | "title">[]): { matched: Array<{ id: string; seen: string }>; unmatched: SeenItem[] } {
  const pairs: Array<{ s: number; i: number; score: number }> = [];
  seen.forEach((sn, s) => items.forEach((it, i) => {
    const score = nameMatch(sn.name, it.title);
    if (score >= ENOUGH) pairs.push({ s, i, score });
  }));
  pairs.sort((x, y) => y.score - x.score);
  const usedSeen = new Set<number>();
  const usedItem = new Set<number>();
  const matched: Array<{ id: string; seen: string }> = [];
  for (const p of pairs) {
    if (usedSeen.has(p.s) || usedItem.has(p.i)) continue;
    usedSeen.add(p.s);
    usedItem.add(p.i);
    matched.push({ id: items[p.i]!.id, seen: seen[p.s]!.name });
  }
  return { matched, unmatched: seen.filter((_, s) => !usedSeen.has(s)) };
}

/** Ask the workspace's vision model what is on the shelf in this photo. */
export async function seenInPhoto(orgId: string, userId: string | null, fileId: string): Promise<SeenItem[]> {
  const file = (await platform().files.read(orgId, fileId, "medium")) ?? (await platform().files.read(orgId, fileId, "original"));
  if (!file) throw new ActionRefusal("That photo could not be read. Take it again.");
  let text: string;
  try {
    const r = await platform().ai.invoke({
      orgId,
      capability: "split-image",
      input: { image_b64: Buffer.from(file.bytes).toString("base64"), image_media_type: file.mimeType, prompt: SHELF_PROMPT },
      source: { kind: "inventory:stocktake-photo", id: fileId },
      userId,
    });
    text = r.text;
  } catch {
    throw new ActionRefusal("Reading a photo needs an AI connection that can see pictures, and none answered. Tick the list by hand instead.");
  }
  const seen = readSeen(text);
  if (!seen.length) throw new ActionRefusal("Nothing could be read from that photo. Try one shelf or one door, close up and lit.");
  return seen;
}
