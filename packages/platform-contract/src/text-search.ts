import { type Measure, measurePaths, measureTokens } from "@cobblr/platform-contract/measure";

// ── text search over a list's columns ─────────────────────────────────────
// Lives here rather than in its own file: the contract is loaded buildless by
// node at boot (lint:node-resolves), which does not rewrite a "./x.js"
// re-export the way tsc and tsx do.
// One meaning for `q` on a list: "any text this record carries contains it".
//
// Every module used to hand-roll the where clause, and each one chose its own
// columns: machines matched the name only, sales matched the name only, tags
// the name, purchase lines the description. To a person "the Bambu one" is a
// manufacturer and "my deltas" is a type, and to the assistant `q` is a text
// search, so a name-only resolver answered "you have no Bambu" about a
// workspace with one (2026-08-27). The clause is the same in every module;
// only the column list differs, and that is all a resolver should have to say.
//
// Structurally typed on purpose: this package has no kysely dependency, and a
// resolver hands in its own `eb`. The shape used here (`eb(lhs, op, rhs)`,
// `eb.fn`, `eb.or`, `eb.cast`) is Kysely's expression builder from 0.26 on.

/** The slice of Kysely's ExpressionBuilder this helper needs.
 *
 *  Typed with `any` on purpose: the real builder's parameters are
 *  ReferenceExpression<DB, TB> for the caller's own tables, which this package
 *  cannot name without depending on kysely and on every module's schema. The
 *  caller's `eb` is fully typed at the call site; this interface only has to
 *  accept it, and the SQL it produces is what the api tests check. */
