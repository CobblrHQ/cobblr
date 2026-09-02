// How long a grocery keeps, from what it is - so a date is never a prompt.
//
// Every pantry app dies in week two on the same chore: a person is asked for a
// best-before date on every item they bring home, and stops. The homepage
// promises "what's about to expire" and the Groceries bundle carries the
// fields (expires_on, shelf_life_days, food_category), but nothing filled
// them: a date existed only if someone typed it. This is the table that fills
// it, the same shape as storage-requirement.ts and category-buckets.ts: ordered
// regex rules over the catalog category and the product name, specific before
// general, first hit wins, NULL when nothing fires.
//
// The numbers are typical unopened-keeps for a home fridge or pantry, rounded
// down: a guess that runs a little early costs a look in the fridge; one that
// runs late costs the food. Once the item is opened or discarded, the
// inventory module's shelf-life learning replaces these with what THIS
// household actually observed (shelf-life-learning.ts), so the table only
// ever supplies the first date.
//
// NULL IS THE IMPORTANT RETURN. "Groceries" implies nothing; a light bulb
// bought at the same store implies nothing. Asserting a date for those would
// put a false alarm in someone's morning list, and every consumer must treat
// null as "leave the date blank", never as "assume something".

export interface ShelfLife {
  /** Days from acquisition (the receipt date, else today) to the expiry. */
  shelf_life_days: number;
  /** Days once opened, when that is materially shorter. */
  shelf_life_opened_days?: number;
  /** Days past the date the food is still fine; the sweeper's grace. */
  grace_days?: number;
}

// Names that settle it on their own, tried BEFORE any category. A retailer's
// merged aisle ("Dips & Spreads", "Meals & Soups") puts a jar of chocolate
// spread next to fresh hummus and a can of soup next to a rotisserie chicken;
// the category then says the wrong thing for half its members. Found walking
// staging with real barcodes (2026-09-02): Nutella was given the hummus date.
const NAME_FIRST: Array<{ match: RegExp; life: ShelfLife }> = [
  { match: /\bnutella\b|chocolate spread|hazelnut spread|\bpeanut butter\b|\bnut butters?\b|\bjams?\b|\bmarmalade\b|\bhoney\b|\btahini\b/, life: { shelf_life_days: 365, shelf_life_opened_days: 90, grace_days: 90 } },
  { match: /\bhummus\b|\bguacamole\b|\bsalsa\b|\btzatziki\b|fresh dip/, life: { shelf_life_days: 14, shelf_life_opened_days: 5, grace_days: 5 } },
  // A jar of pasta sauce names itself by its recipe; the catalog often gives it
  // no category at all ("Barilla Arrabbiata" arrived with none, 2026-09-02).
  { match: /\barrabbiata\b|\bmarinara\b|\bbolognese\b|\bpesto\b|pasta sauce|tomato sauce|\bpassata\b|\bragu\b/, life: { shelf_life_days: 365, shelf_life_opened_days: 7, grace_days: 60 } },
  { match: /\bcanned\b|\btinned\b|\bcan of\b|condensed|\bbroth\b|\bstock\b|\bsoups?\b|\bchowder\b|\bbaked beans\b|\bravioli\b/, life: { shelf_life_days: 540, shelf_life_opened_days: 5, grace_days: 60 } },
];

