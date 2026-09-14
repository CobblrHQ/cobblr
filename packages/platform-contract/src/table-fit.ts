// What fits this table: the one rule the scan router and the no-AI move plan
// share.
//
// The scan matchmaker's deterministic floor (the keyword scorer under the
// model) is the workspace's only vocabulary of what belongs where: a table's
// noun, the words its bundle declares (a Spice Rack says "seasoning", "herb",
// "paprika"), its category axis and its choices. The no-AI move plan used to
// match a record to a destination by the literal word alone ("spices" in the
// name or category), so a Seasoning Blend sat in "say nothing about spices"
// while the scanner would have filed it under Spices (the owner, 2026-09-13,
// #2976). Both now read the same evidence from the same function; the module
// that owns scan routing re-exports these names, and core-ai imports them
// here, across the module boundary neither may cross directly.
//
// Moved verbatim from modules/core-scan/src/services/matchmaker.ts; the scan
// floor's verdicts (matchmaker-heuristic.test.ts, keyword-floor-says-why) are
// unchanged by construction. What is new sits AFTER the scorer: `nameHits`
// on the evidence, and `rankFits`, the ordering both callers use.
// Buildless subpath: no runtime import of a sibling.

/** What is being fitted: the scanner's perception, or a record's own words. */
export interface FitItem {
  name: string;
  manufacturer?: string | null;
  category?: string | null;
  description?: string | null;
  /** Provenance / reasoning notes; often product detail the name lacks. */
  notes?: string | null;
  /** A lookup's metadata blob (weights, pack sizes, colours) or a record's
   *  own field values: extraction fodder, weaker than the name. */
  metadata?: Record<string, unknown> | null;
}

/** One field of a table the scorer can read a value for. */
export interface FitField {
  name: string;
  label: string;
  choices?: string[];
}

/** A table as the fit rule sees it. The scan menu's entry EXTENDS this (it
 *  adds module, instance, kind and the routing flags), so the plan's
 *  assembled tables are checked against the same fields the scan floor reads. */
export interface FitTable {
  /** Human noun for one of them ("yarn", "spice", "part"). */
  noun: string;
  /** Display label ("Spices", "Groceries"). */
  label: string;
  fields: FitField[];
  /** Domain terms the bundle declares for this table. */
  scan_keywords?: string[];
  /** The grouping axis: the field declaring `field_role: "category"`, with
   *  the values it already holds. */
  category_field?: { name: string; label: string; values: string[] };
  /** The module's designated catch-all: the least specific table there is. */
  is_fallback?: boolean;
}

/** What the lexical scorer concluded about one (item, table) pair. `plausible`
 *  is the ROUTING verdict: real table-evidence (noun / head-noun / ≥2 keywords),
 *  the bar both the heuristic and the post-AI corroboration gate use. */
export interface LexicalEvidence {
  score: number;
  plausible: boolean;
  keywordHits: number;
  /** Real "this item IS that thing" evidence: the table's noun matched the
   *  name, a keyword/choice hit the head noun, or a phrase keyword appeared in
   *  the name. Distinguishes a named route from one held up only by ≥2
   *  corroborating keyword grazes. */
  strong: boolean;
  /** The table's noun (not a generic one) appears somewhere in the item's
   *  text: the name, the category, the description or the catalog blob. Not
   *  a route on its own, but a textual tie a model's pick can rest on. */
  nounHit: boolean;
  /** The table's own words (its noun, its declared keywords) found at the
   *  HEAD of the item's name: the head noun, or the word right before it
   *  ("… Garlic Seasoning BLEND" is a seasoning; "Lemon Zinger herbal tea"
   *  is not a lemon). What the thing is CALLED naming the table is the
   *  evidence the no-AI plan needs; a word earlier in the name, or a graze
   *  in a catalog blob, is not. */
  nameHits: string[];
  /** The table's own word IS the item's head noun ("…Garlic Seasoning
   *  Blend" heads "seasoning", and the Spice Rack declares it), or a
   *  declared phrase is in the name: what the thing is CALLED. Ahead of a
   *  word beside the head ("garlic", a flavour) and of the category. */
  headNamed: boolean;
  /** The lookup's CATEGORY names this table: its head noun is the table's
   *  noun, its label, or one of its declared words ("Groceries" for the
   *  Groceries table, "Condiments" for a table that declares condiment).
   *  The strongest statement a catalog makes about what kind of thing this
   *  is, and the one a keyword on the name may not overrule. */
  categoryNames: boolean;
  fields: Record<string, string | number | boolean>;
}

