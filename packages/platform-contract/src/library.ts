// Outside libraries: the things a person keeps in another app (documents in
// Paperless-ngx, games in RomM, whatever comes next), linked to the records
// they belong to.
//
// Cobblr holds none of the items. It asks a library through four Services
// capabilities, generic for any library and any kind of item, so a new
// library is an adapter and nothing else changes:
//
//   library.find   (reading)  items that look like a record, a search, or
//                             what was added since a time, a page at a time
//   library.get    (reading)  one item's details and its picture
//   library.link   (writes)   put the Cobblr record's address on the item,
//                             to jump back from the library (optional)
//   library.copy   (job)      bring a copy of the item's file into Cobblr,
//                             attached to the record (optional)
//
// An item says what it is (`type`: "document", "game") and what its kind is
// called in a heading (`type_label`: "Documents", "Games"), so the record's
// panel groups by it without knowing any library. A record passes its own
// short fields along with its name and codes, so a library can match on what
// only it understands (a game's platform, its IGDB id) and say how sure it is.
//
// And one rule for "is this item about this record", used in both directions,
// so a record looking for its items and a new item looking for its record
// cannot disagree.
//
// First written as documents.* for Paperless (#4479); generalised when RomM
// joined as the second library (#4489), which is the probe that found the
// document-shaped parts. Pure: no I/O.

import type { BuiltInServiceDef } from "./services.js";

export const LIBRARY_FIND = "library.find";
export const LIBRARY_GET = "library.get";
export const LIBRARY_LINK = "library.link";
export const LIBRARY_COPY = "library.copy";
export const LIBRARY_CAPABILITIES = [LIBRARY_FIND, LIBRARY_GET, LIBRARY_LINK, LIBRARY_COPY] as const;
export type LibraryCapability = (typeof LIBRARY_CAPABILITIES)[number];

/** What Cobblr knows about a record that an item could match on. */
export interface RecordFacts {
  name: string;
  serial?: string;
  model?: string;
  barcode?: string;
  brand?: string;
  /** The record's other short fields, by name ("platform": "SNES",
   *  "igdb_id": "1074"): what a library that understands them matches on.
   *  Core never interprets these. */
  fields?: Record<string, string>;
}

/** One item as a library describes it. `ref` is the library's own id for
 *  it, opaque to Cobblr. */
export interface LibraryItem {
  ref: string;
  /** What it is, one word ("document", "game"). */
  type: string;
  /** The heading its kind goes under on a record ("Documents", "Games"). */
  type_label: string;
  title: string;
  /** A second line ("Super Nintendo", "Receipts"). */
  subtitle?: string | null;
  /** ISO date the item is about (a receipt's date, a game's release). */
  created?: string | null;
  tags?: string[];
  /** Where a person opens it in the library itself. */
  open_url?: string | null;
  /** What that link says ("Open in RomM"); "Open" when absent. */
  open_label?: string | null;
  /** The library has a picture of it (library.get, include "thumb"). */
  has_thumb?: boolean;
  /** Some of the item's own text, for the matching rule. Never shown. */
  excerpt?: string;
  /** The item's ids in outside catalogues, by the catalogue's name
   *  ({ igdb: "1074" }). A record whose field of that name holds the same id
   *  is this item, in either direction: a record looking for its item, or a
   *  new item looking for its record. */
  ids?: Record<string, string>;
  /** What the item is in terms a record might hold, each with every name it
   *  goes by ({ platform: ["Super Nintendo Entertainment System", "snes"] }).
   *  A record with a field of that name that names none of them is not this
   *  item, however alike the titles; one that names one of them is surer. In
   *  both directions, like `ids`. */
  attributes?: Record<string, string[]>;
  /** The library's own evidence that this is the record it was asked about
   *  (the same IGDB id, the same catalogue number): a score 0..1 and a word
   *  for why. Trusted as far as the adapter is: the adapter is our code. */
  match?: { score: number; because: string } | null;
}

export interface LibraryFindInput {
  /** The record's facts: items that look like it. */
  facts?: RecordFacts;
  /** What the person typed, for Find with a search of their own. */
  query?: string;
  /** Items added after this ISO time, newest first: the catch-up for a
   *  library that sends no webhook. */
  since?: string;
  limit?: number;
  /** The `next` of the page before, to read on. */
  cursor?: string;
}
export interface LibraryFindOutput {
  items: LibraryItem[];
  /** More to read: pass it back as `cursor`. Absent on the last page. */
  next?: string | null;
}

