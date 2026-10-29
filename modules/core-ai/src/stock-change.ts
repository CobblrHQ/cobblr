// "Add 10 zip ties to the garage shelf", with no AI (#8868).
//
// A count change to a part found by its name is a plan code can make: read the
// number, find the one part the words name (on the place, when one is said),
// and offer "+10" as a card to confirm and undo, as "make Shelf 1 through 3"
// is offered. Cobb with no AI used to answer it "Use + New at the top of the
// relevant list", in a workspace where the zip ties were one tap away.
//
// It never guesses: two parts the words fit is a question, none is said so,
// and either way nothing is offered to run.

import type { WorkspaceApi } from "@cobblr/workspace-tools";
import { countOf } from "@cobblr/platform-contract";
import { wordsOf } from "./question-text.js";

export interface StockAsk {
  delta: number;
  /** What the part is called, as said ("zip ties"). */
  thing: string;
  /** Where it is, when said ("garage shelf"). */
  place?: string;
}

/** "add 10 zip ties to the garage shelf", "put 3 M3 nuts in the bench drawers",
 *  "add 5 to the M3 screws". A number is required: "add a place called…" is
 *  another command's. */
export const STOCK_ASK = /^\s*(?:please\s+)?(?:add|put)\s+(\d{1,6})\s+(?:(?:to|onto)\s+(?:the\s+|my\s+)?(.+?)|(.+?)(?:\s+(?:to|on|onto|in|into)\s+(?:the\s+|my\s+)?(.+?))?)\s*[.!]?\s*$/i;

export function readStockAsk(message: string): StockAsk | null {
  const m = STOCK_ASK.exec(message);
  if (!m) return null;
  const delta = Number(m[1]);
  if (!delta) return null;
  if (m[2]) return { delta, thing: m[2].trim() };
  const thing = m[3]!.trim();
  return { delta, thing, ...(m[4] ? { place: m[4].trim() } : {}) };
}

export interface PartRow {
  id: string;
  name: string;
  qty?: number | null;
  unit?: string | null;
  location_name?: string | null;
}

/** "ties" and "tie" are the same word to a person; a trailing s is not a
 *  different part. */
const stem = (w: string) => (w.length > 3 ? w.replace(/(?:es|s)$/, "") : w);
const everyWordIn = (said: string, text: string | null | undefined): boolean => {
  const have = wordsOf(text ?? "").map(stem);
  return wordsOf(said).every((w) => have.some((h) => h === stem(w) || h.startsWith(stem(w))));
};

/** The parts the words name: every word of the thing in the part's name, and
 *  every word of the place in where it is, when a place was said. */
export function pickParts(rows: readonly PartRow[], ask: StockAsk): PartRow[] {
  return rows.filter((r) => everyWordIn(ask.thing, r.name) && (!ask.place || everyWordIn(ask.place, r.location_name)));
}

/** The card's sentence: what changes, by how much, from what to what, where. */
export function stockChangeSaid(part: PartRow, delta: number): string {
  const where = part.location_name ? `, ${part.location_name}` : "";
  const counts = typeof part.qty === "number" ? ` (${part.qty} → ${part.qty + delta}${where})` : where ? ` (${part.location_name})` : "";
  return `Add ${delta} to ${part.name}${counts}.`;
}

export type StockTarget =
  | { kind: "one"; ask: StockAsk; part: PartRow }
  | { kind: "many"; ask: StockAsk; parts: PartRow[] }
  | { kind: "none"; ask: StockAsk };

/** Read the message and find its part. Null when it is not a stock change, or
 *  the workspace has no parts to look in. */
export async function findStockTarget(wsApi: WorkspaceApi, message: string): Promise<StockTarget | null> {
  const ask = readStockAsk(message);
  if (!ask) return null;
  // The longest word narrows the read; every word is then checked here, so a
  // name with the words apart ("M3 x 10 bolts" for "M3 bolts") is still found.
  const needle = stem(wordsOf(ask.thing).sort((a, b) => b.length - a.length)[0] ?? ask.thing);
  const r = await wsApi.request("GET", `/modules/inventory/parts?q=${encodeURIComponent(needle)}&limit=50`);
  const rows = (r.body as { items?: PartRow[] }).items;
  if (!Array.isArray(rows)) return null;
  const parts = pickParts(rows, ask);
  if (parts.length === 1) return { kind: "one", ask, part: parts[0]! };
  return parts.length ? { kind: "many", ask, parts } : { kind: "none", ask };
}

/** What Cobb says when it cannot offer the change: which one, or that there is
 *  no such part. */
export function stockAskSaid(t: Exclude<StockTarget, { kind: "one" }>): { answer: string; detail: string } {
  const on = t.ask.place ? ` on ${t.ask.place}` : "";
  if (t.kind === "none") {
    return { answer: `No part here is called "${t.ask.thing}"${on}`, detail: "say it as the part is listed, or add it with + New in Inventory" };
  }
  const shown = t.parts.slice(0, 5).map((p) => (p.location_name ? `${p.name} (${p.location_name})` : p.name));
  const more = t.parts.length > 5 ? `, and ${t.parts.length - 5} more` : "";
  return { answer: `Which one? ${countOf(t.parts.length, "part")} fit "${t.ask.thing}"${on}`, detail: shown.join(", ") + more };
}
