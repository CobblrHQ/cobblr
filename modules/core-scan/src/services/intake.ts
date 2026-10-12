// One intake plan for every door (#3049).
//
// A row reaches the inbox through six doors: a scan (barcode, photo, url), a
// typed note, a receipt's lines, a split's children, an import, and the mail
// connector (which comes in through the first two over HTTP). Each door used
// to decide for itself what the pipeline does with its row. The typed note
// ran the matchmaker and nothing else, so a model number typed on the
// dashboard sat in the inbox with no name, no picture and no identify, while
// the same string scanned as a barcode got the catalog, the web, the
// picture, the photo cross-check and the match. The web's doors became one
// component in #3048; this is the server's equivalent: one table that says,
// per row SHAPE, which passes run and in what order, and one function every
// door calls to insert its row and run them. A door may ADD a pass; it
// cannot skip one the shape declares, because it never lists them.
//
// The insert lives here on purpose: lint:scan-door-intake refuses an
// insertInto("core_scan_inbox_items") anywhere else in the module, so a new
// door cannot exist without the plan.
//
// The shape is stamped on the row (suggested_metadata.intake_shape) so the
// passes that run later, detached, read the plan the row was admitted under
// rather than re-deriving it from a name the identify may have changed.

import type { Insertable, Kysely, Transaction } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { ADDED_BY_KEY, addedByFromRequest, type AddedBy } from "@cobblr/platform-contract/scan-source";
import type { CoreScanDB, CoreScanInboxItemsTable } from "../db.js";
import { mergeMeta } from "./metadata.js";
import { classifyScanCode } from "./scan-router.js";
import { enrichBarcodeItem } from "./enrich.js";
import { refreshCatalogImageByName } from "./enrich-photo.js";
import { identifyTypedIdentifier } from "./identify-identifier.js";
import { findTracked } from "./entity-match.js";
import { matchQuery, trackedMatchStamp } from "./tracked-stamp.js";

export type RowShape =
  | "barcode"
  | "url"
  | "photo"
  /** A typed model, part or serial number: an identifier a lookup can take. */
  | "identifier"
  /** Typed words ("a box of screws"): nothing to look up, the matchmaker routes it. */
  | "phrase"
  | "receipt-line"
  | "split-child"
  /** A row copied from another instance, with its answers already on it. */
  | "import";

export type IntakePass =
  /** The catalog chain for a code, then the web, with the picture and the
   *  photo cross-check that come with a hit (enrichBarcodeItem). */
  | "identify-code"
  /** The vision identify, run by the photo wire on scan.received (a person
   *  can edit or disable it on /wires); nothing to call here. */
  | "identify-photo"
  /** The web lookup of a typed identifier, heuristic titles before a model. */
  | "identify-name"
  /** The matchmaker: routing, fields, the location suggestion. */
  | "match"
  /** A picture searched by the row's name (and its category, once matched). */
  | "picture-search"
  /** An order line read on its store's own page (pack-parts.ts, #5719): its
   *  variant's photo, and a mixed pack split into one row per colour. */
  | "store-product";

/** The plan, per shape, in the order the passes run. Declarative, so the
 *  contract test can read it and a door's comment can point at a line. */
export const INTAKE_PLAN: Readonly<Record<RowShape, readonly IntakePass[]>> = {
  barcode: ["identify-code", "match"],
  url: ["identify-code", "match"],
  photo: ["identify-photo", "match"],
  identifier: ["identify-name", "match", "picture-search"],
  phrase: ["match", "picture-search"],
  "receipt-line": ["store-product", "match", "picture-search"],
  "split-child": ["picture-search", "match"],
  import: [],
};

/** The shape's passes plus what the door added, in plan order first. A door
 *  can only lengthen the list. */
export function intakePlan(shape: RowShape, add: readonly IntakePass[] = []): IntakePass[] {
  const out = [...INTAKE_PLAN[shape]];
  for (const p of add) if (!out.includes(p)) out.push(p);
  return out;
}