export interface LibraryGetInput {
  ref: string;
  /** The picture as well, small enough to ride in the answer. */
  include?: "thumb" | "none";
}
export interface LibraryGetOutput {
  item: LibraryItem;
  thumb?: { type: string; base64: string } | null;
}

export interface LibraryLinkInput {
  ref: string;
  /** Where the record is in Cobblr, written onto the item. */
  record_url: string;
  record_title: string;
}
export interface LibraryLinkOutput {
  linked: boolean;
}

export interface LibraryCopyInput {
  ref: string;
}
export interface LibraryCopyOutput {
  name: string;
  type: string;
}

// ── The capability declarations every library implements ────────────────

const itemSchema = {
  type: "object",
  required: ["ref", "type", "type_label", "title"],
  properties: {
    ref: { type: "string", minLength: 1, maxLength: 200 },
    type: { type: "string", minLength: 1, maxLength: 40 },
    type_label: { type: "string", minLength: 1, maxLength: 60 },
    title: { type: "string", maxLength: 500 },
    subtitle: { type: ["string", "null"], maxLength: 200 },
    created: { type: ["string", "null"] },
    tags: { type: "array", items: { type: "string" } },
    open_url: { type: ["string", "null"] },
    open_label: { type: ["string", "null"], maxLength: 60 },
    has_thumb: { type: "boolean" },
    excerpt: { type: "string", maxLength: 4000 },
    ids: { type: "object", additionalProperties: { type: "string", maxLength: 80 } },
    attributes: { type: "object", additionalProperties: { type: "array", items: { type: "string", maxLength: 120 } } },
    match: {
      anyOf: [
        { type: "null" },
        { type: "object", required: ["score", "because"], properties: { score: { type: "number", minimum: 0, maximum: 1 }, because: { type: "string", maxLength: 40 } } },
      ],
    },
  },
} as const;

const factsSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: { type: "string", maxLength: 300 },
    serial: { type: "string", maxLength: 120 },
    model: { type: "string", maxLength: 120 },
    barcode: { type: "string", maxLength: 120 },
    brand: { type: "string", maxLength: 120 },
    fields: { type: "object", additionalProperties: { type: "string", maxLength: 200 } },
  },
} as const;

type Decl = BuiltInServiceDef["capability"];

/** The four declarations, the same for every library: an adapter takes one
 *  of these as its `capability`, never writes its own. find and get are the
 *  floor; link and copy are offered only by a library that can. */