const RULES: Array<{ match: RegExp; life: ShelfLife }> = [
  // Frozen before anything the word could also match ("frozen pizza", "ice cream").
  { match: /\bfrozen\b|ice cream|\bgelato\b|\bsorbet\b|frozen dessert|\bglaces?\b|surgel/, life: { shelf_life_days: 180, grace_days: 30 } },
  // Shelf-stable forms outrank their ingredient: canned fish is not fish.
  { match: /\bcanned\b|\btinned\b|\bjarred\b|\bpickled\b|\buht\b|long.?life|shelf.?stable|\bconserves?\b/, life: { shelf_life_days: 540, shelf_life_opened_days: 5, grace_days: 60 } },
  { match: /\bpowder\b|\bdried\b|dehydrated|freeze.?dried|\bjerky\b/, life: { shelf_life_days: 365, grace_days: 60 } },
  // Soup and ready meals are shelf-stable by aisle ("Meals & Soups" holds cans
  // and pouches); the fresh-chicken rule below would otherwise read the name.
  { match: /\bsoups?\b|\bbroth\b|\bstock cubes?\b|\bbouillon\b|\bready meals?\b|\bmeal kits?\b/, life: { shelf_life_days: 365, shelf_life_opened_days: 3, grace_days: 60 } },
  // The short fresh things, most specific first.
  { match: /\bberr(y|ies)\b|raspberr|strawberr|blueberr|blackberr/, life: { shelf_life_days: 4, grace_days: 1 } },
  { match: /\bsalad\b|\blettuce\b|\bgreens\b|\bspinach\b|\barugula\b|\brocket\b|\bherbs?\b|\bcilantro\b|\bparsley\b|\bbasil\b|\bkale\b/, life: { shelf_life_days: 5, grace_days: 1 } },
  { match: /\bmushrooms?\b|\bavocados?\b|\bbananas?\b|\bcherr(y|ies)\b|\bgrapes\b|\bpeach|\bnectarine|\bplums?\b|\bmango|\bpapaya/, life: { shelf_life_days: 5, grace_days: 2 } },
  { match: /\bfresh (meat|chicken|beef|pork|lamb|fish|seafood)\b|\bground (beef|meat|turkey|pork)\b|\bmince\b|\bchicken\b|\bturkey\b|\bbeef\b|\bpork\b|\blamb\b|\bsausages?\b|\bfish\b|\bsalmon\b|\bshrimp\b|\bprawns?\b|\bseafood\b|\bpoultry\b/, life: { shelf_life_days: 2, grace_days: 1 } },
  { match: /\bdeli\b|charcuterie|\bham\b|\bsalami\b|\bprosciutto\b|sliced (turkey|chicken|meat)|\bcold cuts?\b/, life: { shelf_life_days: 5, shelf_life_opened_days: 3, grace_days: 2 } },
  { match: /\bmilk\b|\bcream\b|creme fraiche|\bcr[eè]me\b|half.?and.?half|\bkefir\b|\bbuttermilk\b/, life: { shelf_life_days: 10, shelf_life_opened_days: 7, grace_days: 2 } },
  { match: /yogh?urt|\bskyr\b|cottage cheese|\bricotta\b|\bhummus\b|\bdips?\b|\bguacamole\b|\bsalsa\b|fresh pasta|\btofu\b|\btempeh\b/, life: { shelf_life_days: 14, shelf_life_opened_days: 5, grace_days: 5 } },
  { match: /\bcheese\b|\bcheddar\b|\bmozzarella\b|\bparmesan\b|\bgouda\b|\bbrie\b|\bfeta\b|\bcamembert\b/, life: { shelf_life_days: 30, shelf_life_opened_days: 10, grace_days: 14 } },
  { match: /\beggs?\b/, life: { shelf_life_days: 28, grace_days: 14 } },
  { match: /\bbutter\b|\bmargarine\b/, life: { shelf_life_days: 60, shelf_life_opened_days: 30, grace_days: 30 } },
  { match: /\bbread\b|\bbagels?\b|\bbuns?\b|\brolls?\b|\btortillas?\b|\bpita\b|\bnaan\b|\bcroissants?\b|\bmuffins?\b|\bbaguette\b|\bbakery\b|\bpastr(y|ies)\b|\bcakes?\b|\bdonuts?\b|\bdoughnuts?\b/, life: { shelf_life_days: 5, grace_days: 2 } },
  // Sturdier produce.
  { match: /\bapples?\b|\bcitrus\b|\boranges?\b|\blemons?\b|\blimes?\b|\bgrapefruit\b|\bcarrots?\b|\bcabbage\b|\bbeets?\b|\bcelery\b|\bbroccoli\b|\bcauliflower\b|\bpeppers?\b|\bcucumbers?\b|\bzucchini\b|\bcourgette/, life: { shelf_life_days: 14, grace_days: 5 } },
  { match: /\bpotato|\bonions?\b|\bgarlic\b|\bsquash\b|\bpumpkin\b|\bsweet potato|\byams?\b|\bginger\b/, life: { shelf_life_days: 30, grace_days: 14 } },
  { match: /\btomato|\bfruit\b|\bvegetables?\b|\bproduce\b|\bveg\b|\blegumes? fra/, life: { shelf_life_days: 7, grace_days: 3 } },
  // Chilled drinks and opened-life things.
  { match: /\bjuice\b|\bsmoothie\b|\blemonade\b|\biced tea\b|\bkombucha\b/, life: { shelf_life_days: 21, shelf_life_opened_days: 7, grace_days: 5 } },
  { match: /\bcondiments?\b|\bketchup\b|\bmustard\b|\bmayo(nnaise)?\b|\bdressing\b|\bsauces?\b|\bsoy sauce\b|\bsriracha\b|\brelish\b|\bjams?\b|\bjell(y|ies)\b|\bmarmalade\b|\bpreserves\b|\bsyrup\b|\bhoney\b|\bpeanut butter\b|\bnut butters?\b|\btahini\b/, life: { shelf_life_days: 365, shelf_life_opened_days: 90, grace_days: 90 } },
  // Pantry staples.
  { match: /\bspices?\b|\bseasoning\b|\bsalt\b|\bpepper\b|\bsugar\b|\bflour\b|\brice\b|\bpasta\b|\bnoodles?\b|\bcereal|\boats?\b|\boatmeal\b|\bgranola\b|\bcrackers?\b|\bbeans\b|\blentils\b|\bquinoa\b|\bcouscous\b|\bbaking\b|\bcocoa\b|\bcoffee\b|\btea\b|\bteas\b|\bnuts?\b|\bseeds?\b|\bchips\b|\bcrisps\b|\bpretzels?\b|\bpopcorn\b|\bsnacks?\b|\bcookies?\b|\bbiscuits?\b|\bcandy\b|\bchocolate\b|\bcracker\b|\bgranola bars?\b|\bbars?\b/, life: { shelf_life_days: 270, grace_days: 90 } },
  { match: /\bwater\b|\bsoda\b|\bsoft drinks?\b|\bcola\b|\bbeer\b|\bwine\b|\bbeverages?\b|\bdrinks?\b|\benergy drink\b|\bsparkling\b/, life: { shelf_life_days: 365, grace_days: 90 } },
  // The bundle's own coarse categories, last: they say less than any word above.
  { match: /^produce$/, life: { shelf_life_days: 7, grace_days: 3 } },
  { match: /^dairy$/, life: { shelf_life_days: 14, shelf_life_opened_days: 7, grace_days: 5 } },
  { match: /^meat$/, life: { shelf_life_days: 2, grace_days: 1 } },
  { match: /^bakery$/, life: { shelf_life_days: 5, grace_days: 2 } },
  { match: /^frozen$/, life: { shelf_life_days: 180, grace_days: 30 } },
  { match: /^canned$/, life: { shelf_life_days: 540, shelf_life_opened_days: 5, grace_days: 60 } },
  { match: /^dry goods$/, life: { shelf_life_days: 365, grace_days: 90 } },
  { match: /^condiments$/, life: { shelf_life_days: 365, shelf_life_opened_days: 90, grace_days: 90 } },
  { match: /^(meals?|soups?|meals? & soups?|meals? and soups?|ready meals?)$/, life: { shelf_life_days: 365, shelf_life_opened_days: 3, grace_days: 60 } },
  { match: /^beverages$/, life: { shelf_life_days: 365, grace_days: 90 } },
  { match: /^snacks$/, life: { shelf_life_days: 120, grace_days: 60 } },
];

