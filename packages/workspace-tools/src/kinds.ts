// Entity-kind plumbing shared by the tools: fetch the workspace's kinds and
// resolve which REST route creates/updates/deletes a given kind. Manifest
// declarations (createEndpoint / updateEndpoint / deleteEndpoint, stored in
// entity_kinds.endpoints by registry-sync) are the source of truth; the pinned
// map covers kinds that predate the declaration. NO guessing from getEndpoint —
// a kind with no declared route is honestly not writable this way, instead of
// being advertised and 404ing at execute time.

// VOCAB-ENUMERATION OK: fieldsByRole maps the roles a tool takes values by (VALUE_ROLES) to the field that plays each one
import type { WorkspaceApi } from "./api.js";

export interface KindRec {
  /** The kind's read allowlist; null means everything declared is readable. */
  exposable_fields?: string[] | null;
  id: string;
  display_name?: string;
  display_name_plural?: string | null;
  module_name?: string;
  endpoints?: { get?: string; list?: string; create?: string; update?: string; delete?: string } | null;
  /** Whether the asker may delete a record of this kind (the kind's own rule). */
  can_delete?: boolean;
  /** When they may not: the sentence the delete would be refused with. */
  delete_refused?: string;
  /** Set on registry records synthesized for a workspace's named instances
   *  (`<instance>:item`): endpoints are then relative to
   *  /instances/<instance_name>, not /modules/<module_name>. */
  instance_name?: string;
  fields?: Array<{ name: string; type?: string; role?: string; /** What the value means (a role from FIELD_ROLE_VALUES). */ fieldRole?: string; required?: boolean; readOnly?: boolean; choices?: string[]; /** This workspace's word for it, when it relabels the field ("cost" shows as "Paid"). */ label?: string; /** Money, and how the column holds it. */ money?: "cents" | "amount" }>;
  /** What "the same place" means for this kind when looking for duplicates:
   *  a field name, or "workspace". Absent = this kind is never deduplicated. */
  duplicate_scope?: string | null;
  /** The field that says how many things one record stands for (a record of
   *  five identical machines, a part's stock). Absent = one record, one thing. */
  count_field?: string | null;
  /** This workspace's user-defined fields (module_field_defs). Values live in
   *  the record's metadata blob, and these names are directly settable on
   *  create/update. A name that is neither these nor `fields` is refused. */
  custom_fields?: Array<{
    name: string;
    label?: string;
    type?: string;
    required?: boolean;
    choices?: string[];
    /** What the field means, as its form explains it. */
    help?: string;
    /** Set when the field is workspace-wide (every physical thing, say)
     *  rather than defined on this kind alone. */
    scope?: string;
    /** A number's unit ("mm", "USD"): a currency unit makes it money. */
    unit?: string | null;
    /** What the field means ("acquired-for" is money). */
    field_role?: string | null;
    /** A list that takes a new value, rather than only its own choices. */
    learns?: boolean;
  }>;
}

/** Kinds whose create route predates the manifest `createEndpoint` declaration.
 *  Frozen — declare `createEndpoint` on the kind instead of adding rows.
 *  Values are ROOT-PREFIXED org-relative paths (like every resolver below):
 *  "modules/…" for manifest kinds, "instances/…" for synthesized ones. */
export const LEGACY_CREATE_PATHS: Record<string, string> = {
  "inventory:part": "modules/inventory/parts",
  "machines:machine": "modules/machines/machines",
  "assets:asset": "modules/assets/assets",
  "projects:project": "modules/projects/projects",
  "projects:task": "modules/projects/tasks",
  "lists:list": "modules/lists/lists",
  "lists:item": "modules/lists/items",
};

/** The org-relative ROOT for a kind's endpoints: a synthesized instance kind
 *  lives under /instances/<name>, everything else under /modules/<module>. */
function rootOf(rec: KindRec): string | null {
  if (rec.instance_name) return `instances/${rec.instance_name}`;
  return rec.module_name ? `modules/${rec.module_name}` : null;
}

export async function fetchKinds(api: WorkspaceApi): Promise<KindRec[]> {
  // include=custom_fields: older cores ignore the unknown param and return the
  // same payload without the extra key, so this degrades cleanly.
  const res = await api.request("GET", "/entity-kinds?include=custom_fields");
  return ((res.body.items as KindRec[] | undefined) ?? []).filter((k) => !!k.id);
}

/** Org-relative POST path ("modules/…" | "instances/…") that creates one
 *  record of `kind`, or null. */
