// Coarse category roll-up for the NO-AI put-away fallback
// (docs/product/guided-organize.md).
//
// The barcode intelligence stamps a `category` on most scanned goods, but the
// raw values are noisy, multilingual and granular: "Whiskey", "whisky",
// "Whisky américain", "Tequilas", "Liqueurs" and "spirits" are all one shelf.
// On a brand-new workspace with no bins yet, the heuristic proposes no bins, so
// every item used to dead-end at "unassigned" — the planner told you nothing
// about where anything should go (reported 2026-07-11: "it's not telling me where
// to put anything").
//
// This rolls those noisy categories into a small set of COARSE STARTER BINS so
// the no-AI path can propose real destinations ("you gotta start somewhere").
// The taxonomy is deliberately generic — universal consumer/household/maker
// shelves, not any one workspace's use-case. It is a DATA normaliser over a
// category value the catalog already assigned; it never keyword-matches on item
// names to infer behaviour. When AI is available it groups and names far better,
// so this only runs on the heuristic tier.
//
// Pure + unit-tested (api/tests/scan-category-buckets.test.ts).

import { isJunkCategory } from "@cobblr/platform-contract/category-reconcile";

/** A coarse shelf: a stable `key` to group by and a clean `name` for the bin. */
export interface CategoryBucket {
  key: string;
  name: string;
}

// Ordered rules — SPECIFIC before GENERAL (the first hit wins). Each `match` is
// tested against the normalised category string (lowercased, path tail only,
// whitespace-collapsed). Keep the shelves broad: the whole point is that a pile
// of granular categories collapses onto a handful of bins a person would
// actually label a drawer with.
const RULES: Array<{ match: RegExp; bucket: CategoryBucket }> = [
  // Maker / hobby shelves first — they carry words ("resin", "spool") that a
  // general "household" rule might otherwise swallow.
  { match: /filament|\b3d\s*print|\bpla\b|\bpetg\b|\babs\b|resin|nozzle|hotend/, bucket: { key: "filament", name: "3D Printing & Filament" } },
  { match: /yarn|thread|fabric|sewing|knit|crochet|\bcraft|hobby|\bbead|art suppl|spool|scrapbook|quilt/, bucket: { key: "crafts", name: "Crafts & Hobbies" } },
  // Compound terms that share a token with a FOOD/CARE rule below go first —
  // first-match-wins means "motor oil" must outrank groceries' \boil\b, and
  // "framing nails" must outrank personal-care's nail-polish vocabulary. The
  // class: a generic single token (\boil\b, \bnut\b, \bnail\b) in an early
  // rule silently claims every compound that contains it.
  { match: /motor oil|engine oil|transmission fluid|brake fluid|antifreeze|\bcoolant\b|power steering|windshield washer/, bucket: { key: "auto", name: "Automotive" } },
  // Alcohol before beverages/groceries so "beer" and "wine" don't scatter.
  { match: /whisk|bourbon|scotch|tequila|\brum\b|rums|vodka|\bgin\b|liqueur|spirit|\bwine|\bbeer|\bale\b|lager|cognac|brandy|mezcal|\bsake\b|cider|champagne|prosecco|vermouth|aperitif|liquor/, bucket: { key: "liquor", name: "Liquor & Spirits" } },
  { match: /water|soda|\bpop\b|cola|juice|coffee|\btea\b|energy drink|sports drink|kombucha|seltzer|lemonade|beverage|\bdrink/, bucket: { key: "beverages", name: "Beverages" } },
  { match: /grocery|groceries|\bfood\b|produce|fruit|vegetable|\bmeat|poultry|seafood|snack|candy|chocolate|cereal|pasta|\brice\b|sauce|condiment|spice|seasoning|olive.?oil|\boil\b|vinegar|dairy|cheese|bread|bakery|\bdip|spread|almonds?|cashews?|peanuts?|walnuts?|pecans?|pistachios?|mixed nuts|trail mix|\bjam\b|honey|canned|\bsoup|breakfast|dessert|frozen/, bucket: { key: "groceries", name: "Groceries" } },
  { match: /\bhair\b|\bskin\b|deodorant|\bsoap\b|shampoo|lotion|cosmetic|makeup|toothpaste|hygiene|razor|shav(e|ing)|fragrance|perfume|personal care|body wash|nail (?:polish|file|clippers?|art|care)|manicure|pedicure/, bucket: { key: "personal-care", name: "Personal Care" } },
  { match: /medical|medicine|pharma|supplement|vitamin|first aid|needle|syringe|bandage|\bhealth/, bucket: { key: "health", name: "Health & Medical" } },
  { match: /\bbook|magazine|\bmedia\b|\bdvd\b|\bcd\b|vinyl|board game|\bgame\b|\bpuzzle/, bucket: { key: "books-media", name: "Books & Media" } },
  { match: /\bbulb|\blamp|\blight|\bled\b|lighting|sconce|lantern/, bucket: { key: "lighting", name: "Lighting" } },
  { match: /electronic|\bcable|charger|adapter|batter|\busb\b|hdmi|gadget|\bgps\b|phone|computer|\baudio|headphone|speaker|\bwir(e|ing)/, bucket: { key: "electronics", name: "Electronics & Cables" } },
  { match: /\btool|hardware|screw|\bbolt|\bnuts?\b|\bnails?\b|drill|wrench|fastener|hinge|bracket|\btape\b/, bucket: { key: "tools", name: "Tools & Hardware" } },
  { match: /\blabel|\btag\b|paper|napkin|stationery|\bpen\b|pencil|notebook|envelope|\bink\b|office/, bucket: { key: "office", name: "Office & Paper" } },
  { match: /\bpet\b|\bdog\b|\bcat\b|animal|aquarium|litter/, bucket: { key: "pet", name: "Pet Supplies" } },
  { match: /baby|infant|toddler|\bkids\b|diaper|\btoy/, bucket: { key: "kids", name: "Baby & Kids" } },
  { match: /automotive|\bcar\b|\bauto\b|vehicle|\btire|motor oil/, bucket: { key: "auto", name: "Automotive" } },
  { match: /\bhome\b|garden|kitchen|cleaning|storage|organiz|furniture|decor|\bglass\b|household|appliance|snow blower|outdoor|patio|bath/, bucket: { key: "household", name: "Household & Home" } },
];

