// How a record's write reaches its `metadata` column: the kernel's rule for
// every module whose kinds keep custom-field values in a jsonb bag.
//
// Bundles declare custom fields on an entity kind (a set number, a theme, a
// year on an inventory part). The natural way to POST one is at the top level
// beside `name` and `qty`, but the kind's native columns are fixed by its
// migration, so anything not in that list has to land in `metadata`.
// routeUnknownToMetadata lifts those keys in; preserveServerManaged keeps a
// client from writing a field the server owns; coerceMetadata reads the bag
// back whether the driver handed over an object or the raw jsonb string.
//
// Six modules and two kernel files each carried their own copy, identical
// today and free to drift apart (#3499). They import these now.

import { isMaskedSecret, omitSecretValues } from "@cobblr/platform-contract/secret-field";
import { fieldKindOf } from "@cobblr/platform-contract/kind-label";
import { asMeasure } from "@cobblr/platform-contract/measure";
import { readMoney, parseMoney } from "@cobblr/platform-contract/money";
import { asAddress } from "@cobblr/platform-contract/address";
import { isListedChoice } from "@cobblr/platform-contract/field-vocabulary";
import { platform } from "@cobblr/platform-contract/platform-runtime";
import { castFieldValues } from "@cobblr/platform-contract/field-values";

export function routeUnknownToMetadata<T extends Record<string, unknown>>(
  body: unknown,
  nativeKeys: ReadonlySet<string>,
): T {
  if (!body || typeof body !== "object") return body as T;
  const src = body as Record<string, unknown>;
  // Any caller-provided metadata wins for collisions — we only ADD
  // top-level unknown keys, never overwrite explicit metadata values.
  const callerMetadata =
    src.metadata && typeof src.metadata === "object"
      ? (src.metadata as Record<string, unknown>)
      : {};
  const promoted: Record<string, unknown> = { ...callerMetadata };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === "metadata") continue;
    if (nativeKeys.has(k)) {
      out[k] = v;
    } else {
      // Don't clobber an explicit metadata.key set by the caller.
      if (!(k in promoted)) promoted[k] = v;
    }
  }
  // Only attach metadata if something's there — otherwise leave the
  // body alone so optional-metadata schemas don't get an empty obj.
  if (Object.keys(promoted).length > 0) out.metadata = promoted;
  return out as T;
}

/** A record UPDATE's `.set()` object with its `metadata` written as THE
 *  merge (#3625): the keys the caller sent are set, a null removes its key,
 *  every other key stays as the live row holds it, in one statement
 *  (platform().db.mergeJsonb). A server-managed key the caller sent is
 *  dropped rather than written. Every entity PATCH wraps its set in this;
 *  writing the object itself replaced the whole bag, so three quick edits to
 *  one item kept only the last and lost the other two with a 200 each. */
export function withMetadataMerged<T extends Record<string, unknown>>(set: T, serverManaged: readonly string[] = [], column = "metadata"): T {
  const incoming = set[column];
  if (incoming === undefined) return set;
  if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) {
    const { [column]: _dropped, ...rest } = set;
    return rest as T;
  }
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) if (!serverManaged.includes(k)) fields[k] = v;
  if (Object.keys(fields).length === 0) {
    const { [column]: _dropped, ...rest } = set;
    return rest as T;
  }
  return { ...set, [column]: platform().db.mergeJsonb(column, fields) } as T;
}

/** Preserve SERVER-MANAGED metadata keys across a client write. Custom-field
 *  values live in the `metadata` jsonb column, written wholesale (the client
 *  does read-modify-write). A server_managed field (e.g. core-mobility's
 *  `away_since`) is owned by the server — a client's value must never take.
 *  So for each managed key: re-inject the STORED value if there is one, else
 *  drop the client's attempt. Only acts when the client actually sent metadata
 *  and the kind has managed fields (`names` from
 *  platform().entities.serverManagedFields). */
export function preserveServerManaged(
  incoming: Record<string, unknown> | undefined,
  current: Record<string, unknown> | undefined,
  names: readonly string[],
): Record<string, unknown> | undefined {
  if (names.length === 0 || incoming === undefined) return incoming;
  const out = { ...incoming };
  for (const n of names) {
    if (current && n in current) out[n] = current[n];
    else delete out[n];
  }
  return out;
}