export const LIBRARY_CAPABILITY_DECLS: Record<LibraryCapability, Decl> = {
  [LIBRARY_FIND]: {
    id: LIBRARY_FIND,
    version: 1,
    title: "Find in a library",
    summary: "Finds the items in an outside library (documents, games) that look like a thing's name, codes or fields, or that match words a person typed.",
    effect: "none",
    mode: "sync",
    typical_seconds: 2,
    input_schema: {
      type: "object",
      properties: {
        facts: factsSchema,
        query: { type: "string", maxLength: 300 },
        since: { type: "string", maxLength: 40 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
        cursor: { type: "string", maxLength: 200 },
      },
    },
    output_schema: { type: "object", required: ["items"], properties: { items: { type: "array", items: itemSchema }, next: { type: ["string", "null"] } } },
  },
  [LIBRARY_GET]: {
    id: LIBRARY_GET,
    version: 1,
    title: "Read an item from a library",
    summary: "Reads one item's title, details and picture from an outside library.",
    effect: "none",
    mode: "sync",
    typical_seconds: 2,
    input_schema: { type: "object", required: ["ref"], properties: { ref: { type: "string", minLength: 1, maxLength: 200 }, include: { enum: ["thumb", "none"] } } },
    output_schema: {
      type: "object",
      required: ["item"],
      properties: {
        item: itemSchema,
        thumb: { anyOf: [{ type: "null" }, { type: "object", required: ["type", "base64"], properties: { type: { type: "string" }, base64: { type: "string" } } }] },
      },
    },
  },
  [LIBRARY_LINK]: {
    id: LIBRARY_LINK,
    version: 1,
    title: "Link an item back",
    summary: "Writes the address of a thing in Cobblr onto an item in an outside library, so the item links back to it.",
    effect: "writes",
    mode: "sync",
    typical_seconds: 3,
    input_schema: {
      type: "object",
      required: ["ref", "record_url", "record_title"],
      properties: { ref: { type: "string", minLength: 1, maxLength: 200 }, record_url: { type: "string", maxLength: 2000 }, record_title: { type: "string", maxLength: 300 } },
    },
    output_schema: { type: "object", required: ["linked"], properties: { linked: { type: "boolean" } } },
  },
  [LIBRARY_COPY]: {
    id: LIBRARY_COPY,
    version: 1,
    title: "Bring a copy into Cobblr",
    summary: "Copies one item's file from an outside library into Cobblr, attached to a thing, so it is in Cobblr's backup too.",
    effect: "none",
    mode: "async",
    typical_seconds: 10,
    input_schema: { type: "object", required: ["ref"], properties: { ref: { type: "string", minLength: 1, maxLength: 200 } } },
    output_schema: { type: "object", required: ["name", "type"], properties: { name: { type: "string" }, type: { type: "string" } } },
    files_out: [{ name: "file", types: ["application/pdf", "image/*", "application/octet-stream"] }],
  },
};

// ── A record's facts ────────────────────────────────────────────────────

/** A field holds the serial, model or maker by its name: the words a person
 *  uses for them, in the order a form usually has them. */
const FACT_FIELD_NAMES: Array<[keyof Omit<RecordFacts, "name" | "fields">, RegExp]> = [
  ["serial", /^(serial|serial_?(no|number|num)|sn|s_n)$/i],
  ["model", /^(model|model_?(no|number|num)|mpn|part_?(no|number)|sku)$/i],
  ["brand", /^(brand|make|maker|manufacturer|mfr|vendor)$/i],
  ["barcode", /^(barcode|upc|ean|gtin|isbn)$/i],
];

function text(v: unknown, max = 120): string | undefined {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t.slice(0, max) : undefined;
}

/** How many of a record's other fields ride along, and how long each may be:
 *  the short ones a library could match on, never a description. */
const MAX_FIELDS = 24;
const FIELD_MAX = 200;

/** What a record says about itself that an item could match on: its title,
 *  its serial, model, maker and barcode by field name (or the barcode by the
 *  `identifier` role), and its other short fields as they are. */
export function recordFactsOf(
  record: { title: string; fields: Record<string, unknown> },
  roled: ReadonlyArray<{ name: string; field_role?: string | null }> = [],
): RecordFacts {
  const facts: RecordFacts = { name: record.title.trim().slice(0, 300) };
  for (const [key, re] of FACT_FIELD_NAMES) {
    for (const [field, value] of Object.entries(record.fields ?? {})) {
      if (facts[key] || !re.test(field)) continue;
      const t = text(value);
      if (t) facts[key] = t;
    }
  }
  if (!facts.barcode) {
    const id = roled.find((f) => f.field_role === "identifier");
    const t = id ? text(record.fields?.[id.name]) : undefined;
    if (t) facts.barcode = t;
  }
  const fields: Record<string, string> = {};
  for (const [field, value] of Object.entries(record.fields ?? {})) {
    if (Object.keys(fields).length >= MAX_FIELDS) break;
    const t = text(value, FIELD_MAX + 1);
    if (t && t.length <= FIELD_MAX && !/^[0-9a-f-]{36}$/i.test(t)) fields[field] = t;
  }
  if (Object.keys(fields).length) facts.fields = fields;
  return facts;
}

/** A stable fingerprint of the facts that decide a match: when it changes,
 *  the record is matched again. */
export function factsKey(f: RecordFacts): string {
  const fields = Object.entries(f.fields ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v.trim().toLowerCase()}`)
    .join(",");
  return [f.name, f.serial, f.model, f.barcode, f.brand].map((v) => (v ?? "").trim().toLowerCase()).join("|") + `|${fields}`;
}

// ── The matching rule ───────────────────────────────────────────────────

const STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "your", "new", "set", "kit", "pack", "box", "item"]);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/** A code (serial, model, barcode) as it is printed, without the spaces and
 *  dashes people type it with. */
function codeOf(s: string | undefined): string | null {
  const c = (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return c.length >= 4 ? c : null;
}

/** How sure "this item is about this record" is, 0 to 1, and why. The
 *  library's own evidence (an id it shares with the record) counts first; then
 *  a serial or barcode printed on the item is the record itself; a model
 *  number is its kind of thing; the name's words in the title are the common
 *  case, a receipt titled "Dishwasher". */
export function scoreItemMatch(facts: RecordFacts, item: Pick<LibraryItem, "title" | "excerpt" | "match" | "ids" | "attributes">): { score: number; because: string | null } {
  const shared = sharedId(facts, item.ids);
  if (shared) return { score: 1, because: `${shared} id` };
  // The record says it is something the item is not (an SNES cartridge, a
  // Game Boy Advance ROM): not this item, whatever the title.
  const said = attributesSay(facts, item.attributes);
  if (said.conflict) return { score: 0, because: null };
  const claimed = item.match && Number.isFinite(item.match.score) ? { score: Math.max(0, Math.min(1, item.match.score)), because: item.match.because } : null;
  if (claimed && claimed.score >= 1) return claimed;
  let rule = ruleScore(facts, item);
  // The same title on the same platform is as good as a model number.
  if (said.agree && rule.because === "name" && rule.score >= SUGGEST_AT) rule = { score: Math.max(rule.score, 0.9), because: `name and ${said.agree}` };
  return claimed && claimed.score > rule.score ? claimed : rule;
}

/** Whether the record's fields agree with what the item says it is: the
 *  attribute both name, or one the record names and the item contradicts. */
function attributesSay(facts: RecordFacts, attributes: Record<string, string[]> | undefined): { agree: string | null; conflict: boolean } {
  let agree: string | null = null;
  for (const [name, aliases] of Object.entries(attributes ?? {})) {
    const field = Object.entries(facts.fields ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase());
    if (!field) continue;
    const have = field[1].toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!have) continue;
    const names = aliases.map((a) => a.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean);
    const same = names.some((n) => n === have || (have.length >= 4 && n.length >= 4 && (n.includes(have) || have.includes(n))));
    if (!same) return { agree: null, conflict: true };
    agree = name;
  }
  return { agree, conflict: false };
}

/** The catalogue both the record and the item name with the same id: a
 *  record field called after the catalogue ("igdb_id", "IGDB") holding the
 *  item's id there. */
function sharedId(facts: RecordFacts, ids: Record<string, string> | undefined): string | null {
  for (const [catalogue, id] of Object.entries(ids ?? {})) {
    const want = id.trim().toLowerCase();
    if (!want) continue;
    const named = new RegExp(`(^|[^a-z])${catalogue.replace(/[^a-z0-9]/gi, "")}([^a-z]|$)`, "i");
    for (const [field, value] of Object.entries(facts.fields ?? {})) {
      if (named.test(field) && value.trim().toLowerCase() === want) return catalogue;
    }
  }
  return null;
}

function ruleScore(facts: RecordFacts, item: Pick<LibraryItem, "title" | "excerpt">): { score: number; because: string | null } {
  const title = (item.title ?? "").toLowerCase();
  const body = `${title} ${(item.excerpt ?? "").toLowerCase()}`;
  const squashed = body.replace(/[^a-z0-9]/g, "");
  const serial = codeOf(facts.serial);
  if (serial && squashed.includes(serial)) return { score: 1, because: "serial" };
  const barcode = codeOf(facts.barcode);
  if (barcode && squashed.includes(barcode)) return { score: 1, because: "barcode" };
  const model = codeOf(facts.model);
  if (model && squashed.includes(model)) return { score: 0.8, because: "model" };
  const name = words(facts.name);
  if (!name.length) return { score: 0, because: null };
  const inTitle = name.filter((w) => title.includes(w)).length / name.length;
  if (inTitle === 1) return { score: 0.7, because: "name" };
  const inBody = name.filter((w) => body.includes(w)).length / name.length;
  if (inBody === 1 && name.length >= 2) return { score: 0.5, because: "name" };
  if (inTitle >= 0.66 && name.length >= 3) return { score: 0.45, because: "name" };
  return { score: Math.round(inBody * 30) / 100, because: null };
}

/** How a library tells Cobblr "a new item" the moment it has one: the steps
 *  a person follows in that library to point its webhook at Cobblr's inbound
 *  door (the address goes between `before` and `after`). A library without
 *  one is caught up with once a day. */
export interface LibraryPushSetup {
  /** The library's name, as the steps say it ("Paperless"). */
  library: string;
  /** What arrives ("new documents"). */
  arrives: string;
  before: string[];
  after: string[];
}

/** The score an item needs to be suggested for a record. */
export const SUGGEST_AT = 0.45;

/** How a linked item is named in a pairing: the connection it lives behind
 *  and its ref there. */
export const LIBRARY_ITEM_KIND = "core-documents:item";
export const LIBRARY_LINK_REL = "linked-from-library";
export function libraryTargetId(connectionId: string, ref: string): string {
  return `${connectionId}|${ref}`;
}
export function parseLibraryTargetId(id: string): { connectionId: string; ref: string } | null {
  const at = id.lastIndexOf("|");
  if (at <= 0 || at === id.length - 1) return null;
  return { connectionId: id.slice(0, at), ref: id.slice(at + 1) };
}