/** Build the per-item lexical scorer heuristicMatch routes with — exposed as a
 *  factory so runMatchmaker can CORROBORATE an AI pick against the same
 *  deterministic evidence (one bar, two callers). */
/** Nouns that describe a container or a count, not a kind of thing. A table
 *  whose item noun is one of these (Lego "set", a generic "item") must carry
 *  scan_keywords to be routable; the noun alone would claim every "sheet set"
 *  and every "3-piece". Stemmed, lowercase. */
export const GENERIC_NOUNS = new Set([
  "set", "item", "thing", "unit", "piece", "pack", "record", "entry", "object", "product",
  // A word that says how something is put together, not what it is: a
  // seasoning blend, a coffee blend, a trail mix, a repair kit, a value
  // bundle. A yarn table's fibre choice "Blend" claimed two seasonings
  // because their names ended in it (#3003).
  "blend", "mix", "kit", "bundle", "combo", "assortment", "variety", "collection",
]);

export function makeLexicalScorer(item: FitItem): {
  hay: string;
  scoreEntry: (entry: FitTable) => LexicalEvidence;
} {
  const hay = `${item.name ?? ""} ${item.description ?? ""} ${item.category ?? ""} ${item.notes ?? ""} ${
    item.metadata ? JSON.stringify(item.metadata) : ""
  }`
    .toLowerCase()
    // "a BAG of screws" / "3 BOXES of nails": the container word describes the
    // packaging, not the item — drop it so it can't hit an unrelated table's
    // choice vocabulary ("bag" is a Wardrobe accessory choice; screws aren't).
    .replace(/\b(\d+\s*)?(skeins?|balls?|spools?|rolls?|packs?|boxe?s?|bottles?|cans?|bags?|tubes?|jars?|cases?)\s+of\s+/g, "");
  // Light stemming so plural/singular pairs match ("Netflix subscription" hits
  // a "subscriptions" table; "screws" hits a "screw" choice): compare tokens by
  // their stem — trailing -ies→y, -es, -s stripped (conservative; ≥4 chars so
  // "gas"/"its" survive).
  const stem = (w: string): string => {
    if (w.length >= 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
    if (w.length >= 5 && w.endsWith("es")) return w.slice(0, -2);
    if (w.length >= 4 && w.endsWith("s")) return w.slice(0, -1);
    return w;
  };
  const tokens = new Set(hay.split(/[^a-z0-9]+/).filter((t) => t.length >= 3).map(stem));
  // The short VALUES in the metadata, keys left out: what a catalog states as
  // an attribute, not the name of the slot it states it in, and not a
  // paragraph of marketing or ingredients (anything past 48 characters).
  const attributeStems = new Set<string>();
  // A taxonomy list is not an attribute either: a food catalog tags every
  // product with dozens of ancestors ("en:plant-based-foods-and-beverages" on
  // a tube of crisps, "en:dairy" in a spread's ingredient tree), so tag,
  // hierarchy, and keyword lists and any list past eight entries stay out.
  const TAXONOMY_KEY = /(_tags|_hierarchy|_keywords|^_?keywords)$/;
  const walkValues = (v: unknown, depth: number): void => {
    if (depth > 4 || v == null) return;
    if (typeof v === "string") {
      if (v.length <= 48) for (const t of v.toLowerCase().split(/[^a-z0-9]+/)) if (t.length >= 3) attributeStems.add(stem(t));
    } else if (Array.isArray(v)) {
      if (v.length <= 8) for (const x of v) walkValues(x, depth + 1);
    } else if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!TAXONOMY_KEY.test(k)) walkValues(x, depth + 1);
    }
  };
  walkValues(item.metadata, 0);
  // Single words match TOKENS, never raw substrings: `hay.includes("car")` hit
  // "old CARds", "make" hit "MAKing it easy", "vin" hit "without haVINg" — and
  // two such grazes in one marketing description made a storage tote "plausible"
  // for a Vehicles table (keywords car/make/vin). A compound token still counts
  // when the keyword is a whole morpheme of it ("screw" in "screwdriver", "van"
  // in "minivan"): prefix/suffix with ≥3 chars of remainder, so "car|ds" can
  // never ride again. Multi-word phrases keep the verbatim substring match
  // ("license plate" appearing as-is is real evidence).
  const tokenList = [...tokens];
  const wordHit = (w: string): boolean => {
    const sw = stem(w);
    if (tokens.has(sw)) return true;
    return tokenList.some((t) => (t.startsWith(sw) || t.endsWith(sw)) && t.length - sw.length >= 3);
  };
  const hasWord = (phrase: string): boolean => {
    const p = phrase.toLowerCase();
    if (/\s/.test(p.trim())) return p.length >= 3 && hay.includes(p);
    return p.split(/[^a-z0-9]+/).some((w) => w.length >= 3 && wordHit(w));
  };
  // The capture's HEAD NOUN — the last content token of the NAME after
  // stripping trailing size/pack tails ("Fieldcrest Bath Towels 4 Pack" →
  // "towel"). A keyword matching the head noun is what the item IS, not an
  // incidental word ("Lcd Ribbon Cable" heads "cable", so Yarn's "ribbon"
  // keyword stays weak — the original false-positive guard holds).
  //
  // A prepositional tail names the item's TARGET, not the item — "stainless
  // screws FOR THE FRAME" is screws, not a frame; "replacement belt FOR Dyson
  // V8" is a belt. Cut at the first for/with/fits so the head noun is the thing
  // itself; a name that IS a prepositional phrase falls back to the full name.
  const rawName = (item.name ?? "").toLowerCase();
  const nameCore = rawName.split(/\b(?:for|with|fits)\b/)[0]!.trim() || rawName;
  const TAIL = new Set(["pack", "packs", "count", "ct", "pcs", "pc", "set", "sets", "oz", "ml", "lb", "lbs", "kg", "inch", "in", "ft", "each", "roll", "rolls"]);
  // Retail names end with the COLOR ("…Rocker Switch White", "…Soft White") —
  // a color is a property, never what the item IS, and treating it as the head
  // noun let a filament table's color choice "White" claim a light switch.
  const COLOR_TAIL = new Set(["white", "black", "red", "blue", "green", "yellow", "gray", "grey", "silver", "gold", "brown", "beige", "ivory", "clear", "orange", "purple", "pink", "tan", "almond"]);
  const nameTokens = nameCore.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !/^\d+$/.test(t));
  // Pop size/pack TAIL tokens, trailing colors, anything digit-bearing
  // ("20lb", "4pk"), and a GENERIC noun ("…Seasoning Blend", "…Trail Mix",
  // "…Repair Kit": the thing is the seasoning, the trail, the repair, not the
  // way it is packaged or put together) — the head noun is the thing itself,
  // never its packaging arithmetic, its finish, or its assembly.
  while (
    nameTokens.length > 1 &&
    (TAIL.has(nameTokens[nameTokens.length - 1]!) ||
      COLOR_TAIL.has(nameTokens[nameTokens.length - 1]!) ||
      GENERIC_NOUNS.has(stem(nameTokens[nameTokens.length - 1]!)) ||
      /\d/.test(nameTokens[nameTokens.length - 1]!))
  ) nameTokens.pop();
  // A color can never BE the head noun (a name that is only color words has no
  // head): "what the item is" is never a color, so a color choice must not gain
  // routing strength even when it survives the pop above.
  const headCandidate = nameTokens.length ? nameTokens[nameTokens.length - 1]! : "";
  const headStem = headCandidate && !COLOR_TAIL.has(headCandidate) ? stem(headCandidate) : "";
  const hitsHead = (phrase: string): boolean =>
    !!headStem && phrase.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 3 && stem(w) === headStem);
  // The head and its modifier: "seasoning blend", "sesame seasoning blend"
  // both say seasoning at the head. A phrase counts when it is in the name.
  const nearHeadStems = new Set(nameTokens.slice(-2).filter((t) => !COLOR_TAIL.has(t)).map(stem));
  const hitsNearHead = (phrase: string): boolean => {
    const p = phrase.toLowerCase();
    if (/\s/.test(p.trim())) return p.length >= 3 && nameCore.includes(p);
    return p.split(/[^a-z0-9]+/).some((w) => w.length >= 3 && nearHeadStems.has(stem(w)));
  };
  // ROUTING strength must come from the NAME — what the item is called — not
  // from a word buried in the metadata blob (raw catalog attributes, photo
  // observations, marketing text). A bundle whose noun is a generic word
  // ("set", "type") matched a light switch because "Type:" and "set" appear in
  // virtually every retail payload; hay-wide matches still SCORE (and count as
  // keyword corroboration), but only name evidence makes a table strong.
  const nameStems = new Set(nameCore.split(/[^a-z0-9]+/).filter((w) => w.length >= 3).map(stem));
  // The CATEGORY on its own. It is not part of the metadata blob and must not be
  // graded like it: the blob is marketing text and catalog attributes, while the
  // category is a structured statement of what KIND of thing this is, from the
  // lookup that identified it. A title is often silent about its kind — a book's
  // title is the one place the word "book" never appears — so a table whose noun
  // IS the category is the strongest signal there is for that item.
  const catStems = new Set(
    (item.category ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3).map(stem),
  );
  const categoryIs = (phrase: string): boolean => {
    const p = phrase.toLowerCase();
    if (/\s/.test(p.trim())) return (item.category ?? "").toLowerCase().includes(p);
    return p.split(/[^a-z0-9]+/).some((w) => w.length >= 3 && catStems.has(stem(w)));
  };
  // The category's HEAD noun is what kind of thing the lookup said this is:
  // "Sweetened beverages" is a beverage. A table whose keyword IS that noun
  // is claiming the kind, the same claim a keyword on the name's head noun
  // makes, so it counts as strong. A keyword grazing the category's modifier
  // ("sweetened") stays weak. The dashboard's sample cola carried exactly
  // this category and no other evidence, and filed into plain Inventory
  // while Groceries, which declared the word, sat empty (2026-09-12).
  const catTokens = (item.category ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const catHeadStem = catTokens.length ? stem(catTokens[catTokens.length - 1]!) : "";
  const hitsCategoryHead = (phrase: string): boolean =>
    !!catHeadStem && phrase.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 3 && stem(w) === catHeadStem);
  // The category's head noun IS a table's own name. "Groceries" from the food
  // catalog names the Groceries table whatever its item noun is (the generic
  // "item", which scores nothing on purpose), the way "Books" names a
  // Bookshelf. A generic word cannot name a table this way either.
  const categoryNamesLabel = (label: string): boolean =>
    !!catHeadStem && !GENERIC_NOUNS.has(catHeadStem) && hitsCategoryHead(label);
  const nameHas = (phrase: string): boolean => {
    const p = phrase.toLowerCase();
    if (/\s/.test(p.trim())) return nameCore.includes(p);
    return p.split(/[^a-z0-9]+/).some((w) => w.length >= 3 && nameStems.has(stem(w)));
  };

  const scoreEntry = (entry: FitTable): LexicalEvidence => {
    let score = 0;
    // `strong` = a real "this item IS that thing" signal: the table's NOUN
    // matched, a keyword or CHOICE matched the capture's HEAD NOUN. A match on
    // only a secondary scan_keyword is weak and incidental ("ribbon" in "Lcd
    // Ribbon Cable" hitting Yarn's ribbon-yarn keyword) — so it takes the noun,
    // a head-noun hit, OR ≥2 corroborating keywords to suggest a table.
    //
    // A field-CHOICE match is a FIELD-FILL signal, NOT table evidence, unless
    // the choice IS the head noun. This scorer routed a "Square D Circuit
    // Breaker" to a tooling table (its end_type choices list "Square") and a
    // "Smart Box" device box to a wardrobe ("Smart casual") — a brand or
    // marketing word grazing an unrelated table's choice vocabulary was treated
    // as proof the item belonged there, and the honest fallback+category could
    // never outscore it. ("…Nike Hoodie" hitting a garment_type choice "Hoodie"
    // stays strong: the choice names what the item IS.)
    let strong = false;
    let nounHit = false;
    let keywordHits = 0;
    let headNamed = false;
    let categoryNames = false;
    const nameHits: string[] = [];
    const fields: Record<string, string | number | boolean> = {};
    // The table's OWN noun/keywords route it (a "yarn" table for a "...yarn"),
    // but they must NOT leak into field-value extraction — otherwise a vendor
    // choice "Local yarn shop" gets picked just because the capture says "yarn".
    const nounWords = new Set(
      [entry.noun, ...(entry.scan_keywords ?? [])]
        .flatMap((s) => s.toLowerCase().split(/[^a-z0-9]+/))
        .filter((w) => w.length >= 3)
        .map(stem),
    );
    // A table's noun routes only when the noun says what the thing IS. "set",
    // "item", "piece", "unit" say nothing: a "3 Piece Twin Sheet Set" was
    // offered a home in the Lego Sets table because that table's noun is
    // "set" and the capture's head noun was "set" (2026-09-02). A generic noun
    // scores nothing and is never strong; such a table routes by its keywords.
    if (entry.noun && hasWord(entry.noun) && !GENERIC_NOUNS.has(stem(entry.noun.toLowerCase()))) {
      score += 2;
      nounHit = true;
      // The NAME saying the noun is the classic signal. The CATEGORY saying it
      // is just as strong a statement and covers the case the name cannot: an
      // ISBN-identified textbook is categorised "Books" while its title is
      // about refrigeration, and it filed into the catch-all next to a
      // Bookshelf table sitting right there (reported 2026-09-02).
      //
      // Still gated by GENERIC_NOUNS above, so a category of "Items" cannot
      // route to a table whose noun is "item" — a generic noun says nothing
      // about what a thing IS, whichever field it matched.
      if (nameHas(entry.noun) || categoryIs(entry.noun)) strong = true;
      if (hitsHead(entry.noun)) headNamed = true;
      if (hitsCategoryHead(entry.noun)) categoryNames = true;
      if (hitsNearHead(entry.noun)) nameHits.push(entry.noun);
    }
    // The category naming the TABLE ITSELF, by its label: the catalog saying
    // which table this is. Real evidence (strong, so the table is plausible
    // on it alone) but no score: the ORDER (orderFits) is where it counts,
    // ahead of a keyword or a choice grazing the name and behind a table
    // the name calls by its word, so a narrower table the name names
    // (Spices for a seasoning) is not outscored by the aisle it sits in.
    if (entry.label && categoryNamesLabel(entry.label)) {
      strong = true;
      categoryNames = true;
    }
    // Multi-word keywords match as FULL PHRASES only — "paper towel" must
    // not claim every "towel" via its words (bath towels are linens, not
    // supplies). Single words keep stemmed token matching.
    const kwHit = (term: string): boolean =>
      /\s/.test(term.trim()) ? hay.includes(term.toLowerCase()) : hasWord(term);
    for (const term of entry.scan_keywords ?? []) {
      if (term && kwHit(term)) {
        score += 2;
        keywordHits += 1;
        // A keyword that IS the capture's head noun ("…Bath Towels" → keyword
        // "towel") identifies the thing itself → strong on its own. So does a
        // MULTI-WORD keyword appearing verbatim IN THE NAME: "light bulb" there
        // is naming, not grazing ("…Soft White 4-pack" heads to the color, so
        // the head-noun test alone misses it). The same phrase found only in
        // the metadata blob stays a corroborating hit, not a route.
        // (A keyword that merely LEADS the name is not naming it: "Apple iPhone"
        // led with a grocery keyword and a Home app offered it the pantry, so a
        // table whose noun is generic routes on TWO corroborating keywords, the
        // way a real Lego capture carries "lego" + "building set" from its
        // catalog category.)
        if (hitsHead(term) || hitsCategoryHead(term) || (/\s/.test(term.trim()) && nameHas(term))) strong = true;
        if (hitsHead(term) || (/\s/.test(term.trim()) && nameHas(term))) headNamed = true;
        if (hitsCategoryHead(term)) categoryNames = true;
        if (hitsNearHead(term)) nameHits.push(term);
      }
    }
    // A choice matches only on a NON-noun capture token (whole-phrase hits the
    // noun-word guard too: every matched word must be a non-noun word).
    // The table's CATEGORY AXIS says what kind of thing this is, so it fills
    // only from the name and the catalog category, never from the metadata
    // blob: a jar of arrabbiata and a bag of tortilla chips were both filed
    // as "Meat" because that word sat somewhere in their marketing text, and a
    // wrong category dates the food wrong (2026-09-02). Other choice fields
    // (a fiber, a hook size) keep reading the blob, where the attributes live.
    const nameCatStems = new Set([
      ...nameStems,
      ...(item.category ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3).map(stem),
    ]);
    const axisHit = (ch: string): boolean => {
      const words = ch.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3).map(stem);
      return words.some((w) => nameCatStems.has(w) && !nounWords.has(w));
    };
    // Every other choice field reads the item's ATTRIBUTES: the name, the
    // category, and the short values in the catalog metadata ("material":
    // "Acrylic", "weight": "Worsted"). Never a JSON key, and never a long
    // text. A tortilla chip and a jar of pasta sauce were both filed as "Meat"
    // because the catalog blob carries a flag named is_red_meat_product, and a
    // chocolate spread became "Dairy" off its ingredient list (2026-09-02).
    const attrTokens = new Set([...nameCatStems, ...attributeStems]);
    const choiceHitAttr = (ch: string): boolean => {
      const words = ch.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3).map(stem);
      return words.some((w) => attrTokens.has(w) && !nounWords.has(w));
    };
    for (const f of entry.fields) {
      if (hasWord(f.name) || hasWord(f.label)) score += 1;
      if (f.choices) {
        for (const ch of f.choices) {
          if (ch && (f.name === entry.category_field?.name ? axisHit(ch) : choiceHitAttr(ch))) {
            score += 1; // a fill hint, no longer a 3-point routing vote
            // The choice names the thing itself ("…Nike Hoodie" and a
            // garment_type "Hoodie"). Not when the word is a generic one: a
            // fibre choice "Blend" at the head of "…Seasoning Blend" says how
            // the seasoning is made, not that it is a yarn (#3003).
            if (hitsHead(ch) && !GENERIC_NOUNS.has(headStem)) {
              strong = true;
              headNamed = true;
            }
            if (!(f.name in fields)) fields[f.name] = ch; // extract the matched choice
          }
        }
      }
    }
    return { score, keywordHits, fields, strong, nounHit, nameHits, headNamed, categoryNames, plausible: strong || keywordHits >= 2 };
  };
  return { hay, scoreEntry };
}