/** Normalise a jsonb `metadata` value (object, raw string, or null) to a plain
 *  object so custom keys are reachable for the before/after event bag. */
export function coerceMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return { ...(raw as Record<string, unknown>) };
  if (typeof raw === "string" && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === "object") return p as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return {};
}

/** What a template reading a record sees: its native fields at the top level
 *  and its custom-field values beside them, the way a person names them
 *  (`{{author}}`, not `{{metadata.author}}`). Custom values win a collision,
 *  since that is where authored values sit, and `metadata` stays reachable
 *  for a template that names it.
 *
 *  One rule for every surface that renders a record into text: a computed
 *  field, a label, a wire's arguments. The label and wire doors read only the
 *  native fields, so every shipped label that named a bundle's field printed
 *  its placeholder ("Unknown / Effective Java / ?", #3591). */
export function templateDataOf(fields: Record<string, unknown>): Record<string, unknown> {
  const safe = omitSecretValues(fields) as Record<string, unknown>;
  return { ...safe, ...coerceMetadata(safe.metadata) };
}

/** Props on a resolved record that every reader sees whatever the kind's
 *  `exposableFields` say: the ones every renderer needs to show "the entity"
 *  generically. In the contract because two sides must agree on it: the
 *  kernel's projection keeps them, and lint:template-fields-readable counts
 *  them as readable when it judges a bundle's template.
 *
 *  `instance` is the instances-system column (which named collection an item
 *  belongs to). Structural and not sensitive, so it is readable everywhere
 *  without every instanceable module having to list it. */
export const IMPLICIT_EXPOSABLE_PROPS: ReadonlySet<string> = new Set([
  "kind",
  "id",
  "title",
  "subtitle",
  "image_path",
  "detailUrl",
  "instance",
]);

// ── An unknown field is refused, not stored ─────────────────────────────────
//
// routeUnknownToMetadata lifts every key the module does not own into
// `metadata`, which is how a custom field written at the top level lands. It
// could not tell a custom field from a typo or an invented name, so
// `{seller: "…"}` on a printer returned 200 and stored a value no form will
// ever show (#3855). Before a write routes its body, it is checked against the
// fields that apply to the kind: the module's own columns, and every custom
// field the kind has, the workspace-wide class-scoped ones included. A key
// that is neither is refused, with the names it could have meant, on every
// write, REST included (the owner's call, 2026-09-28: D6 no longer hoists an
// undeclared key). An explicit `metadata: {…}` object is still written as
// given: that is deliberate bookkeeping, not a field someone mistyped.

export class UnknownFieldError extends Error {
  readonly status = 422;
  readonly code = "unknown_field";
  // Plain fields, not constructor parameter properties: this package is
  // loaded as TypeScript by Node's type stripping, which cannot run those.
  readonly kind: string;
  readonly unknown: string[];
  readonly valid: string[];
  readonly suggestions: Record<string, string>;
  constructor(kind: string, unknown: string[], valid: string[], suggestions: Record<string, string>) {
    const hints = unknown.map((u) => (suggestions[u] ? `"${u}" (did you mean "${suggestions[u]}"?)` : `"${u}"`));
    super(
      `${kind} has no field ${hints.join(", ")}. Fields you can set: ${valid.join(", ")}. ` +
        "Add the field first if it is new, or send bookkeeping inside `metadata`.",
    );
    this.kind = kind;
    this.unknown = unknown;
    this.valid = valid;
    this.suggestions = suggestions;
  }
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        details: { kind: this.kind, unknown: this.unknown, valid: this.valid, suggestions: this.suggestions },
      },
    };
  }
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}

const SERVED_READ_ONLY = new Set(["title"]);

