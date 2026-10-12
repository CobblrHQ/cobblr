// Whether a field is a fact about the MODEL or about this one UNIT (#6013).
//
// Every Bambu Lab P1P has a 250 × 250 bed: that is the model's. The seller,
// the serial, the day it was bought, its price, its condition, where it is
// kept and what was upgraded on it belong to the one printer in your hands.
// A model fact learned once is true of every unit of that model; a unit fact
// never crosses from one unit to another (the owner, 2026-10-12: two P1Ps
// from different sellers are two printers, not one).
//
// One rule, read by everything that moves a value between records: the
// barcode network (learned-route.ts, #5804) shares only model facts beyond
// the workspace, and the scan inbox fills a model fact into every pending
// row of that model (core-scan model-facts.ts).
//
// A field DECLARES its scope (`fact_scope` in a bundle, module_field_defs.
// fact_scope). Undeclared, it is read from its role, type and name, the
// owner's 2026-10-11 rule for what may leave a workspace: about the product
// only, never a lot, a year made, a serial, a price, a seller, a place, a note,
// a person, a date or a link.

export const FACT_SCOPES = ["model", "instance"] as const;
export type FactScope = (typeof FACT_SCOPES)[number];

export interface ScopedFieldDef {
  name: string;
  type?: string | null;
  field_role?: string | null;
  fact_scope?: string | null;
}

/** The roles a field may carry and still be about the product. Every other
 *  role says something about a unit or about the person (lot, year made,
 *  identifier, expiry, acquired-*, seller, location, assignee, belongs-to,
 *  usage, payment-method, ready-*), and category travels on its own. */
export const PRODUCT_ROLES: ReadonlySet<string> = new Set(["pack", "outer-size"]);

/** The types whose values can be product facts. */
const PRODUCT_TYPES = new Set(["text", "number", "boolean", "measure", "select", "choice", "multiselect", "tags"]);

/** Field names that say the value is about the unit or the person, whatever
 *  role they declare. */
const UNIT_NAME = /note|comment|remark|descr|serial|price|cost|paid|value|seller|vendor|shop|store|bought|purchase|order|receipt|location|where|place|shelf|bin|room|lot|batch|dye|date|year|owner|assignee|email|phone|address|url|link|warranty|condition|rating|review|status|qty|quantity|count|stock/i;

/** The scope a field declares, or null when it declares none. */
export function declaredFactScope(def: Pick<ScopedFieldDef, "fact_scope">): FactScope | null {
  return def.fact_scope === "model" || def.fact_scope === "instance" ? def.fact_scope : null;
}

/** The scope read from a field's role, type and name, for a field that
 *  declares none. */
function derivedFactScope(def: ScopedFieldDef): FactScope {
  const productRole = !!def.field_role && PRODUCT_ROLES.has(def.field_role);
  if (def.field_role && !productRole) return "instance";
  if (!def.type || !PRODUCT_TYPES.has(def.type)) return "instance";
  if (UNIT_NAME.test(def.name) && !productRole) return "instance";
  return "model";
}

/** Whether a field is a fact about the model or about this unit: what it
 *  declares, else what its role, type and name say. */
export function factScopeOf(def: ScopedFieldDef): FactScope {
  return declaredFactScope(def) ?? derivedFactScope(def);
}

/** The key two records of one model share: the identified model's name with
 *  case, spacing and punctuation folded ("Bambu Lab P1P" and "bambu lab
 *  p1p" are one model). Null when there is no name to key by. */
export function modelKeyOf(name: string | null | undefined): string | null {
  const k = (name ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return k.length >= 2 ? k : null;
}