/** One table's fit for one item, ranked. */
export interface RankedFit<T extends FitTable = FitTable> {
  table: T;
  evidence: LexicalEvidence;
}

/** Which tables an item fits, best first: the ordering both the scan floor
 *  and the no-AI plan use, so "specific beats generic" is one rule.
 *
 *  `gate` is what counts as a fit at all:
 *  - "plausible": the scan floor's bar (the noun, a head-noun hit, or two
 *    corroborating keywords), which keeps a lone word in a catalog blob from
 *    force-fitting a capture into the wrong bundle.
 *  - "named": what the plan asks of a record the PERSON has already put in
 *    front of the named destinations: the table's own vocabulary in the
 *    record's NAME is enough ("… Garlic Seasoning Blend" says seasoning, and
 *    the Spice Rack says seasoning), and anything plausible counts too.
 *
 *  Order: score, then real evidence (strong) before corroboration, then the
 *  NARROWER table (fewer declared words: Spices over Groceries; a specific
 *  table says less and means more), and a module's catch-all last. */
export function rankFits<T extends FitTable>(item: FitItem, tables: T[], gate: "plausible" | "named" = "plausible"): RankedFit<T>[] {
  const { scoreEntry } = makeLexicalScorer(item);
  const fits = tables
    .map((table) => ({ table, evidence: scoreEntry(table) }))
    .filter(({ evidence }) => evidence.plausible || (gate === "named" && evidence.nameHits.length > 0));
  return fits.filter((f) => !contradictedByCategory(f, fits)).sort(orderFits);
}