/** Does the plan search a picture AFTER the match (so the match's category
 *  can sharpen it), or before / never? matchItem's tail reads this. */
export function pictureSearchAfterMatch(shape: RowShape): boolean {
  const plan = INTAKE_PLAN[shape];
  const m = plan.indexOf("match");
  const p = plan.indexOf("picture-search");
  return m >= 0 && p > m;
}

/** A unit or a size reads as letters and digits too ("10mm", "5kg", "3D"). */
const UNIT_TOKEN = /^\d+(?:\.\d+)?(?:mm|cm|m|km|kg|g|mg|lb|lbs|oz|ml|l|in|ft|yd|pcs?|pk|ct|x|v|w|a|ah|mah|gb|tb|mb|k|hz|khz|mhz|ghz|d|ply|awg|mp|fps|rpm|psi|bar)$/i;

/**
 * What a typed string is, when it is an identifier and not a phrase.
 *
 * "code": a product code the catalogs key on (a UPC/EAN, an ISBN, an ASIN, a
 * URL); it takes the same path a scanned one does. "identifier": a model,
 * part or serial number ("PB287Q", "WD40EFRX", "M8x20"), letters and digits
 * in one token of five or more, alone or after one word of brand
 * ("ASUS PB287Q"); it goes to the web. Anything else is a phrase. A unit
 * ("10mm", "5kg") is not an identifier, and neither is a single letter with
 * digits ("3D").
 */
export function typedIdentifier(text: string): { kind: "code" | "identifier"; code: string } | null {
  const t = text.trim();
  if (!t) return null;
  const tokens = t.split(/\s+/);
  if (tokens.length === 1) {
    const cls = classifyScanCode(t);
    if (cls.type === "upc" || cls.type === "isbn" || cls.type === "asin" || cls.type === "url") {
      return { kind: "code", code: cls.code };
    }
    return identifierToken(t) ? { kind: "identifier", code: t } : null;
  }
  if (tokens.length === 2 && /^[A-Za-z][A-Za-z&.'-]{1,}$/.test(tokens[0]!) && identifierToken(tokens[1]!)) {
    return { kind: "identifier", code: t };
  }
  return null;
}

function identifierToken(tok: string): boolean {
  if (tok.length < 5 || tok.length > 30) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(tok)) return false;
  if (UNIT_TOKEN.test(tok)) return false;
  const letters = (tok.match(/[A-Za-z]/g) ?? []).length;
  const digits = (tok.match(/\d/g) ?? []).length;
  if (letters === 0 || digits === 0) return false;
  // "3D", "4K", a size with one letter: a word with a number in it, not a code.
  return letters >= 2 || digits >= 3;
}

/** The columns the shape is read from. */
export interface ShapeRow {
  source_kind: CoreScanInboxItemsTable["source_kind"];
  barcode_text: string | null;
  source_url: string | null;
  image_file_id: string | null;
  suggested_name: string | null;
  suggested_metadata?: unknown;
}

/** The shape of a row, from its columns. `intake_shape` on the row wins
 *  once stamped (a later pass must not re-derive it from a name the identify
 *  changed); a row from before the stamp is read by its columns. */
export function rowShape(row: ShapeRow, door?: IntakeDoor): RowShape {
  if (door === "import") return "import";
  const meta = (row.suggested_metadata ?? {}) as { intake_shape?: unknown; split_from?: unknown };
  if (typeof meta.intake_shape === "string" && meta.intake_shape in INTAKE_PLAN) return meta.intake_shape as RowShape;
  if (meta.split_from) return "split-child";
  if (row.source_kind === "receipt") return "receipt-line";
  if (row.barcode_text) return "barcode";
  if (row.source_url || row.source_kind === "url") return "url";
  if (row.source_kind === "note") {
    const typed = typedIdentifier(row.suggested_name ?? "");
    return typed ? "identifier" : "phrase";
  }
  if (row.image_file_id) return "photo";
  return "phrase";
}