/** Normalise a raw category: take the tail of a taxonomy path ("Electronics >
 *  GPS Accessories" → "gps accessories"), lowercase, collapse whitespace. */
function normalise(raw: string): string {
  const tail = raw.split(/[>/›»|]/).pop() ?? raw;
  return tail.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Title-case a normalised category for use as its OWN bin name — the graceful
 *  fallback when nothing in the coarse map matches (respects the workspace's own
 *  vocabulary: a "Judaica" pile becomes a "Judaica" bin, not a forced shelf). */
function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Map a raw catalog category onto a coarse starter bin. Returns null when the
 *  category is empty/junk (nothing to shelve on) — those items keep their
 *  name-token / orphan handling. A non-empty but unmapped category becomes its
 *  own single-purpose bin, so the workspace's real vocabulary still gets a home
 *  instead of collapsing everything unfamiliar into a "Misc" pile. */
export function bucketForCategory(raw: string | null | undefined): CategoryBucket | null {
  if (!raw || !raw.trim()) return null;
  const norm = normalise(raw);
  // Guard against junk categories the catalog occasionally emits — the SHARED
  // vocabulary, so this and the matchmaker's own guard cannot drift apart. (The
  // test is whole-string anchored in there: an unanchored `n/a` prefix once
  // matched ANYTHING starting with "na", and "nail polish" and "napkins"
  // silently lost their bucket.)
  if (isJunkCategory(norm)) return null;
  for (const { match, bucket } of RULES) {
    if (match.test(norm)) return bucket;
  }
  return { key: `cat:${norm}`, name: titleCase(norm) };
}