/** How many words a table declares: a specific table says less and means more. */
export function tableBreadth(t: FitTable): number {
  return (t.scan_keywords?.length ?? 0) + t.fields.reduce((n, f) => n + (f.choices?.length ?? 0), 0);
}

/** The table's own word is what the item is CALLED: its noun, or a declared
 *  word at the head of the name. The first thing the order reads. */
export function nameNames(e: LexicalEvidence): boolean {
  return e.nameHits.length > 0;
}

/** The one ORDER both the scan floor and the no-AI move plan rank by, so
 *  "what outranks what" cannot drift between them (#3003):
 *
 *  1. a table whose word IS the item's head noun ("…Garlic Seasoning Blend"
 *     heads "seasoning") before one whose word sits beside it ("garlic");
 *  2. then a table the NAME calls by a word at or beside its head before
 *     one it does not;
 *  3. then a table the lookup's CATEGORY names ("Groceries" from the food
 *     catalog names the Groceries table) before one it does not, so what the
 *     catalog said the thing is outranks what its name merely grazed (a
 *     fibre choice, a pair of incidental keywords);
 *  4. then the score, then real evidence before corroboration, a module's
 *     catch-all last, and the NARROWER table first (Spices over Groceries
 *     for a seasoning both declare: a specific table says less and means
 *     more). */