/** `assistant`: an AI agent adding a thing (MCP, the chat, the API's
 *  add-a-thing door). The row is shaped as a typed note is and runs the same
 *  plan; the door waits for it (`settle`) so its answer can say what the
 *  intake found. */
export type IntakeDoor = "scan" | "note" | "receipt" | "split" | "import" | "assistant";

/** The match passes live in api/inbox.ts (the matchmaker's request-side
 *  half); it registers them at load so the plan can call them without an
 *  import cycle. Loud when a pass runs before that. */
export interface MatchRunners {
  /** Match now (a fresh row: force). */
  match: (o: { orgId: string; orgSlug: string; token: string; baseUrl: string; itemId: string; userId: string | null; settle?: boolean }) => Promise<unknown>;
  /** Match once the identify has landed (the barcode race, the photo wire). */
  matchWhenEnriched: (o: { orgId: string; orgSlug: string; token: string; baseUrl: string; itemId: string; userId: string | null }) => void;
}
let runners: MatchRunners | null = null;
export function registerMatchRunners(r: MatchRunners): void {
  runners = r;
}
function matchRunners(): MatchRunners {
  if (!runners) throw new Error("core-scan intake: match runners not registered (api/inbox.ts registers them at load)");
  return runners;
}

type Db = Kysely<CoreScanDB> | Transaction<CoreScanDB>;
/** What a door hands over: the inbox row's insert shape. */
export type InsertValues = Insertable<CoreScanInboxItemsTable>;

export interface IntakeOpts {
  db: Db;
  orgId: string;
  orgSlug: string;
  userId: string | null;
  /** The caller's bearer, for the passes that go back through the api. Null
   *  (no session) runs the passes that need none and skips the match, as the
   *  doors did before. */
  token: string | null;
  baseUrl: string;
  visitorIp?: string | null;
  door: IntakeDoor;
  /** The row as the door shaped it. The plan stamps intake_shape on it. */
  values: InsertValues;
  /** Passes the door adds to the shape's plan. Never fewer. */
  add?: readonly IntakePass[];
  /** Race the first identify inline for this long (the scanner's sheet wants
   *  the enriched row on the response); the rest runs detached. */
  inlineBudgetMs?: number;
  /** Await the whole plan before returning, so the caller can answer with
   *  what the intake found (the assistant's door). The passes are the same
   *  ones, in the same order; only the waiting differs. A photo's identify
   *  rides the scan.received wire and is still detached: `inline` says
   *  "timeout" for it, and the row fills in afterwards. */
  settle?: boolean;
}

export interface IntakeResult {
  row: Record<string, unknown> & { id: string };
  shape: RowShape;
  plan: IntakePass[];
  /** "done": the inline identify finished inside the budget; "timeout": it is
   *  still running (the row carries the waiting note); "none": nothing ran
   *  inline. */
  inline: "done" | "timeout" | "none";
}

/** The note a raced identify leaves when it outruns its budget: the row would
 *  otherwise carry a null note, which reads as "nobody looked". */
export const STILL_LOOKING_NOTE = "Still looking this up. It will fill in shortly.";

/**
 * Insert the row and run its shape's plan. The only insert into the inbox.
 */