/** Pure half: the keys a body carries that are neither native nor a field. */
export function unknownFieldsOf(
  body: unknown,
  nativeKeys: ReadonlySet<string>,
  fieldNames: readonly string[],
): { unknown: string[]; suggestions: Record<string, string> } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { unknown: [], suggestions: {} };
  const known = new Set(fieldNames);
  // A choice field's one-off clarifier travels beside it as `<field>_note`
  // (platform-web field-note.ts): known whenever its field is.
  const isNote = (k: string) => k.endsWith("_note") && known.has(k.slice(0, -"_note".length));
  // What the platform SERVES beside a record and never stores: the composed
  // title (served-title.ts) and a person or relation field's resolved label.
  // A client writing the served row back unchanged sends them; they are not
  // a mistake, and the write paths already leave them out.
  const isServed = (k: string) =>
    SERVED_READ_ONLY.has(k) || (k.endsWith("_label") && known.has(k.slice(0, -"_label".length)));
  const unknown = Object.keys(body).filter(
    (k) => k !== "metadata" && !nativeKeys.has(k) && !known.has(k) && !isNote(k) && !isServed(k),
  );
  const pool = [...new Set([...fieldNames, ...nativeKeys])];
  const suggestions: Record<string, string> = {};
  for (const u of unknown) {
    let best: string | null = null;
    let bestD = Infinity;
    for (const c of pool) {
      const dd = distance(u.toLowerCase(), c.toLowerCase());
      if (dd < bestD) {
        bestD = dd;
        best = c;
      }
    }
    if (best && bestD <= Math.max(2, Math.floor(u.length / 3))) suggestions[u] = best;
  }
  return { unknown, suggestions };
}

// What a write may do to a custom field's value.
//
// A required field, once filled, is never emptied: a write that sends it blank
// is refused, whichever door it came through. A create may leave one empty
// (capture comes before structure: a scan or "add a part called X" is never
// refused for it), and the list says how many records still need a value.
//
// A value that does not fit its field's type is NOT refused here. Capture
// keeps what it read: a best-before printed "see lid", a pattern's source
// stamped by the assistant, a category a scan named that is not in the list
// yet. The product surfaces those for a person to fix (the dashboard names an
// unreadable date; a dropdown shows an unlisted value) rather than losing
// them at the door. problemWith is the one reading of "fits", used to tell a
// person which stored values would not fit a field's new type.

export interface FieldValueProblem {
  field: string;
  value: unknown;
  /** What the field takes, in words: "one of: small, large", "a number". */
  expected: string;
  code: "not_a_choice" | "not_a_number" | "not_a_yes_no" | "not_a_date" | "not_a_measure" | "not_an_address" | "required_field" | "not_a_secret" | "full_card_number";
  choices?: string[];
}

export class InvalidFieldValueError extends Error {
  readonly status = 422;
  readonly code: string;
  readonly kind: string;
  readonly problems: FieldValueProblem[];
  constructor(kind: string, problems: FieldValueProblem[]) {
    super(
      problems
        .map((p) =>
          p.code === "full_card_number" ? `${p.field} takes a payment method and the last four digits only. Remove the full card number.` : p.code === "not_a_secret" ? `${p.field} takes a new text value or null.` : p.code === "required_field"
            ? `${p.field} is required, so it cannot be emptied.`
            : `${p.field} takes ${p.expected}, not ${JSON.stringify(p.value)}.${p.code === "not_a_choice" ? " Add it as a choice first if it should be one." : ""}`,
        )
        .join(" "),
    );
    this.kind = kind;
    this.problems = problems;
    this.code = problems.length === 1 ? problems[0]!.code : "invalid_field_value";
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, details: { kind: this.kind, problems: this.problems } } };
  }
}

export interface JudgedField {
  field_role?: string | null;
  name: string;
  type: string;
  choices?: string[] | null;
  required?: boolean;
  /** An open list (field-choices `choiceLearns`): a value off it fits. */
  learns?: boolean | null;
}

const BLANK = (v: unknown) => (isMaskedSecret(v) && !v.has_value) || v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0);
/** What "fits" means for a stored string, written once so the write-side
 *  reading (problemWith) and a SQL filter over stored rows (a list's "don't
 *  fit their field") cannot disagree. POSIX-compatible: the same text is a
 *  Postgres `~` pattern and a JS RegExp. A JSON number, boolean or array is
 *  judged by its type, not these. */
