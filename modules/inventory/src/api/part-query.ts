// The ONE compile of a generic list query (filter, where, sort) onto
// inventory_parts, shared by the entity list resolver and the module's own
// list route.
//
// It used to live inside the resolver only. The parts list page reads through
// the module route, which had its own hand-picked filters and no sort or
// generic filter at all, so a saved view's `sort` and `filter` were honoured
// through core-views and silently ignored on the page that actually showed
// the view: "Use it or lose it" stayed alphabetical, and the lego Built /
// Unbuilt chips filtered nothing (#2772, #2422). Two read paths, one rule,
// one place, so they cannot disagree again.
import { sql, type SelectQueryBuilder } from "kysely";
import { columnSet, arrivedEverywhere, parseSort, containsPattern, isTextWhereOp, type EntityListQuery, type FilterPredicate } from "@cobblr/platform-contract";
import type { InventoryDB } from "../db.js";
import { PART_CI_FILTER_COLS, PART_FILTER_COLS } from "../db.js";
import { filterValues, isMulti } from "./filter-values.js";
import { parseMeasure } from "@cobblr/platform-contract/measure";
import { measuredValueSql } from "../measure-readings.js";

// Loose on purpose: the resolver selects from `inventory_parts`, the list
// route from `inventory_parts as p` joined to categories. Both are the same
// table under a different alias, which `table` names for every reference so
// a join never makes `name` ambiguous.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PartsQuery = SelectQueryBuilder<any, any, any>;