/** The taxonomy tail, lowercased ("Plant-based foods > Teas" reduces to "teas"),
 *  the normalisation category-buckets and storage-requirement apply. */
function tail(s: string): string {
  const parts = s.split(/\s*[>/]\s*/).filter(Boolean);
  return (parts[parts.length - 1] ?? s).trim().toLowerCase();
}

/**
 * The shelf life a category and a name imply, or null when nothing does.
 *
 * The CATEGORY is tried first, because a catalog category is a curated fact
 * ("Dairy > Yogurt") while a product name is marketing ("Morning Sunshine").
 * Both go through the same rules, so "Frozen peas" from a receipt line with no
 * category still lands.
 */
export function shelfLifeFor(category: string | null | undefined, name?: string | null): ShelfLife | null {
  if (name) {
    const n = name.toLowerCase();
    for (const r of NAME_FIRST) if (r.match.test(n)) return { ...r.life };
  }
  for (const text of [category, name]) {
    if (!text) continue;
    // The whole path first: its head can carry the signal the tail lacks
    // ("Frozen > Vegetables" is frozen; the tail alone says produce). The
    // coarse `^...$` rules only ever match a bare category, by design.
    const whole = text.toLowerCase().trim();
    for (const r of RULES) if (r.match.test(whole)) return { ...r.life };
    const t = tail(text);
    if (t !== whole) for (const r of RULES) if (r.match.test(t)) return { ...r.life };
  }
  return null;
}

/** `from` (YYYY-MM-DD) plus `days`, in UTC calendar days. */
export function addDays(from: string, days: number): string {
  const t = Date.parse(`${from}T00:00:00Z`);
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The dates to stamp on a new record when none were given: the roled expiry
 * field, plus the bundle's `shelf_life_days` / `shelf_life_opened_days` /
 * `grace_days` when the record already knows those names (so the batches and
 * the sweeper read the same numbers the date came from). Pure; the caller
 * decides where the values land and what the person typed always wins.
 */
export function expiryDefaults(opts: {
  category: string | null | undefined;
  name: string | null | undefined;
  /** The receipt date or acquisition date, YYYY-MM-DD; today when unknown. */
  acquiredOn: string | null | undefined;
  today: string;
  /** The name of the field carrying `field_role: "expiry"` on the target kind. */
  expiryField: string;
}): Record<string, string | number> | null {
  const life = shelfLifeFor(opts.category, opts.name);
  if (!life) return null;
  const from = opts.acquiredOn && /^\d{4}-\d{2}-\d{2}$/.test(opts.acquiredOn) ? opts.acquiredOn : opts.today;
  const out: Record<string, string | number> = {
    [opts.expiryField]: addDays(from, life.shelf_life_days),
    shelf_life_days: life.shelf_life_days,
  };
  if (life.shelf_life_opened_days) out.shelf_life_opened_days = life.shelf_life_opened_days;
  if (life.grace_days) out.grace_days = life.grace_days;
  return out;
}