export const FIT_PATTERNS = {
  number: "^\\s*[-+]?([0-9]+[.]?[0-9]*|[.][0-9]+)([eE][-+]?[0-9]+)?\\s*$",
  date: "^\\s*[0-9]{4}(-[0-9]{2}(-[0-9]{2})?)?($|T)",
  yesNo: ["true", "false", "yes", "no", "1", "0"] as readonly string[],
} as const;
const NUMBER_RE = new RegExp(FIT_PATTERNS.number);
const DATE_RE = new RegExp(FIT_PATTERNS.date);
const YES_NO = new Set(FIT_PATTERNS.yesNo);

/** What is wrong with one stored value against its field, if anything. For
 *  a person reading the record ("this field takes a number"), never a gate
 *  on a write. */
export function fieldValueProblem(def: JudgedField, value: unknown): FieldValueProblem | null {
  return problemWith(def, value);
}

function problemWith(def: JudgedField, value: unknown): FieldValueProblem | null {
  if (BLANK(value)) return null;
  if (def.type === "text" && def.choices && def.choices.length > 0 && def.learns !== true) {
    const picked = Array.isArray(value) ? value : [value];
    const bad = picked.find((v) => !isListedChoice(v, def.choices!));
    return bad === undefined
      ? null
      : { field: def.name, value, expected: `one of: ${def.choices.join(", ")}`, code: "not_a_choice", choices: def.choices };
  }
  if (def.type === "number") {
    const fits = typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && NUMBER_RE.test(value);
    return fits ? null : { field: def.name, value, expected: "a number", code: "not_a_number" };
  }
  if (def.type === "boolean") {
    return typeof value === "boolean" || (typeof value === "string" && YES_NO.has(value.trim().toLowerCase())) || value === 1 || value === 0
      ? null
      : { field: def.name, value, expected: "yes or no", code: "not_a_yes_no" };
  }
  if (def.type === "money") {
    return readMoney(value) !== null || parseMoney(value) !== null
      ? null
      : { field: def.name, value, expected: "an amount, like 4,300 or 12.50", code: "not_a_number" };
  }
  if (def.type === "measure") {
    // A measured value as stored, or text that still reads as one ("4k7").
    return asMeasure(value) ? null : { field: def.name, value, expected: "a measured value, like 4k7 or 100 nF", code: "not_a_measure" };
  }
  if (def.type === "address") {
    return asAddress(value) ? null : { field: def.name, value, expected: "an address, like 8 Mill St, Lodi, NJ", code: "not_an_address" };
  }
  if (def.type === "date") {
    // A day, or a month or a year as printed (the write doors store a month
    // as its last day); anything else is a date nobody can read.
    return typeof value === "string" && DATE_RE.test(value)
      ? null
      : { field: def.name, value, expected: "a date", code: "not_a_date" };
  }
  return null;
}

/** Would this value fit a field of this type (and these choices)? For a
 *  person deciding on a field's new type, not a gate on writes. */