export interface PartQueryOpts {
  /** The alias inventory_parts carries in this query (`p` on the list route). */
  table?: string;
  /** Collects every `where` predicate this compile could not run, so the
   *  caller can say so instead of showing an unfiltered list as if it were
   *  the filtered one. */
  unapplied?: FilterPredicate[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The native columns a query may order by. Anything else in a sort spec is
 *  taken to be one of the table's own fields and orders by its metadata
 *  value (below); nothing is ever interpolated as a column name. */
const NATIVE_SORTABLE = columnSet<InventoryDB["inventory_parts"]>()(["name", "qty", "min_qty", "cost", "created_at", "updated_at", "asset_id"]);

/** Apply `filter` (D7 tag, native equality, D8 metadata equality) and `where`
 *  (D10 comparisons). Degrades rather than throws: an unknown column or
 *  unsupported operator applies no predicate AND is reported through
 *  `opts.unapplied`; an unusable filter value empties the set instead of
 *  widening it. */
export function applyPartFilters<Q extends PartsQuery>(
  qIn: Q,
  query: Pick<EntityListQuery, "filter" | "where" | "today">,
  opts: PartQueryOpts = {},
): Q {
  let q: PartsQuery = qIn;
  const t = opts.table ?? "inventory_parts";
  const col = (c: string) => sql.ref(`${t}.${c}`);
  const meta = sql.ref(`${t}.metadata`);
  if (query.filter) {
    for (const [key, val] of Object.entries(query.filter)) {
      if (val === undefined || val === null) continue;
      if (key === "_tag") {
        // D7: every entity carrying this tag (by name). Case-insensitive
        // match against core_tags_tags.name; sub-query joins assignments.
        const tagName = String(val).trim().toLowerCase();
        q = q.where(
          sql<boolean>`exists (
            select 1 from core_tags_assignments a
            join core_tags_tags t on t.id = a.tag_id
            where a.source_module = 'inventory'
              and a.source_type = 'part'
              and a.source_id = ${col("id")}
              and lower(t.name) = ${tagName}
          )`,
        );
        continue;
      }
      // One value or several. A filter used to be equality-only and silently
      // IGNORED anything that was not a string, so passing a list applied no
      // filter and the view showed everything - a panel meant to show one
      // cupboard showing the whole kitchen, with nothing to notice. An
      // unusable value now drops the row set to empty instead of widening it:
      // showing nothing is visibly wrong, showing everything is not.
      const vals = filterValues(val);
      if (!vals) {
        q = q.where(sql<boolean>`false`);
        continue;
      }
      if (PART_FILTER_COLS.has(key)) {
        // Scanned identifiers arrive in whatever case the scanner emitted, so
        // those columns compare case-insensitively (and this form can finally
        // use the lower(serial_number) index from migration 0004).
        if (PART_CI_FILTER_COLS.has(key)) {
          const lowered = vals.map((v: string) => v.toLowerCase());
          q = isMulti(lowered)
            ? q.where(sql<boolean>`lower(${col(key)}) = any(${lowered})`)
            : q.where(sql<boolean>`lower(${col(key)}) = lower(${lowered[0]!})`);
        } else {
          // Single values keep the plain equality so an index still applies.
          q = isMulti(vals)
            ? q.where(sql<boolean>`${col(key)} = any(${vals})`)
            : q.where(sql<boolean>`${col(key)} = ${vals[0]!}`);
        }
        continue;
      }
      // D8: unknown filter key — assume it's a metadata field.
      // Postgres ->> returns text; values are compared as text, since JSON
      // values are stored in their JSON form (numbers come back as text).
      q = isMulti(vals)
        ? q.where(sql<boolean>`${meta} ->> ${key} = any(${vals})`)
        : q.where(sql<boolean>`${meta} ->> ${key} = ${vals[0]!}`);
    }
  }
  // D10: comparison predicates. Native numeric/date columns, OR a custom
  // numeric metadata field (a yarn instance's "remaining", a spool's qty) via
  // a guarded cast, OR a custom date field against a day ("today" is the
  // reader's). What cannot run is reported through opts.unapplied, never
  // dropped in silence.
  if (query.where) {
    const COMPARABLE = columnSet<InventoryDB["inventory_parts"]>()(["qty", "min_qty", "cost", "created_at", "updated_at"]);
    const skip = (p: FilterPredicate) => opts.unapplied?.push(p);
    // The text columns a "contains" reads natively; any other name is a custom
    // field, read from metadata (bound as a parameter, never spliced).
    const TEXT = columnSet<InventoryDB["inventory_parts"]>()(["name", "description", "manufacturer", "notes", "serial_number", "model_number", "assigned_to", "warranty_details", "supplier_url"]);
    for (const p of query.where) {
      if (isTextWhereOp(p.op)) {
        // Case-insensitive, and what the person typed is matched literally:
        // containsPattern escapes % and _ (#6896). "Does not contain" keeps a
        // row with no value, which does not contain the text either.
        const pattern = p.ref_col ? null : containsPattern(p.value);
        if (!pattern) {
          skip(p);
          continue;
        }
        const value = TEXT.has(p.col) ? sql`${col(p.col)}` : sql`${meta} ->> ${p.col}`;
        q = q.where(
          p.op === "contains"
            ? sql<boolean>`${value} ILIKE ${pattern} ESCAPE '\\'`
            : sql<boolean>`coalesce(${value}, '') NOT ILIKE ${pattern} ESCAPE '\\'`,
        );
        continue;
      }
      if (!["<", "<=", ">", ">=", "=", "!="].includes(p.op)) {
        skip(p);
        continue;
      }
      const nativeCol = COMPARABLE.has(p.col);
      if (p.ref_col) {
        // Column-to-column comparisons stay native-only.
        if (!nativeCol || !COMPARABLE.has(p.ref_col)) {
          skip(p);
          continue;
        }
        q = q.where(sql<boolean>`${col(p.col)} ${sql.raw(p.op)} ${col(p.ref_col)}`);
      } else if (p.value !== undefined) {
        if (nativeCol) {
          const v = p.value === "now" ? sql<unknown>`now()` : sql<unknown>`${p.value}`;
          q = q.where(sql<boolean>`${col(p.col)} ${sql.raw(p.op)} ${v}`);
        } else if (
          typeof p.value === "number" ||
          (typeof p.value === "string" && /^-?[0-9]+(\.[0-9]+)?$/.test(p.value))
        ) {
          // Custom numeric metadata field: a number, a measured value, or the
          // reading of a text value ("100nF"). A row whose value is none of
          // those (a word) is excluded, not an error. p.col is bound as a
          // parameter (no injection); the op is whitelisted above.
          const num = Number(p.value);
          q = q.where(sql<boolean>`${measuredValueSql(t, p.col)} ${sql.raw(p.op)} ${num}`);
        } else if (typeof p.value === "string" && !DAY.test(p.value) && parseMeasure(p.value)) {
          // A measured value ("10k", "100 nF"): compared EXACTLY by value, in
          // the SI number every door stores ("at least 1 µF" is >= 1e-6).
          const num = parseMeasure(p.value)!.value;
          q = q.where(sql<boolean>`${measuredValueSql(t, p.col)} ${sql.raw(p.op)} ${num}`);
        } else if (p.value === "today" || p.value === "now" || (typeof p.value === "string" && DAY.test(p.value))) {
          // A custom DATE field against a day: the reader's for "today" (the
          // client's, else the person's), else the literal. Compared as a
          // day, on the value's first ten characters, and only for rows
          // whose value IS a day: a row with no date, or a word, is not in
          // a window, never an error.
          const day = p.value === "today" || p.value === "now" ? (query.today && DAY.test(query.today) ? query.today : arrivedEverywhere(new Date())) : p.value;
          q = q.where(
            sql<boolean>`(${meta}->>${p.col}) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' AND left(${meta}->>${p.col}, 10) ${sql.raw(p.op)} ${day}`,
          );
        } else {
          skip(p);
        }
      } else {
        skip(p);
      }
    }
  }
  return q as Q;
}

/** Apply a sort spec (`["-expires_on", "name"]`). Native columns order
 *  directly. Any other name is one of the table's own fields and orders by
 *  its metadata value: a JSON number numerically, anything else as text (an
 *  ISO date sorts correctly as text), and a record with no value last, so a
 *  paprika with no expiry never leads a list of things that are about to go
 *  off. Falls back to name when the spec names nothing usable. */
export function applyPartSort<Q extends PartsQuery>(qIn: Q, sort: string[] | undefined, opts: PartQueryOpts = {}): Q {
  let q: PartsQuery = qIn;
  const t = opts.table ?? "inventory_parts";
  const meta = sql.ref(`${t}.metadata`);
  const native = parseSort(sort, NATIVE_SORTABLE);
  const own = (sort ?? [])
    .map((s) => s.trim())
    .filter((s) => s && !NATIVE_SORTABLE.has(s.replace(/^-/, "")))
    .map((s) => ({ col: s.replace(/^-/, ""), dir: s.startsWith("-") ? ("desc" as const) : ("asc" as const) }));
  if (native.length === 0 && own.length === 0) return q.orderBy(sql.ref(`${t}.name`), "asc") as Q;
  // Keep the spec's own order across the two kinds of column.
  for (const raw of sort ?? []) {
    const s = raw.trim();
    if (!s) continue;
    const col = s.replace(/^-/, "");
    const dir = s.startsWith("-") ? "desc" : "asc";
    if (NATIVE_SORTABLE.has(col)) {
      q = q.orderBy(sql.ref(`${t}.${col}`), dir);
    } else if (own.some((o) => o.col === col)) {
      // NULLS LAST in both directions: an unset field is "no answer", not the
      // smallest or largest one.
      // A number orders numerically, and so does a measured value or the
      // reading of a text one: 100 nF before 1 µF, not "1µF" before "100nF".
      q = q
        .orderBy(measuredValueSql(t, col), sql.raw(`${dir} nulls last`))
        .orderBy(sql`${meta} ->> ${col}`, sql.raw(`${dir} nulls last`));
    }
  }
  return q as Q;
}