export async function intakeRow(opts: IntakeOpts): Promise<IntakeResult> {
  const v = opts.values;
  const shape = rowShape(
    {
      source_kind: v.source_kind,
      barcode_text: v.barcode_text ?? null,
      source_url: v.source_url ?? null,
      image_file_id: v.image_file_id ?? null,
      suggested_name: v.suggested_name ?? null,
      suggested_metadata: typeof v.suggested_metadata === "string" ? JSON.parse(v.suggested_metadata) : v.suggested_metadata,
    },
    opts.door,
  );
  let plan = intakePlan(shape, opts.add);
  // A code the workspace already holds is answered from its own records, at
  // once: no catalog chain, no web, no AI (#6003). The scanner showed
  // "Looking up..." for seconds on a tea box its owner already tracks, while
  // the network named something his own record already names. Only a code
  // nobody here holds goes out to look.
  const held = shape === "barcode" && v.barcode_text ? await heldByCode(opts.orgId, v) : null;
  if (held) plan = plan.filter((p) => p !== "identify-code");
  // Who added it, when it was not the person's own hand: the session's
  // header says so once ("Added by Claude", scan-source.ts).
  const addedBy = shape === "import" ? null : addedByFromRequest((await Promise.resolve(platform().auth?.requestSource?.()).catch(() => null)) ?? null);
  const stamped: InsertValues =
    shape === "import" ? v : { ...v, suggested_metadata: stampShape(v.suggested_metadata, shape, addedBy) as never };
  const values: InsertValues = held
    ? {
        ...stamped,
        suggested_name: v.suggested_name ?? held.title,
        ai_confidence: "1",
        ai_suggested_at: new Date(),
        suggested_metadata: JSON.stringify({ ...(JSON.parse(String(stamped.suggested_metadata ?? "{}")) as Record<string, unknown>), tracked_match: held.stamp, identified_by: "your_records" }) as never,
      }
    : stamped;
  const row = (await opts.db
    .insertInto("core_scan_inbox_items")
    .values(values)
    .returningAll()
    .executeTakeFirstOrThrow()) as unknown as IntakeResult["row"];

  if (shape !== "import") {
    void platform().events.emit("core-scan.scan.received", {
      orgId: opts.orgId,
      visitor_ip: opts.visitorIp ?? null,
      itemId: row.id,
      barcode: (row.barcode_text as string | null) ?? null,
      sourceKind: row.source_kind as string,
    });
  }

  const ctx: PassContext = { ...opts, row, shape, held: !!held };
  let inline: IntakeResult["inline"] = "none";
  if (opts.settle) {
    await runPasses(ctx, plan);
    return { row, shape, plan, inline: shape === "photo" ? "timeout" : "done" };
  }
  if (plan[0] === "identify-code" && shape === "barcode" && opts.inlineBudgetMs) {
    inline = await raceInline(ctx, identifyCode(ctx), opts.inlineBudgetMs);
    void runPasses(ctx, plan.slice(1));
  } else {
    void runPasses(ctx, plan);
  }
  return { row, shape, plan, inline };
}

function stampShape(meta: unknown, shape: RowShape, addedBy: AddedBy | null): string {
  const base = typeof meta === "string" ? (JSON.parse(meta) as Record<string, unknown>) : ((meta as Record<string, unknown> | undefined) ?? {});
  return JSON.stringify({ ...(addedBy ? { [ADDED_BY_KEY]: addedBy } : {}), ...base, intake_shape: shape });
}

interface PassContext extends IntakeOpts {
  row: IntakeResult["row"];
  shape: RowShape;
  /** The row is gone from the inbox (a pack split into its parts): the
   *  passes after this one have nothing to do. */
  done?: boolean;
  /** Named from the workspace's own record at insert: no identify is coming,
   *  so the match runs now rather than waiting for one. */
  held?: boolean;
}

/** The mark a session-free check leaves. 2: the exact-title rule below; a
 *  row marked `true` was checked under the looser one and is asked again. */
export const OWN_MATCH_CHECKED = 2;

const sameWords = (a: string | null | undefined, b: string | null | undefined): boolean => {
  const n = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9.]+/g, " ").trim();
  return !!n(a) && n(a) === n(b);
};

/** The workspace's own record for a row made with no session, stamped the
 *  way the card reads a match. With no matchmaker to vouch for it, only the
 *  sure answers count: the row's code, or a record named exactly as the row
 *  is. One shared word is not a name here: a spool in "light apricot" was
 *  stamped as the Apricot Jasmine Tea you have (#6004). Checked once; a
 *  stamp an earlier, looser check wrote is taken back. A failed lookup is
 *  logged and the row stays unmatched, filed as new only after a person
 *  looks. */
