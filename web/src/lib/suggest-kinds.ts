// "What does this touch?", answered from the sentence instead of asked as a
// question. The Build page used to open with a chip per entity kind and make
// you pick 1-3 before typing anything — a constraint that exists for the MODEL
// (assembleContext caps kind scope because a small model wires to the wrong
// kind when handed the whole catalog) promoted to the user's first decision.
// The list also grew with every bundle and mixed real nouns (Part, Machine)
// with internal child records (Order item, Sales line item, Catalog entry).
//
// So: derive the scope from the intent text. Signals are each kind's OWN
// declared vocabulary — display name, instance name, module, and its FIELD
// names — never a hand-kept keyword table (the author's derive-from-fields rule).
// Same shape as suggest-featured.ts, which already matches this exact textarea
// against the featured catalog.

import type { PlatformEntityKind } from "./api";

const WORD = /[a-z][a-z0-9-]{2,}/g;

function stem(w: string): string {
  return w.replace(/(ies|es|s)$/, (m) => (m === "ies" ? "y" : ""));
}

function tokens(s: string | null | undefined): string[] {
  return [...((s ?? "").toLowerCase().match(WORD) ?? [])].map(stem);
}

/** A kind's vocabulary: term -> weight. Its names identify it; its fields say
 *  what it holds, which is what makes "add a warranty date" land on the kind
 *  that has a warranty field without anyone maintaining a synonym list. */
function kindVocab(k: PlatformEntityKind): Map<string, number> {
  const vocab = new Map<string, number>();
  const add = (t: string | null | undefined, w: number) => {
    for (const term of tokens(t)) vocab.set(term, Math.max(vocab.get(term) ?? 0, w));
  };
  add(k.display_name, 3);
  add(k.display_name_plural, 3);
  add(k.instance_name, 3);
  add(k.module_name, 2);
  for (const f of k.fields ?? []) {
    add(f.name, 1);
    add(f.role, 1);
  }
  return vocab;
}

/** intent word ~ vocab term: exact after stemming, or a >=4-char prefix of the
 *  other ("printer" ~ "printers", "warrant" ~ "warranty"). */
function hits(word: string, term: string): boolean {
  if (word === term) return true;
  const [a, b] = word.length <= term.length ? [word, term] : [term, word];
  return a.length >= 4 && b.startsWith(a);
}

export interface ScopeSuggestion {
  kind: PlatformEntityKind;
  score: number;
  /** The intent words that put this kind in scope — shown as the "why". */
  matched: string[];
}

/** Rank the workspace's kinds against a free-text intent. Returns at most
 *  `limit` (the model's own scope cap), best first, or [] when nothing clears
 *  the bar — in which case the caller says so plainly rather than guessing. */
export function suggestKinds(
  intent: string,
  kinds: readonly PlatformEntityKind[],
  limit = 3,
): ScopeSuggestion[] {
  const words = new Set(tokens(intent));
  if (words.size === 0 || kinds.length === 0) return [];

  const vocabs = kinds.map((k) => ({ k, vocab: kindVocab(k) }));
  // Document frequency over the workspace's OWN catalog: a term nearly every
  // kind declares ("name", "notes", "item", "created") carries no signal here,
  // however heavily its own kind weights it. This is what keeps "add a note to
  // parts" from matching all 25 kinds.
  const df = new Map<string, number>();
  for (const { vocab } of vocabs) for (const term of vocab.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  const common = Math.max(2, Math.ceil(kinds.length * 0.34));

  const scored: ScopeSuggestion[] = [];
  for (const { k, vocab } of vocabs) {
    let score = 0;
    const matched: string[] = [];
    for (const word of words) {
      let best = 0;
      let bestTerm = "";
      for (const [term, weight] of vocab) {
        if ((df.get(term) ?? 0) >= common) continue; // too common to mean anything
        if (hits(word, term) && weight > best) {
          best = weight;
          bestTerm = term;
        }
      }
      if (best > 0) {
        score += best;
        matched.push(bestTerm);
      }
    }
    // A name-level hit (weight 3) alone is enough; field-level hits (weight 1)
    // need to corroborate each other, so one shared field name can't drag a
    // kind in on its own.
    if (score >= 2) scored.push({ kind: k, score, matched });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.kind.display_name.localeCompare(b.kind.display_name))
    .slice(0, limit);
}
