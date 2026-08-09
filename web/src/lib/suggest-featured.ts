// "There's a ready-made bundle for that" — deterministic, zero-AI match of a
// Build-page intent against the FEATURED catalog. The doc-08 cheap path: most
// "build me X" asks are near a curated template, and installing the refined
// bundle beats generating a worse one. Signals are the bundles' OWN declared
// vocabulary (name, noun, scan_keywords, instance labels) — nothing hardcoded
// per bundle here.
import { FEATURED_BUNDLES, type FeaturedBundle } from "./featured-bundles";

const WORD = /[a-z][a-z0-9-]{2,}/g;

function stem(w: string): string {
  return w.replace(/(ies|es|s)$/, (m) => (m === "ies" ? "y" : ""));
}

function bundleVocab(fb: FeaturedBundle): Map<string, number> {
  const m = fb.manifest;
  // A bundle's vocabulary: its name, each instance's slug/label/noun, and
  // declared scan_keywords. All self-descriptive data the bundle already ships.
  const vocab = new Map<string, number>(); // term -> weight
  const add = (t: string | undefined, w: number) => {
    for (const tok of (t ?? "").toLowerCase().match(WORD) ?? []) {
      const s = stem(tok);
      vocab.set(s, Math.max(vocab.get(s) ?? 0, w));
    }
  };
  add(m.name, 3);
  add(fb.blurb, 2);
  const insts = [...(m.provides_instances ?? []), ...(m.features ?? []).flatMap((f) => f.provides_instances ?? [])];
  for (const inst of insts) {
    add(inst.instance_name, 3);
    add(inst.display_name, 3);
    add(inst.item_noun, 3);
    for (const k of inst.scan_keywords ?? []) add(k, 2);
  }
  return vocab;
}

/** Best featured-bundle match for a free-text intent, or null when nothing
 *  clears the bar. Conservative on purpose — a wrong "install this instead"
 *  suggestion is worse than none:
 *  - terms shared by several bundles ("part", "item") carry no signal
 *    (document-frequency weighting over the catalog itself);
 *  - a suggestion needs a strong term that is UNIQUE to the winning bundle;
 *  - callers pass the live instance names so an already-installed thing is
 *    never suggested ("install Laser Cutters" when they have laser cutters).
 *
 *  It used to ALSO require a "track/collect/inventory/stash/…" verb, so that a
 *  field tweak ("add a warranty date to parts") was never answered with
 *  "install a bundle". That gate silently swallowed the most natural input
 *  there is - a bare noun. Typing "yarn" matched nothing in either Build mode,
 *  even though a Yarn bundle ships (reported 2026-08-01).
 *
 *  The tweak-vs-new question is now answered by the CALLER, and answered
 *  better: it asks suggest-kinds.ts whether the sentence lands on kinds the
 *  workspace ALREADY HAS. "add a warranty date to parts" resolves onto Part →
 *  a modification, no install pitch. "yarn" resolves onto nothing → a new
 *  thing, and there's a refined bundle for it. That reads the workspace
 *  instead of guessing from a verb list. */

/** intent word ~ vocab term: exact after stemming, or a ≥4-char prefix of the
 *  other ("book" ~ "bookshelf"). */
function hits(word: string, term: string): boolean {
  if (word === term) return true;
  const [a, b] = word.length <= term.length ? [word, term] : [term, word];
  return a.length >= 4 && b.startsWith(a);
}

export function suggestFeatured(
  intent: string,
  liveInstances: ReadonlySet<string> = new Set(),
): { bundle: FeaturedBundle; matched: string } | null {
  const words = new Set((intent.toLowerCase().match(WORD) ?? []).map(stem));
  if (words.size === 0) return null;

  // Suggest only from the OFFERED catalog — a disabled bundle is withdrawn, so it
  // must not be proposed for a build-page intent (same tier rule as every other
  // discovery surface; see docs/design-decisions/bundle-catalog-tiers.md).
  const offered = FEATURED_BUNDLES.filter((fb) => fb.manifest.catalog !== "disabled");
  const vocabs = offered.map((fb) => ({ fb, vocab: bundleVocab(fb) }));
  // df: in how many bundles' vocabularies does each term appear?
  const df = new Map<string, number>();
  for (const { vocab } of vocabs) for (const t of vocab.keys()) df.set(t, (df.get(t) ?? 0) + 1);

  let best: { bundle: FeaturedBundle; score: number; matched: string } | null = null;
  for (const { fb, vocab } of vocabs) {
    // Skip bundles whose instances are all already live in the workspace.
    const insts = (fb.manifest.provides_instances ?? []).map((i) => i.instance_name);
    if (insts.length > 0 && insts.every((n) => liveInstances.has(n))) continue;
    let score = 0;
    let matched = "";
    let uniqueStrong = false;
    for (const w of words) {
      let weight = 0;
      let termHit = "";
      for (const [t, tw] of vocab) {
        if (hits(w, t) && tw > weight) {
          weight = tw;
          termHit = t;
        }
      }
      if (!weight) continue;
      const spread = df.get(termHit) ?? 1;
      if (spread >= 3) continue; // catalog-common noise ("part", "item")
      score += spread === 2 ? weight / 2 : weight;
      if (weight >= 3 && spread === 1) {
        uniqueStrong = true;
        matched = w;
      } else if (!matched) matched = w;
    }
    if (uniqueStrong && score >= 3 && (!best || score > best.score)) best = { bundle: fb, score, matched };
  }
  return best ? { bundle: best.bundle, matched: best.matched } : null;
}