export async function stampOwnRecordMatch(db: Kysely<CoreScanDB>, orgId: string, id: string): Promise<boolean> {
  const row = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirst();
  if (!row || row.status !== "pending") return false;
  try {
    const found = await findTracked(orgId, matchQuery(row as never, null, null));
    const named = found.name_matches.filter((m) => sameWords(m.title, row.suggested_name));
    const stamp = trackedMatchStamp({ barcode_matches: found.barcode_matches, name_matches: named });
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: mergeMeta({ own_match_checked: OWN_MATCH_CHECKED, ...(stamp ? { tracked_match: stamp } : {}) }, stamp ? [] : ["tracked_match"]) as never })
      .where("id", "=", id)
      .execute();
    return !!stamp;
  } catch (err) {
    console.error(`[core-scan] own-record match for ${id} failed:`, (err as Error).message);
    return false;
  }
}

/** The workspace's own record for this code, by its barcode or identifier
 *  fields (local and indexed; never a name guess), stamped the way the card
 *  reads a match. Null when nothing here holds it, or the lookup failed: a
 *  failed lookup must fall through to the network, never block the scan. */
async function heldByCode(orgId: string, v: InsertValues): Promise<{ title: string; stamp: ReturnType<typeof trackedMatchStamp> } | null> {
  try {
    // The row as it will be inserted, asked the one way every match is: with
    // no name yet, only the code (and a part number the person gave) can match.
    const row = { barcode_text: v.barcode_text ?? null, suggested_name: v.suggested_name ?? null, suggested_manufacturer: v.suggested_manufacturer ?? null, suggested_metadata: typeof v.suggested_metadata === "string" ? JSON.parse(v.suggested_metadata) : (v.suggested_metadata ?? null) };
    const found = await findTracked(orgId, matchQuery(row as never, null, null));
    if (!found.barcode_matches.length) return null;
    const stamp = trackedMatchStamp({ barcode_matches: found.barcode_matches, name_matches: [] });
    return { title: found.barcode_matches[0]!.title, stamp };
  } catch (err) {
    console.error("[core-scan] own-record lookup failed; asking the network:", (err as Error).message);
    return null;
  }
}

/** The passes in order, each awaited before the next, every one detached
 *  from the request. A pass that throws is logged and the next one runs:
 *  a failed picture search must not cost the match. */
async function runPasses(ctx: PassContext, passes: IntakePass[]): Promise<void> {
  for (const pass of passes) {
    if (ctx.done) return;
    try {
      await runPass(ctx, pass);
    } catch (err) {
      console.error(`[core-scan] intake ${pass} for ${ctx.row.id} threw:`, (err as Error).message);
    }
  }
}

