// Identify a product from its barcode by web search — the fallback for
// when the catalog DBs (upcitemdb / Open Products Facts) have no entry.
// It mirrors what a person does: search the UPC, read the product name
// off the agreeing top results. Ported from companion app, with the LLM
// half routed through core-ai (metered, provider-agnostic) instead of a
// direct provider call.
//
// Two stages, belt-and-suspenders so a slow/absent LLM never leaves the
// scan with nothing:
//   1. A DDG image search on the raw UPC — titles are name candidates,
//      images are photo candidates (one call yields both). A cleaned,
//      English-preferring title is the instant *heuristic* floor.
//   2. One folded identify+classify LLM call (core-ai `chat`) refines
//      the titles into a clean name + brand + sku + category. If core-ai
//      has no provider configured, or the call fails, the heuristic
//      name stands.

import { platform } from "@cobblr/platform-contract";
import { searchImages, rankImageOptions, type DdgImageResult } from "./ddg-images.js";

export interface WebSearchProduct {
  name: string;
  brand: string | null;
  sku: string | null;
  /** Free-form category hint, e.g. "tool" / "electronics" / "material". */
  category: string | null;
  /** Routing hint for the commit step: a discrete item vs a component. */
  entityType: "asset" | "part" | null;
  imageUrl: string | null;
  /** 0..1 — how strongly the results converge on this product. */
  confidence: number;
  /** "llm" when the model refined it, "heuristic" when only stage 1 ran. */
  method: "llm" | "heuristic";
  /** One-line evidence string for the inbox row's ai_notes. */
  evidence: string;
}

// Hang guard only — scan responsiveness is owned by the caller's outer
// budget (enrich detaches there). Generous so a merely-slow model still
// returns its folded result in one round-trip rather than racing out
// and forcing a wasteful second call (companion app's hard-won lesson).
const LLM_DEADLINE_MS = 20_000;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const key = it.toLowerCase();
    if (it && !seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3);
}

// Strip the retailer/marketplace noise a page title carries so it reads
// as just the product. Heuristic-floor only; the LLM gets raw titles.
export function cleanTitle(raw: string, upc: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  // A leading storefront prefix — "Amazon.com: …", "Walmart.com - …",
  // "eBay: …" — is the site talking, not the product: a domain-shaped
  // token (or a big marketplace by name) followed by a separator.
  t = t
    .replace(/^\s*[\w'&. -]{1,30}\.(?:com|net|org|ca|de|co\.uk)\s*[:|–—-]\s+/i, "")
    .replace(/^\s*(?:amazon|walmart|ebay|etsy|aliexpress)\s*:\s+/i, "")
    .trim();
  t = t.replace(/\s*[|–—]\s*[^|–—]{1,40}$/, "").trim();
  t = t.split(upc).join(" ");
  t = t.replace(/\b(upc|ean|gtin|barcode|lookup)\b/gi, " ");
  return t.replace(/\s+/g, " ").trim();
}

// Fraction of a string's letters that are Latin a–z. DDG mixes in
// foreign-market listings; the heuristic prefers English titles.
function latinRatio(s: string): number {
  const letters = s.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return 1;
  return (s.match(/[a-zA-Z]/g) ?? []).length / letters.length;
}

// The heuristic floor: the cleaned title that recurs most (ties → the
// longer, more descriptive one); when all unique, the longest usable.
export function pickHeuristicName(cleaned: string[]): string | null {
  const usable = cleaned.filter((t) => t.length >= 6 && /[a-z]/i.test(t));
  if (usable.length === 0) return null;
  const english = usable.filter((t) => latinRatio(t) >= 0.7);
  const pool = english.length > 0 ? english : usable;
  const counts = new Map<string, { title: string; n: number }>();
  for (const t of pool) {
    const key = t.toLowerCase();
    const cur = counts.get(key);
    if (cur) cur.n++;
    else counts.set(key, { title: t, n: 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || b.title.length - a.title.length)[0]!.title;
}

// Pick the result image whose title best overlaps the chosen name.
export function pickImage(results: DdgImageResult[], name: string): string | null {
  const want = new Set(tokenize(name));
  let best: { url: string; score: number } | null = null;
  for (const r of results) {
    if (!r.url) continue;
    const score = tokenize(r.title).filter((w) => want.has(w)).length;
    if (!best || score > best.score) best = { url: r.url, score };
  }
  return best?.url ?? results.find((r) => r.url)?.url ?? null;
}

export interface LlmIdentity {
  name: string;
  brand: string | null;
  sku: string | null;
  category: string | null;
  entityType: "asset" | "part" | null;
  confidence: number;
}

/** One folded identify+classify call via core-ai `chat`. Returns null
 *  if there's no provider, the call fails/times out, or the model can't
 *  name a product. Exported as the barcode-identify eval seam (P3) — given
 *  fixed result titles it's deterministic-input (only model variance), unlike
 *  the full `resolveBarcodeViaWebSearch` which also depends on live DDG. */
export async function llmIdentify(orgId: string, upc: string, titles: string[]): Promise<LlmIdentity | null> {
  const system =
    "You identify ONE retail product from its barcode (UPC/EAN) and any " +
    "web-search result titles provided. PREFER the titles when present — they " +
    "come from retailer and barcode-database pages, and agreement across them " +
    "is a strong signal. If NO titles are given but you genuinely recognize " +
    "this specific barcode, you MAY identify it from your own knowledge — but " +
    "ONLY when you are actually confident. If you would be guessing, or the " +
    "titles are junk/contradictory/not a real product, reply name null and " +
    "confidence 0. NEVER fabricate a product. Then give a coarse category and " +
    "say whether it's an 'asset' (a discrete, individually-tracked whole item " +
    "— a tool, device, appliance, machine) or a 'part' (a component, " +
    "consumable, material or supply).\n\n" +
    'Reply with ONLY a JSON object: {"name": <brand + model + what it is, or null>, ' +
    '"brand": <string|null>, "sku": <model/SKU or null>, "category": <one or two ' +
    'words, e.g. "power tool", "fastener", "filament", or null>, "entity_type": ' +
    '"asset"|"part"|null, "confidence": <0..1 — your genuine certainty>}.';
  const titleBlock = titles.length
    ? `Search result titles:\n` + titles.map((t, i) => `${i + 1}. ${t}`).join("\n")
    : "(no web-search titles were available — identify from the barcode only if you are confident)";
  const user = `UPC: ${upc}\n\n${titleBlock}`;

  const call = platform()
    .ai.invoke({
      orgId,
      capability: "chat",
      input: { messages: [{ role: "system", content: system }, { role: "user", content: user }] },
      source: { kind: "core-scan:barcode", id: upc },
    })
    .then((r) => r.result as { content?: string })
    .catch(() => null);

  const res = await Promise.race([
    call,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), LLM_DEADLINE_MS)),
  ]);
  if (!res?.content) return null;

  let parsed: Record<string, unknown>;
  try {
    // Tolerant: models sometimes wrap JSON in prose or ``` fences.
    const m = res.content.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : res.content);
  } catch {
    return null;
  }
  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!name) return null;
  const et = parsed.entity_type;
  return {
    name,
    brand: typeof parsed.brand === "string" ? parsed.brand.trim() || null : null,
    sku: typeof parsed.sku === "string" ? parsed.sku.trim() || null : null,
    category: typeof parsed.category === "string" ? parsed.category.trim() || null : null,
    entityType: et === "asset" || et === "part" ? et : null,
    confidence: clamp01(typeof parsed.confidence === "number" ? parsed.confidence : 0.6),
  };
}

