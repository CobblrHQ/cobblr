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
import { searchImages, searchText, rankImageOptions, type DdgImageResult } from "./ddg-images.js";

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
// budget (enrich detaches there). Must be GENEROUS: a self-hosted / personal
// AI bridge (e.g. a dial-out `claude -p` relay) can take 100s+ per call, and
// under a scan burst the per-channel concurrency cap queues calls deeper still.
// At the old 20s this ALWAYS timed out on such a bridge → the web-search "found
// nothing" before the model ever answered. Match the matchmaker's tolerance so
// the model actually gets to finish; the outer 12s budget keeps the UI snappy.
const LLM_DEADLINE_MS = 150_000;

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

// Non-product pages DDG surfaces for a bare UPC — inventory/price-tracker and
// barcode-database tools, not the item itself ("Target Inventory Checker -
// BrickSeek"). Reject outright so they can't become a name candidate.
const JUNK_TITLE =
  /\b(brickseek|camelcamelcamel|keepa|inventory checker|stock checker|price (?:history|tracker|drop|check)|in-?stock (?:checker|alert|tracker)|barcode (?:lookup|database)|upc (?:database|lookup|item ?db)|ean[- ]?search|buycott)\b/i;

// Strip the retailer/marketplace noise a page title carries so it reads
// as just the product. Heuristic-floor only; the LLM gets raw titles.
export function cleanTitle(raw: string, upc: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  if (JUNK_TITLE.test(t)) return ""; // dropped by the caller's .filter(Boolean)
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

// Combining accent marks (é, à, ñ, ü, ç…). latinRatio only catches non-Latin
// SCRIPTS (Cyrillic/CJK); a French/Spanish title is Latin-script but accent-heavy.
function diacriticCount(s: string): number {
  return (s.normalize("NFD").match(/[̀-ͯ]/g) ?? []).length;
}

// High-frequency non-English function words that rarely show up in an English
// product name — a cheap language tell for Latin-script foreign titles ("María"
// has only one accent, but "Galletas DE chocolate" gives itself away).
const FOREIGN_HINT =
  /\b(de|la|el|los|las|con|sin|para|del|und|der|die|das|mit|für|et|le|les|du|des|aux|pour|avec|sans|di|il|della|delle|com|não|naturale|biologique)\b/gi;

// How "foreign" a title looks (higher = less English): non-Latin script dominates,
// then accents, then non-English function words. DDG mixes in foreign-market
// listings; without an LLM this keeps the heuristic floor English when it can.
function foreignScore(t: string): number {
  return (
    (1 - latinRatio(t)) * 3 +
    diacriticCount(t) * 0.5 +
    (t.match(FOREIGN_HINT) ?? []).length
  );
}

// The heuristic floor: the cleaned title that recurs most (ties → the
// longer, more descriptive one); when all unique, the longest usable.
export function pickHeuristicName(cleaned: string[]): string | null {
  const usable = cleaned.filter((t) => t.length >= 6 && /[a-z]/i.test(t));
  if (usable.length === 0) return null;
  // Keep only the most-English tier (lowest foreignScore), then rank by
  // recurrence/length within it — falling through to a foreign title only when
  // there's no more-English candidate.
  const minScore = Math.min(...usable.map(foreignScore));
  const pool = usable.filter((t) => foreignScore(t) <= minScore + 0.5);
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
// GS1 number-bank prefix → country/region of registration (the public ranges).
// Just the country, not the manufacturer (that needs GEPIR), but it's a free,
// deterministic hint that helps the model when web titles are thin: 859 → Czech
// Republic tells it a bare 8594173… is likely a Czech maker (e.g. Prusa).
const GS1_RANGES: Array<[number, number, string]> = [
  [0, 139, "the USA or Canada"], [300, 379, "France"], [380, 380, "Bulgaria"],
  [383, 383, "Slovenia"], [385, 385, "Croatia"], [387, 387, "Bosnia & Herzegovina"],
  [389, 389, "Montenegro"], [400, 440, "Germany"], [450, 459, "Japan"], [460, 469, "Russia"],
  [471, 471, "Taiwan"], [474, 474, "Estonia"], [475, 475, "Latvia"], [477, 477, "Lithuania"],
  [479, 479, "Sri Lanka"], [480, 480, "the Philippines"], [482, 482, "Ukraine"],
  [489, 489, "Hong Kong"], [490, 499, "Japan"], [500, 509, "the United Kingdom"],
  [520, 521, "Greece"], [529, 529, "Cyprus"], [539, 539, "Ireland"],
  [540, 549, "Belgium or Luxembourg"], [560, 560, "Portugal"], [569, 569, "Iceland"],
  [570, 579, "Denmark"], [590, 590, "Poland"], [594, 594, "Romania"], [599, 599, "Hungary"],
  [600, 601, "South Africa"], [609, 609, "Mauritius"], [611, 611, "Morocco"],
  [613, 613, "Algeria"], [616, 616, "Kenya"], [619, 619, "Tunisia"], [622, 622, "Egypt"],
  [625, 625, "Jordan"], [626, 626, "Iran"], [627, 627, "Kuwait"], [628, 628, "Saudi Arabia"],
  [629, 629, "the UAE"], [640, 649, "Finland"], [690, 699, "China"], [700, 709, "Norway"],
  [729, 729, "Israel"], [730, 739, "Sweden"], [740, 745, "Central America"], [750, 750, "Mexico"],
  [754, 755, "Canada"], [759, 759, "Venezuela"], [760, 769, "Switzerland"], [770, 771, "Colombia"],
  [773, 773, "Uruguay"], [775, 775, "Peru"], [777, 777, "Bolivia"], [778, 779, "Argentina"],
  [780, 780, "Chile"], [784, 784, "Paraguay"], [786, 786, "Ecuador"], [789, 790, "Brazil"],
  [800, 839, "Italy"], [840, 849, "Spain"], [850, 850, "Cuba"], [858, 858, "Slovakia"],
  [859, 859, "the Czech Republic"], [860, 860, "Serbia"], [865, 865, "Mongolia"],
  [868, 869, "Turkey"], [870, 879, "the Netherlands"], [880, 880, "South Korea"],
  [885, 885, "Thailand"], [888, 888, "Singapore"], [890, 890, "India"], [893, 893, "Vietnam"],
  [896, 896, "Pakistan"], [899, 899, "Indonesia"], [900, 919, "Austria"], [930, 939, "Australia"],
  [940, 949, "New Zealand"], [955, 955, "Malaysia"], [958, 958, "Macau"],
];
export function gs1Country(upc: string): string | null {
  const d = upc.replace(/\D/g, "");
  if (d.length < 8) return null;
  // EAN-13 carries the prefix in its first 3 digits; a 12-digit UPC-A is prefix 0xx.
  const p = parseInt((d.length === 12 ? "0" + d : d).slice(0, 3), 10);
  if (Number.isNaN(p) || (p >= 978 && p <= 979)) return null; // 978/979 = ISBN books
  for (const [lo, hi, country] of GS1_RANGES) if (p >= lo && p <= hi) return country;
  return null;
}

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
  // A free, deterministic country hint from the GS1 prefix — useful mainly when
  // titles are thin (the model can lean on "registered in the Czech Republic" to
  // place a maker). It is a WEAK signal (registration country ≠ origin), so frame
  // it as a hint, not a fact.
  const country = gs1Country(upc);
  const countryHint = country
    ? `\nGS1 prefix hint: this barcode is registered in ${country} (a weak clue to the maker, not proof of origin).`
    : "";
  const user = `UPC: ${upc}${countryHint}\n\n${titleBlock}`;

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

  // Stage 1 — best-effort grounding titles, from BOTH DDG endpoints in parallel:
  //  • TEXT search (html.duckduckgo.com) — the PRIMARY name source. Unlike the
  //    image index, the text index resolves a bare UPC to its retail product
  //    pages, e.g. 086279249609 → "Cuisinart Chef's Classic Nonstick 11in Square
  //    Griddle". This is what makes the floor actually resolve a number.
  //  • IMAGE search — rarely titles a bare UPC, but its hits double as Stage-3
  //    photo candidates, so we still fire it.
  // We do NOT bail on empty results: a previous early-return on zero titles made
  // the LLM identify structurally UNREACHABLE, so the floor never resolved
  // anything. With nothing, the model still tries from the UPC (conservatively).
  const [textTitles, results] = await Promise.all([
    searchText(code, 10)
      .then((rs) => rs.map((r) => r.title))
      .catch(() => [] as string[]),
    searchImages(code, 12).catch(() => [] as DdgImageResult[]),
  ]);
  const titled = results.filter((r) => r.title && r.title.trim());
  const rawTitles = dedupe(
    // Text titles first (real product-page titles); image titles after. DDG
    // truncates long titles with a trailing "…" / "..." — drop it.
    [...textTitles, ...titled.map((r) => r.title)]
      .map((t) => t.replace(/\s+/g, " ").replace(/\s*(?:\.{2,}|…)\s*$/, "").trim())
      .filter(Boolean),
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