export function orderFits<T extends FitTable>(a: RankedFit<T>, b: RankedFit<T>): number {
  return (
    Number(b.evidence.headNamed) - Number(a.evidence.headNamed) ||
    Number(nameNames(b.evidence)) - Number(nameNames(a.evidence)) ||
    Number(b.evidence.categoryNames) - Number(a.evidence.categoryNames) ||
    b.evidence.score - a.evidence.score ||
    Number(b.evidence.strong) - Number(a.evidence.strong) ||
    // The more of the name a table's word covers, the better it names it:
    // "paper towels" verbatim beats "towel" alone for a roll of paper towels.
    longestNameHit(b.evidence) - longestNameHit(a.evidence) ||
    Number(!!a.table.is_fallback) - Number(!!b.table.is_fallback) ||
    tableBreadth(a.table) - tableBreadth(b.table)
  );
}

/** Words in the longest table word found at the head of the name. */
function longestNameHit(e: LexicalEvidence): number {
  return e.nameHits.reduce((n, h) => Math.max(n, h.trim().split(/\s+/).length), 0);
}

/** A route the category contradicts: some table is named by the category,
 *  and this one is neither that table nor one the name calls by its word
 *  (only a keyword pair or a field choice grazed it). Food is not fibre: two
 *  seasonings were offered Yarn on the fibre choice "Blend" while their
 *  catalog said food (#3003). Such a fit is not a second opinion, it is a
 *  wrong one, and the caller drops it. */
export function contradictedByCategory<T extends FitTable>(fit: RankedFit<T>, all: readonly RankedFit<T>[]): boolean {
  if (fit.evidence.categoryNames || nameNames(fit.evidence) || fit.evidence.nounHit) return false;
  return all.some((o) => o !== fit && o.evidence.categoryNames);
}

/** The table an item fits best, or null when it fits none. */
export function bestFit<T extends FitTable>(item: FitItem, tables: T[], gate: "plausible" | "named" = "plausible"): RankedFit<T> | null {
  return rankFits(item, tables, gate)[0] ?? null;
}