export interface LikeFnModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (name: "lower" | "jsonb_path_exists" | "jsonb_path_query_array", args: any[]): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  coalesce(...args: any[]): any;
}
export interface LikeBuilder {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (lhs: any, op: "like", rhs: any): any;
  fn: LikeFnModule;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  or(exprs: any[]): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cast(expr: any, to: "text"): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  val(value: any): any;
  /** Every one of these (Kysely's builder has it; a hand-written fake may
   *  not, and then a search runs without reading values). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  and?(exprs: any[]): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  not?(expr: any): any;
}

/** The column names the caller's Kysely expression builder accepts: its
 *  `ref()` parameter, i.e. the columns of the table(s) being queried. A name
 *  the table does not have is a TYPE error here, not a `column "…" does not
 *  exist` in production. That is how a search on orders named `description`
 *  and a search on projects named `title` shipped and failed every search on
 *  every surface for weeks (#3824): these lists used to be plain strings.
 *  A builder with no `ref` (a hand-written fake) falls back to string. */
export type ColumnOf<EB> = EB extends { ref: (reference: infer R) => unknown } ? Extract<R, string> : string;

export interface TextSearchColumns<EB = unknown> {
  /** Plain text columns. A NULL never matches and never breaks the OR. */
  text: readonly ColumnOf<EB>[];
  /** jsonb columns searched as text (custom fields live in `metadata`). */
  json?: readonly ColumnOf<EB>[];
  /** A jsonb array of the record's measured values read off its text
   *  (`measureReadings`), so a value still typed as text is found by value. */
  readings?: ColumnOf<EB>;
  /** The fields the asker may not read (a field read scope they lack): never
   *  matched, as a column or as a key of a json column, so a search is not a
   *  way to learn what they hold (#7838). Required, so no search forgets it:
   *  a resolver passes its query's `unreadable`, and `undefined` is only for
   *  a read the system makes for itself. */
  unreadable: ReadonlySet<string> | undefined;
}

/** The jsonpath to a json column's values the asker may read: every value,
 *  or every value under a key they may read. */
export function readableValuesPath(unreadable: ReadonlySet<string> | undefined): string {
  if (!unreadable?.size) return "$.*";
  return `$.keyvalue() ? (${[...unreadable].map((k) => `@.key != ${JSON.stringify(k)}`).join(" && ")}).value`;
}

const bare = (column: string) => column.slice(column.lastIndexOf(".") + 1);

/** Where the kernel leaves, on a module route's request, the fields its
 *  reader may not read (the field-scope middleware sets it before the
 *  module's router runs). */
export const UNREADABLE_FIELDS = Symbol.for("cobblr.unreadable-fields");

/** The fields this request's reader may not read, for a module route that
 *  searches its own rows: pass it to textSearchWhere as `unreadable`. */
export function unreadableFieldsOf(req: object): ReadonlySet<string> | undefined {
  return (req as Record<symbol, ReadonlySet<string> | undefined>)[UNREADABLE_FIELDS];
}

/** A set of column names checked against a table's row type, for the lists a
 *  resolver keeps at module scope (what may be sorted by, filtered on,
 *  compared). `columnSet<PurchasesDB["purchases_orders"]>()(["ordered_at"])`:
 *  a column the row type does not have fails typecheck (#3824). */
export function columnSet<Row>() {
  return <C extends keyof Row & string>(columns: readonly C[]): ReadonlySet<string> => new Set<string>(columns);
}

/** What a person typed, made literal inside a LIKE pattern: `%` and `_` are
 *  wildcards to Postgres and a backslash is its escape, so "50%" matched every value
 *  holding "50" and "a_b" matched "axb". A pattern built from a person's text
 *  goes through here (lint:like-needles-are-escaped). */
export function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The needle a person typed, as the like pattern every resolver uses:
 *  lower-cased, escaped, and matched anywhere. */
export function likeNeedle(q: string): string {
  return `%${likeEscape(q.toLowerCase())}%`;
}

/**
 * The where-expression for `q` over the listed columns, or null when `q` is
 * empty (so a resolver can write `const w = textSearchWhere(...); if (w) query =
 * query.where(w)`). Case-insensitive, substring, every column OR-ed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function textSearchWhere<EB extends LikeBuilder>(eb: EB, q: string | undefined, columns: TextSearchColumns<EB>): any {
  const needle = (q ?? "").trim();
  if (!needle) return null;
  const empty = eb.val("");
  const hidden = columns.unreadable;
  const text = columns.text.filter((c: string) => !hidden?.has(bare(c)));
  // Readings are read off the record's text: with a column of it hidden, they
  // could say what that column holds.
  const readings = text.length === columns.text.length ? columns.readings : undefined;
  const values = readableValuesPath(hidden);
  const anywhere = (word: string): any[] => {
    const like = likeNeedle(word);
    return [
      ...text.map((c: string) => eb(eb.fn("lower", [eb.fn.coalesce(c, empty)]), "like", like)),
      ...(columns.json ?? []).map((c: string) => eb(eb.fn("lower", [eb.cast(eb.fn("jsonb_path_query_array", [c, eb.val(`${values} ? (!exists(@.__cobblr_secret))`)]), "text")]), "like", like)),
    ];
  };
  const exprs = anywhere(needle);
  if (exprs.length === 0) return null;
  const hasValues = !!(columns.json?.length || readings);
  const read = hasValues && eb.and && eb.not ? measureTokens(needle) : null;
  if (!read) {
    // Every word somewhere on the record, in any order: as one phrase, "M3
    // bolts" found nothing in a workspace of "M3 x 10 bolts" (#8866).
    const words = needle.split(/\s+/).filter(Boolean);
    if (words.length < 2 || !eb.and) return eb.or(exprs);
    return eb.and(words.map((w) => eb.or(anywhere(w))));
  }
  return valueSearchWhere(eb, read, {
    text: anywhere,
    fields: (columns.json ?? []) as readonly string[],
    readings: readings as string | undefined,
    unreadable: hidden,
  });
}

/**
 * A search that names values ("10k", "100 nF 16V ceramic"): every word has to
 * be found somewhere, and each VALUE is found by value (±1%, in its unit) in a
 * measure field or a reading, or else as text, but never as the text of a
 * record that holds that number in another unit. So 4k7 finds the resistor
 * typed "4.7 kΩ" and 10k never finds the 10 kHz crystal, even one titled
 * "10kHz". `text` is the caller's own text match for one word.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function valueSearchWhere<EB extends LikeBuilder>(
  eb: EB,
  read: NonNullable<ReturnType<typeof measureTokens>>,
  opts: { text: (word: string) => any[]; fields?: readonly string[]; readings?: string; unreadable?: ReadonlySet<string> },
): any {
  const at = (column: string, path: string, vars: string) =>
    // Untyped parameters: Postgres reads them as jsonpath and jsonb from the
    // function's own signature.
    eb.fn("jsonb_path_exists", [column, eb.val(path), eb.val(vars)]);
  const holds = (m: Measure, which: "same" | "other"): any[] => {
    const paths = measurePaths(m);
    const p = paths[which];
    if (!p) return [];
    // Only the values under keys the asker may read.
    const fields = p.fields.replace(/^\$\.\*/, readableValuesPath(opts.unreadable));
    return [
      ...(opts.fields ?? []).map((c) => at(c, fields, paths.vars)),
      ...(opts.readings ? [at(opts.readings, p.readings, paths.vars)] : []),
    ];
  };
  const every = [
    ...read.words.map((w) => eb.or(opts.text(w))),
    ...read.values.map((v) => {
      const asText = eb.or(opts.text(v.text));
      const elsewhere = holds(v.measure, "other");
      return eb.or([...holds(v.measure, "same"), elsewhere.length ? eb.and!([asText, eb.not!(eb.or(elsewhere))]) : asText]);
    }),
  ];
  return eb.and!(every);
}