async function runPass(ctx: PassContext, pass: IntakePass): Promise<void> {
  const common = { orgId: ctx.orgId, orgSlug: ctx.orgSlug, baseUrl: ctx.baseUrl, itemId: ctx.row.id, userId: ctx.userId };
  switch (pass) {
    case "identify-code":
      await identifyCode(ctx).then(() => emitEnriched(ctx));
      return;
    case "identify-photo":
      // The wire on scan.received (emitted above) runs the vision identify,
      // and a person can change it on /wires. Nothing to call from here.
      return;
    case "identify-name": {
      const typed = typedIdentifier((ctx.row.suggested_name as string | null) ?? "");
      if (!typed) return;
      await identifyTypedIdentifier({
        db: ctx.db as Kysely<CoreScanDB>,
        orgId: ctx.orgId,
        itemId: ctx.row.id,
        code: typed.code,
        userId: ctx.userId,
      });
      await emitEnriched(ctx);
      return;
    }
    case "match": {
      // With no session (a boot heal's split, any background door) the
      // matchmaker cannot run, but the workspace's own records can still be
      // asked: a pack's white spool is the white spool you have (#6004).
      if (!ctx.token) return void (await stampOwnRecordMatch(ctx.db as Kysely<CoreScanDB>, ctx.orgId, ctx.row.id));
      const r = matchRunners();
      // A shape whose identify lands later and out of band (the barcode race
      // past its budget, the photo wire) is matched once it has a name; a
      // shape whose name is on the row already is matched now.
      // A settled plan has already awaited its identify, so a barcode or a
      // url is matched now; only a photo's identify is still out on the wire.
      if (ctx.held) await r.match({ ...common, token: ctx.token, ...(ctx.settle ? { settle: true } : {}) });
      else if (ctx.settle && ctx.shape !== "photo") await r.match({ ...common, token: ctx.token, settle: true });
      else if (ctx.shape === "barcode" || ctx.shape === "url" || ctx.shape === "photo") r.matchWhenEnriched({ ...common, token: ctx.token });
      else await r.match({ ...common, token: ctx.token });
      return;
    }
    case "store-product": {
      const { storeProductPass } = await import("./pack-parts.js");
      const outcome = await storeProductPass({
        db: ctx.db as Kysely<CoreScanDB>,
        orgId: ctx.orgId,
        itemId: ctx.row.id,
        userId: ctx.userId,
        purchase: ctx.token ? { baseUrl: ctx.baseUrl, slug: ctx.orgSlug, headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" } } : null,
        // Each part comes in by the same door the line did, and runs the
        // line's plan: its own match and its own picture.
        admit: async (values) =>
          (await intakeRow({ db: ctx.db, orgId: ctx.orgId, orgSlug: ctx.orgSlug, userId: ctx.userId, token: ctx.token, baseUrl: ctx.baseUrl, door: "receipt", values: values as InsertValues })).row as { id: string },
      });
      if (outcome === "split") ctx.done = true;
      return;
    }
    case "picture-search": {
      // After a match the matchmaker's tail searches with the category it
      // settled on (pictureSearchAfterMatch); before one, the name alone.
      if (pictureSearchAfterMatch(ctx.shape)) return;
      const name = (ctx.row.suggested_name as string | null) ?? "";
      if (!name) return;
      await refreshCatalogImageByName(ctx.orgId, ctx.row.id, name, (ctx.row.suggested_manufacturer as string | null) ?? null);
      return;
    }
  }
}

function identifyCode(ctx: PassContext): Promise<void> {
  const code = (ctx.row.barcode_text as string | null) ?? (ctx.row.source_url as string | null) ?? typedIdentifier((ctx.row.suggested_name as string | null) ?? "")?.code;
  if (!code) return Promise.resolve();
  return enrichBarcodeItem({
    db: ctx.db as Kysely<CoreScanDB>,
    orgId: ctx.orgId,
    itemId: ctx.row.id,
    orgSlug: ctx.orgSlug,
    bearer: ctx.token ?? undefined,
    baseUrl: ctx.baseUrl,
    upc: code,
    // The person, so their own connection serves every AI call this lookup
    // makes; without it the step ran as nobody and a "just me" connection
    // served nothing (#2846).
    userId: ctx.userId,
  }).catch((err) => console.error("[core-scan] enrich threw:", (err as Error).message));
}

function emitEnriched(ctx: PassContext): Promise<void> {
  return Promise.resolve(platform().events.emit("core-scan.scan.enriched", { orgId: ctx.orgId, itemId: ctx.row.id })).then(() => undefined);
}

/** Race the inline identify against the budget. Whichever lands first wins
 *  the response; the identify keeps running detached either way. On a
 *  timeout the row gets the waiting note, conditional on ai_notes still
 *  being null so a result landing in the gap is never clobbered. */
async function raceInline(ctx: PassContext, task: Promise<void>, budgetMs: number): Promise<"done" | "timeout"> {
  const timed = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), budgetMs));
  const raced = await Promise.race([task.then(() => "done" as const), timed]);
  void task.then(() => emitEnriched(ctx));
  if (raced === "timeout") {
    await ctx.db
      .updateTable("core_scan_inbox_items")
      .set({ ai_notes: STILL_LOOKING_NOTE })
      .where("id", "=", ctx.row.id)
      .where("ai_notes", "is", null)
      .execute()
      .catch((err) => console.error("[core-scan] timeout note failed:", (err as Error).message));
  }
  return raced;
}