export function valueFitsField(def: JudgedField, value: unknown): boolean {
  return problemWith(def, value) === null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Pure half: what is wrong with the custom-field values a write sets.
 *  `stored` is the record's current values (null on a create). */
export function fieldValueProblemsOf(
  body: unknown,
  defs: readonly JudgedField[],
  stored: Record<string, unknown> | null,
): FieldValueProblem[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const b = body as Record<string, unknown>;
  const bag = b.metadata && typeof b.metadata === "object" && !Array.isArray(b.metadata) ? (b.metadata as Record<string, unknown>) : null;
  const storedBag =
    stored?.metadata && typeof stored.metadata === "object" && !Array.isArray(stored.metadata) ? (stored.metadata as Record<string, unknown>) : null;
  const out: FieldValueProblem[] = [];
  for (const def of defs) {
    const written: unknown[] = [];
    if (Object.prototype.hasOwnProperty.call(b, def.name)) written.push(b[def.name]);
    if (bag && Object.prototype.hasOwnProperty.call(bag, def.name)) written.push(bag[def.name]);
    if (written.length === 0) continue;
    const before = storedBag && def.name in storedBag ? storedBag[def.name] : stored?.[def.name];
    for (const v of written) {
      if (def.field_role === "payment-method" && typeof v === "string" && /(?:[0-9][ -]*){13,}/.test(v)) {
        out.push({ field: def.name, value: undefined, expected: "a payment method and the last four digits only", code: "full_card_number" });
        continue;
      }
      if (def.type === "secret" && isMaskedSecret(v)) continue;
      if (def.type === "secret" && v !== null && v !== undefined && typeof v !== "string") {
        out.push({ field: def.name, value: undefined, expected: "a new text value or null", code: "not_a_secret" });
        continue;
      }
      if (stored && same(v, before)) continue;
      if (stored && def.required && BLANK(v) && !BLANK(before)) {
        out.push({ field: def.name, value: v, expected: "a value", code: "required_field" });
        continue;
      }
    }
  }
  return out;
}

/** Throws UnknownFieldError when a write names a field the kind does not
 *  have. `baseKind` is the module's own kind; a collection's item route
 *  (req.instance) checks against `<instance>:item`, whose fields those are. */
export async function refuseUnknownFields(req: unknown, body: unknown, nativeKeys: ReadonlySet<string>, baseKind: string): Promise<void> {
  const r = req as { tenant?: { org?: { id?: string } }; instance?: string; query?: Record<string, unknown> };
  const orgId = r.tenant?.org?.id;
  if (!orgId) return;
  const kind = fieldKindOf({ kind: baseKind, instance: r.instance });
  const q = req as { method?: string; params?: Record<string, string> };
  const id = q.params?.id;
  const updating = (q.method === "PATCH" || q.method === "PUT") && !!id;
  await refuseUnknownFieldsOf(orgId, kind, body, nativeKeys, updating ? id : undefined);
}

/** The same check without a request: `kind` is the field kind (a
 *  collection's `<instance>:item`), `updatingId` the record being edited, if
 *  any. A write that has no HTTP request (platform:update-fields) asks here. */
export async function refuseUnknownFieldsOf(orgId: string, kind: string, body: unknown, nativeKeys: ReadonlySet<string>, updatingId?: string): Promise<void> {
  const defs = await platform().entities.fieldsFor(orgId, kind);
  const names = defs.map((f) => f.name);
  const { unknown, suggestions } = unknownFieldsOf(body, nativeKeys, names);
  if (unknown.length > 0) {
    const valid = [...new Set([...nativeKeys, ...names])].filter((n) => n !== "id" && n !== "metadata").sort();
    throw new UnknownFieldError(kind, unknown, valid, suggestions);
  }
  // Values: judged against what the record holds now, on an update.
  const judged = defs.filter((d) => d.type !== "computed" && !nativeKeys.has(d.name));
  const stored = updatingId && judged.length ? ((await platform().entities.lookup(orgId, kind, updatingId))?.fields ?? {}) : null;
  const problems = fieldValueProblemsOf(body, judged, stored);
  if (problems.length > 0) throw new InvalidFieldValueError(kind, problems);
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const safe = await platform().entities.sealSecretFields(orgId, kind, body as Record<string, unknown>, updatingId);
    if (safe === body) return;
    for (const key of Object.keys(body)) delete (body as Record<string, unknown>)[key];
    Object.assign(body, safe);
  }
}

/** Split the fields of an edit into the kind's own columns and its custom
 *  fields: unknown names refused, values judged against the record as it is,
 *  secrets sealed, custom values cast to their type. The shape every module's
 *  updater needs before it writes. */
export async function splitFieldsForUpdate(
  orgId: string,
  kind: string,
  id: string,
  fields: Record<string, unknown>,
  nativeKeys: ReadonlySet<string>,
): Promise<{ native: Record<string, unknown>; custom: Record<string, unknown> }> {
  const body: Record<string, unknown> = { ...fields };
  await refuseUnknownFieldsOf(orgId, kind, body, nativeKeys, id);
  const routed = routeUnknownToMetadata<Record<string, unknown>>(body, nativeKeys);
  const { metadata, ...native } = routed;
  const bag = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
  const smNames = await platform().entities.serverManagedFields(orgId, kind);
  const kept = Object.fromEntries(Object.entries(bag).filter(([k]) => !smNames.includes(k)));
  const custom = Object.keys(kept).length ? castFieldValues(await platform().entities.fieldsFor(orgId, kind), kept) : kept;
  return { native, custom };
}