export function resolveCreatePath(kind: string, kinds: KindRec[]): string | null {
  const rec = kinds.find((k) => k.id === kind);
  const create = rec?.endpoints?.create;
  const root = rec ? rootOf(rec) : null;
  if (root && create) return `${root}/${create.replace(/^\//, "")}`;
  return kind in LEGACY_CREATE_PATHS ? LEGACY_CREATE_PATHS[kind]! : null;
}

/** Org-relative PATCH path for one record ({id} substituted), or null when
 *  the kind declares no update route. */
export function resolveUpdatePath(kind: string, id: string, kinds: KindRec[]): string | null {
  return resolveIdPath(kind, id, kinds, "update");
}

/** Org-relative DELETE path for one record, or null. */
export function resolveDeletePath(kind: string, id: string, kinds: KindRec[]): string | null {
  return resolveIdPath(kind, id, kinds, "delete");
}

function resolveIdPath(kind: string, id: string, kinds: KindRec[], which: "update" | "delete"): string | null {
  const rec = kinds.find((k) => k.id === kind);
  const tmpl = rec?.endpoints?.[which];
  const root = rec ? rootOf(rec) : null;
  if (!root || !tmpl) return null;
  return `${root}/${tmpl.replace(/^\//, "").replace("{id}", encodeURIComponent(id))}`;
}

/** Declared fields the read projection strips, as the summary carries them. */
function hiddenFieldsOf(k: KindRec): { hidden_fields?: string[]; hidden_fields_note?: string } {
  if (!Array.isArray(k.exposable_fields)) return {};
  const allowed = new Set([...k.exposable_fields, "id", "name", "instance"]);
  const hidden = (k.fields ?? []).map((f) => f.name).filter((n) => !allowed.has(n));
  return hidden.length
    ? { hidden_fields: hidden, hidden_fields_note: "these exist on the record but are not readable through this tool; say so rather than answering none" }
    : {};
}

/** A compact, model-facing summary of one kind. */
export function summarizeKind(k: KindRec): Record<string, unknown> {
  return {
    id: k.id,
    name: k.display_name ?? k.id,
    module: k.module_name,
    // Server-owned fields are described as READ-ONLY rather than dropped: the
    // model still needs to know `position` exists to talk about ordering, it
    // just must not try to set it. Offering them plainly is what got twelve
    // racks "reordered" with every call returning 200 and nothing moving.
    fields: (k.fields ?? []).map((f) => ({
      name: f.name,
      type: f.type ?? "text",
      ...(f.readOnly ? { read_only: true } : {}),
      ...(f.required || f.role === "title" ? { required: true } : {}),
      ...(f.role ? { role: f.role } : {}),
      // A native field's fixed values, the way a custom dropdown's show.
      ...(f.choices?.length ? { choices: f.choices } : {}),
    })),
    // User-defined fields — settable like native ones (values land in the
    // record's metadata; a name the kind does not have is refused on write).
    ...(k.custom_fields?.length
      ? {
          custom_fields: k.custom_fields.map((f) => ({
            name: f.name,
            ...(f.label && f.label !== f.name ? { label: f.label } : {}),
            type: f.type ?? "text",
            ...(f.required ? { required: true } : {}),
            ...(f.choices?.length ? { choices: f.choices } : {}),
            // What the value IS (its role): add_thing and
            // update_record take values by this role as well as by name.
            ...(f.field_role ? { role: f.field_role } : {}),
            // Closed unless it learns: on a closed list send one of its
            // choices, spelled the list's way.
            ...(f.choices?.length ? { list: f.learns ? "takes new values" : "only these choices" } : {}),
            ...(f.scope ? { scope: f.scope } : {}),
          })),
        }
      : {}),
    // Declared fields the read projection strips: the model must know they
    // exist and are hidden, or it calls their absence "none".
    ...hiddenFieldsOf(k),
    can_create: null as boolean | null, // filled by the tool with full kind context
    can_update: !!k.endpoints?.update,
    can_delete: k.can_delete ?? !!k.endpoints?.delete,
  };
}

// ── What this kind calls its title ──────────────────────────────────────────
//
// Grace asked Cobb to save a crochet pattern. He proposed it, she confirmed,
// and got "✕ HTTP 400" twice. The call was well formed; it used the wrong WORD.
// A "designs:item" (an inventory instance) calls its title `name`, the model
// sent `title`, and the API — correctly — refused a body with no `name`.
//
// The tool description already says "use the kind's EXACT field names", which
// is a rule enforced by hoping. Every kind DECLARES which of its fields is the
// title (`role: "title"`), so the answer is knowable rather than guessable: if
// the model reached for a title-ish word this kind does not have, and the field
// this kind DOES call its title is missing, that is not a different value — it
// is the same value under the name the model happened to pick.
//
// Deliberately narrow. Only the words that unambiguously mean "what this thing
// is called", only when the kind's real title field is absent (never
// overwriting a title the model got right), and only when the word the model
// used is not itself a declared field of this kind (a `label` that means
// something specific to a module stays untouched).