/**
 * Resolve a product from its UPC by web search. Returns null when the
 * search backend is down or the UPC turns up nothing usable — the
 * caller then falls through to its existing "fill in manually" path.
 */
export async function resolveBarcodeViaWebSearch(orgId: string, upc: string): Promise<WebSearchProduct | null> {
  const code = upc.trim();
  if (!code) return null;

  // Stage 1 — best-effort grounding titles. NOTE: DDG's image index doesn't
  // cover bare UPCs (a number isn't an image query) and its text endpoints are
  // anti-bot-gated on a shared IP, so this usually returns nothing here — and
  // that's fine. We do NOT bail on empty results: a previous early-return on
  // zero titles made the LLM identify structurally UNREACHABLE for every
  // barcode, so the floor never resolved anything. The model can still try
  // from the UPC itself (conservatively — see the prompt).
  let results: DdgImageResult[] = [];
  try {
    results = await searchImages(code, 12);
  } catch {
    results = []; // search backend down / blocked — keep going to the LLM
  }
  const titled = results.filter((r) => r.title && r.title.trim());
  const rawTitles = dedupe(
    // DDG truncates long titles with a trailing "…" / "..." — drop it.
    titled.map((r) => r.title.replace(/\s+/g, " ").replace(/\s*(?:\.{2,}|…)\s*$/, "").trim()),
  );
  const cleaned = rawTitles.map((t) => cleanTitle(t, code)).filter(Boolean);
  const heuristicName = pickHeuristicName(cleaned); // null when there were no titles

  // Stage 2 — folded identify+classify via core-ai. Reached even with zero
  // titles; the heuristic floor only applies when titles actually existed.
  const llm = await llmIdentify(orgId, code, rawTitles.slice(0, 12));

  const name = llm?.name ?? heuristicName;
  if (!name) return null; // genuinely nothing — caller falls to "fill in manually"

  // Stage 3 — a product photo. DDG image search WORKS for a product name (it
  // just can't do a bare UPC), so once we have a name, search the NAME. Prefer
  // an image already returned by the UPC search (rare) before spending a call.
  let imageUrl = titled.length ? pickImage(titled, name) : null;
  if (!imageUrl) {
    try {
      // Rank by catalog quality (retail/brand domain + square-ish) and take the
      // best — NOT the first DDG hit, which is often a recipe-blog / social /
      // styled photo. The clean studio shot is usually buried a few results down.
      const byName = await searchImages(name, 24);
      imageUrl = rankImageOptions(byName, llm?.brand)[0]?.url ?? null;
    } catch {
      imageUrl = null; // best-effort; the row is still useful without a photo
    }
  }

  return {
    name,
    brand: llm?.brand ?? null,
    sku: llm?.sku ?? null,
    category: llm?.category ?? null,
    entityType: llm?.entityType ?? null,
    imageUrl,
    confidence: llm ? llm.confidence : 0.4,
    method: llm ? "llm" : "heuristic",
    evidence: llm
      ? titled.length
        ? `Identified from a web search of UPC ${code} (${titled.length} results), AI-confirmed.`
        : `Identified from UPC ${code} by AI product knowledge (no web results on this host).`
      : `Identified from a web search of UPC ${code} (${titled.length} results), title heuristic.`,
  };
}