// `filename` and `subject` come from the autopilot's take on this (PR #2126),
// which had the wider list: a files kind really does call its title
// `filename`, and a message-ish one `subject`.
const TITLE_WORDS = ["title", "name", "label", "filename", "subject"] as const;

/** The field this kind calls its title, from its manifest. */
export function titleFieldOf(kind: string, kinds: KindRec[]): string | null {
  const rec = kinds.find((k) => k.id === kind);
  const declared = rec?.fields ?? [];
  return declared.find((f) => f.role === "title")?.name ?? null;
}

/** Fields with a title-ish key moved to the name this kind actually uses.
 *  Returns the fields unchanged when there is nothing to fix. */
export function withKindsTitleField(
  kind: string,
  kinds: KindRec[],
  fields: Record<string, unknown>,
): { fields: Record<string, unknown>; movedFrom?: string } {
  const target = titleFieldOf(kind, kinds);
  if (!target) return { fields };
  const has = (k: string) => typeof fields[k] === "string" && String(fields[k]).trim() !== "";
  if (has(target)) return { fields };
  const declared = new Set((kinds.find((k) => k.id === kind)?.fields ?? []).map((f) => f.name));
  const wrong = TITLE_WORDS.find((w) => w !== target && has(w) && !declared.has(w));
  if (!wrong) return { fields };
  const { [wrong]: value, ...rest } = fields;
  return { fields: { ...rest, [target]: value }, movedFrom: wrong };
}

/** The roles a value may be said by instead of a field's name: where a thing
 *  was bought, who sold it, when and for how much (arrivals.md §2). */
export const VALUE_ROLES = ["acquired-from", "seller", "acquired-on", "acquired-for"] as const;

const ROLE_NAMES: Record<(typeof VALUE_ROLES)[number], RegExp> = {
  "acquired-from": /^(acquired_from|purchased_from|bought_from|source)$/i,
  seller: /^(seller|sold_by)$/i,
  "acquired-on": /^(acquired_on|purchase_date|purchased_on|date_acquired)$/i,
  "acquired-for": /^(acquired_for|purchase_price|price_paid|paid|cost)$/i,
};

/**
 * Values said by role, as the kind's own field names: the field that declares
 * the role (custom or native), else the one named for it. Who sold it, on a
 * kind with no seller field, goes beside where it was bought as that field's
 * note ("eBay · detroitaxle"). What has no home is refused with the reason,
 * never dropped (#4537).
 */
export function fieldsByRole(
  kind: string,
  kinds: KindRec[],
  roles: Record<string, unknown>,
): { fields: Record<string, unknown>; refused: Array<{ name: string; reason: string }> } {
  const rec = kinds.find((k) => k.id === kind);
  const all = [
    ...(rec?.custom_fields ?? []).map((f) => ({ name: f.name, role: f.field_role ?? null })),
    ...(rec?.fields ?? []).filter((f) => !f.readOnly).map((f) => ({ name: f.name, role: f.fieldRole ?? null })),
  ];
  const home = (role: (typeof VALUE_ROLES)[number]) => all.find((f) => f.role === role)?.name ?? all.find((f) => ROLE_NAMES[role].test(f.name))?.name ?? null;
  const fields: Record<string, unknown> = {};
  const refused: Array<{ name: string; reason: string }> = [];
  const label = rec?.display_name ?? kind;
  for (const [role, v] of Object.entries(roles)) {
    if (v === undefined || v === null || v === "") continue;
    if (!(VALUE_ROLES as readonly string[]).includes(role)) {
      refused.push({ name: role, reason: `not a role: say one of ${VALUE_ROLES.join(", ")}` });
      continue;
    }
    const name = home(role as (typeof VALUE_ROLES)[number]);
    if (name) {
      fields[name] = v;
      continue;
    }
    const from = role === "seller" ? home("acquired-from") : null;
    if (from) fields[`${from}_note`] = v;
    else refused.push({ name: role, reason: `${label} has no field for ${role.replace(/-/g, " ")}` });
  }
  return { fields, refused };
}
