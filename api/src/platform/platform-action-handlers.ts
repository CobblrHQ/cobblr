// Handlers for the kernel's own actions (platform-actions.ts) — wired at boot,
// before registry-sync, so an action is never listed without its handler.
//
// Each handler is a THIN translation layer over the same service its HTTP
// route calls (createFieldDef / provisionInstance / setWireEnabled), so a rule
// cannot mean one thing when a person changes the workspace and another when
// the assistant does. What lives here is only what a model needs that a form
// does not: turning the words a model actually sends into the shapes the
// services require ("Purchase Date" → purchase_date, "dropdown" → text with
// choices), and refusing with a sentence instead of a zod issue list.

import { isFieldScope, pluralise, readListArg, type ActionInvokeContext } from "@cobblr/platform-contract";
import { matchByLabel, splitNames } from "@cobblr/platform-contract/said-names";
import { disableModuleForOrg, enableModuleForOrg } from "../modules/enable.js";
import { listEntries } from "../modules/registry.js";
import { meta } from "../db/meta.js";
import { registerHandler, registerPlanner, registerUndo } from "./actions.js";
import { getMover, instancesHolding, moveRecords } from "./move-records.js";
import * as activity from "./activity.js";
import { upsertNativeFieldOverride } from "./native-field-overrides.js";
import { USER_SOURCE, recordClaim } from "./bundle-claims.js";
import { listKindsForOrg, lookup } from "./entities.js";
import {
  FieldDefCreate,
  createFieldDef,
  deleteFieldDef,
  resolveFieldDefsForKind,
  updateFieldDef,
} from "./field-defs.js";
import { listOverrides, upsertOverride } from "./entity-kind-overrides.js";
import { FIELD_PRESETS } from "./field-presets.js";
import { turnPresetOff, turnPresetOn } from "./field-preset-switch.js";
import { groupFields, ungroupFields } from "./field-sections.js";
import { demoteInstance, promoteCategory } from "./instance-promote.js";
import { listInstances } from "./instances.js";
import { provisionInstance } from "./instances.js";
import { setWireEnabled } from "./wires.js";
import { decideApprovalRequest } from "./approvals.js";

/** A storage name from a label: "Purchase Date" → purchase_date. The def
 *  schema requires a leading letter, so a label like "3D printer count" gets a
 *  letter prefix rather than a refusal over a rule the user never typed. */
function fieldNameFromLabel(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z]/.test(slug) ? slug : slug ? `f_${slug}` : "";
}

/** An instance slug from a display name: "CNC Machines" → cnc-machines. */
function instanceSlugFromName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The words a model sends for a field type → the type the schema takes.
 *  Unmapped input falls through unchanged so a real type word still works and
 *  an unknown one is refused by the schema with the valid list. */
const FIELD_TYPE_WORDS: Record<string, { type: string; impliesChoices?: boolean }> = {
  text: { type: "text" },
  string: { type: "text" },
  dropdown: { type: "text", impliesChoices: true },
  choice: { type: "text", impliesChoices: true },
  select: { type: "text", impliesChoices: true },
  number: { type: "number" },
  qty: { type: "number" },
  quantity: { type: "number" },
  count: { type: "number" },
  checkbox: { type: "boolean" },
  toggle: { type: "boolean" },
  boolean: { type: "boolean" },
  date: { type: "date" },
  url: { type: "url" },
  link: { type: "url" },
  relation: { type: "relation" },
  member: { type: "member" },
  person: { type: "member" },
};

/** The workspace's override row for a field, as it stands: what an edit of
 *  the label, hidden, or choices is undone back to. */
async function readFieldOverride(
  orgId: string,
  entityKind: string,
  name: string,
): Promise<{ label: string | null; hidden: boolean; choices: string[] | null }> {
  const row = await meta
    .selectFrom("native_field_overrides")
    .select(["display_label", "hidden", "overrides"])
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", entityKind)
    .where("name", "=", name)
    .executeTakeFirst();
  const choices = (row?.overrides as { choices?: unknown } | null)?.choices;
  return {
    label: row?.display_label ?? null,
    hidden: row?.hidden ?? false,
    choices: Array.isArray(choices) ? choices.filter((c): c is string => typeof c === "string") : null,
  };
}

/** Grouping put back: every field to the heading it was under, the ones that
 *  were under none to the ungrouped list. One step per heading, in order. */
function fieldsBackWhereTheyWere(entityKind: string, before: Array<{ field: string; section: string | null }>): Array<{ action_id: string; args: Record<string, unknown> }> {
  const bySection = new Map<string | null, string[]>();
  for (const b of before) bySection.set(b.section, [...(bySection.get(b.section) ?? []), b.field]);
  const steps: Array<{ action_id: string; args: Record<string, unknown> }> = [];
  for (const [section, fields] of bySection) {
    steps.push(
      section === null
        ? { action_id: "platform:ungroup-fields", args: { entity_kind: entityKind, fields: fields.join(", ") } }
        : { action_id: "platform:group-fields", args: { entity_kind: entityKind, section, fields: fields.join(", ") } },
    );
  }
  return steps;
}

/** A dropdown's choices changed one at a time, the way a person says it:
 *  "remove Tea from the category choices", "add Aran to the yarn weights".
 *  `choices` REPLACES the list and asks the caller to know all of it, which
 *  the model did not: it ran the action with no list at all. add_choices and
 *  remove_choices work from what is there. Matching is by name, case aside;
 *  order is kept, a new choice goes at the end, one already there is not
 *  doubled, and a choice that is not there to remove is refused by name with
 *  the list, so the next sentence can be right. */
/** One or more names, however the caller sent them: "Tea, Coffee", or the
 *  JSON list the invoke tool says any value may be. A list used to read as
 *  no names at all, and the refusal for that ("nothing to change") sent the
 *  model round again (#3087). */
function namesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === "string" ? splitNames(x) : []));
  return splitNames(str(v));
}

function choicesEdited(
  current: string[] | null,
  args: Record<string, unknown>,
  fieldLabel: string,
): { choices: string[] } | { error: string } | undefined {
  const add = namesOf(args.add_choices);
  const remove = namesOf(args.remove_choices);
  if (add.length === 0 && remove.length === 0) return undefined;
  if (str(args.choices) || args.choices === null) {
    return { error: "pass either choices (the whole list) or add_choices / remove_choices, not both" };
  }
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  let next = [...(current ?? [])];
  for (const gone of remove) {
    // Matched the way a field is matched from what a person said: exact,
    // then case aside, then a unique prefix ("Tea" for "Teas"), and never a
    // guess between two.
    const hit = matchByLabel(gone, next.map((c) => ({ label: c })));
    if (!hit) {
      const have = next.length ? next.join(", ") : "none";
      return { error: `"${gone}" is not one of the choices of "${fieldLabel}" (${have})` };
    }
    if ("ambiguous" in hit) {
      return { error: `"${gone}" could be ${hit.ambiguous.map((a) => `"${a.label}"`).join(" or ")} on "${fieldLabel}" — which one?` };
    }
    next = next.filter((c) => c !== hit.label);
  }
  for (const more of add) if (!next.some((c) => same(c, more))) next.push(more);
  return { choices: next };
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function registerPlatformActionHandlers(): void {
  registerHandler("platform.add-field", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const entityKind = str(args.entity_kind);
    const displayLabel = str(args.display_label) || str(args.name);
    if (!entityKind || !displayLabel) {
      return { ok: false, error: "entity_kind and display_label are required" };
    }
    const typeWord = str(args.type).toLowerCase() || "text";
    const mapped = FIELD_TYPE_WORDS[typeWord] ?? { type: typeWord };
    const choices = str(args.choices)
      ? str(args.choices)
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean)
      : undefined;
    // The kind must exist (unless it's a trait scope like @physical, which the
    // service resolves itself) — a field on a kind nobody has saves fine and
    // then applies to nothing, a failure found much later.
    if (!isFieldScope(entityKind)) {
      const kinds = await listKindsForOrg(ctx.orgId);
      if (!kinds.some((k) => k.id === entityKind)) {
        return {
          ok: false,
          error: `this workspace has no "${entityKind}" to put a field on — check list_record_kinds (or use a trait scope like @physical)`,
        };
      }
    }
    const parsed = FieldDefCreate.safeParse({
      entity_kind: entityKind,
      name: str(args.name) ? fieldNameFromLabel(str(args.name)) : fieldNameFromLabel(displayLabel),
      display_label: displayLabel,
      type: mapped.type,
      ...(choices || mapped.impliesChoices ? { choices: choices ?? [] } : {}),
      ...(str(args.unit) ? { unit: str(args.unit) } : {}),
      ...(str(args.ref_kind) ? { ref_kind: str(args.ref_kind) } : {}),
    });
    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      };
    }
    if (mapped.impliesChoices && (!choices || choices.length === 0)) {
      return { ok: false, error: "a dropdown needs its choices — pass them comma-separated" };
    }
    const result = await createFieldDef(ctx.orgId, parsed.data);
    if (!result.ok) return { ok: false, error: result.message };
    return {
      ok: true,
      summary: `"${result.def.display_label}" (${result.def.type}) added to ${result.def.entity_kind}`,
      data: {
        id: result.def.id,
        entity_kind: result.def.entity_kind,
        name: result.def.name,
        type: result.def.type,
      },
    };
  });

  // Finding the field a person NAMED. They say "the Colour field", never a uuid,
  // and a def is addressable by two strings: the label on the form and the
  // storage name under it. Both are tried, and two candidates are never guessed
  // between — changing the wrong field is a change someone has to notice first.
  const findField = async (
    orgId: string,
    entityKind: string,
    said: string,
  ): Promise<{ id: string; name: string; label: string; scopeLabel: string | null } | { error: string }> => {
    const defs = await resolveFieldDefsForKind(orgId, entityKind);
    if (defs.length === 0) {
      return { error: `"${entityKind}" has no custom fields — check list_record_kinds for the kind id` };
    }
    const byName = defs.filter((d) => d.name === said.trim().toLowerCase());
    if (byName.length === 1) {
      return {
        id: byName[0]!.id,
        name: byName[0]!.name,
        label: byName[0]!.display_label,
        scopeLabel: byName[0]!.scope_label,
      };
    }
    const hit = matchByLabel(
      said,
      // A trait-scoped def is on every kind in its class, and its scope travels
      // with it: someone asking about "parts" must not be told, silently, that
      // the change also lands on everything else physical.
      defs.map((d) => ({ label: d.display_label, id: d.id, name: d.name, scopeLabel: d.scope_label })),
    );
    if (!hit) {
      return {
        error: `no field called "${said}" on ${entityKind}. It has: ${defs.map((d) => d.display_label).join(", ")}`,
      };
    }
    if ("ambiguous" in hit) {
      return { error: `"${said}" could be ${hit.ambiguous.map((a) => `"${a.label}"`).join(" or ")} — which one?` };
    }
    return hit;
  };

  /** A field that belongs to a CLASS of records, not the one kind that was
   *  named. Editing it from here would land on everything in that class while
   *  the sentence said "on parts", so it refuses and says where to look. The
   *  refusal is the feature: a quiet workspace-wide edit is found much later. */
  const scopeRefusal = (
    found: { label: string; scopeLabel: string | null },
    entityKind: string,
    verb: string,
  ): { ok: false; error: string } | null =>
    found.scopeLabel
      ? {
          ok: false,
          error:
            `"${found.label}" is not just ${entityKind}'s — it is on ${found.scopeLabel}, so a ` +
            `${verb} here would land on all of them. Do that one on the Fields screen.`,
        }
      : null;

  /** "serial_number" → "Serial number", "manufacturer" → "Manufacturer": a built-in field has no
   *  label of its own, the app humanises its name, so that is what a person
   *  reads and therefore what they say. */
  const humanise = (name: string): string =>
    name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

  /** A built-in field of this kind, matched by what it is called on screen —
   *  its workspace override if it has one, else the humanised name. Built-ins
   *  are not defs: they belong to the module, and what a workspace can change
   *  about them is the label, whether it shows, and a dropdown's choices. */
  const findNativeField = async (
    orgId: string,
    entityKind: string,
    said: string,
  ): Promise<{ name: string; label: string } | null> => {
    const kinds = await listKindsForOrg(orgId);
    const kind = kinds.find((k) => k.id === entityKind);
    if (!kind) return null;
    const overrides = await meta
      .selectFrom("native_field_overrides")
      .select(["name", "display_label"])
      .where("org_id", "=", orgId)
      .where("entity_kind", "=", entityKind)
      .execute();
    const candidates = kind.fields
      .filter((f) => !f.readOnly)
      .map((f) => ({
        name: f.name,
        label: overrides.find((o) => o.name === f.name)?.display_label ?? humanise(f.name),
      }));
    const byName = candidates.filter((c) => c.name === said.trim().toLowerCase().replace(/ /g, "_"));
    if (byName.length === 1) return byName[0]!;
    const hit = matchByLabel(said, candidates);
    if (!hit || "ambiguous" in hit) return null;
    return hit;
  };

  /** The kind a field is on, when the sentence did not say. "remove tea
   *  category from inventory" names the field and not inventory:part, and the
   *  model sent it that way; refusing for the kind's id sent it round three
   *  times and then to the settings page (#3087). One kind carrying the field
   *  is the answer; two is a question back, naming both; none is the usual
   *  refusal. */
  const kindOfField = async (orgId: string, said: string): Promise<{ kind: string } | { error: string }> => {
    const kinds = await listKindsForOrg(orgId);
    const carrying: string[] = [];
    const defIds = new Set<string>();
    let nativeHits = 0;
    for (const k of kinds) {
      const custom = await findField(orgId, k.id, said);
      if (!("error" in custom)) {
        carrying.push(k.id);
        defIds.add(custom.id);
        continue;
      }
      if (await findNativeField(orgId, k.id, said)) {
        carrying.push(k.id);
        nativeHits += 1;
      }
    }
    // One def on many kinds is a class-wide field, not an ambiguity; the scope
    // refusal downstream says what it covers.
    if (carrying.length === 1 || (carrying.length > 1 && defIds.size === 1 && nativeHits === 0)) {
      return { kind: carrying[0]! };
    }
    if (carrying.length > 1) {
      return { error: `"${said}" is on ${carrying.join(" and ")}; say which with entity_kind` };
    }
    return { error: `no field called "${said}" on any kind — check list_record_kinds` };
  };

  /** What an edit-field call would touch, worked out BEFORE a card exists.
   *  The handler used to be the first thing that read the arguments, so a
   *  call the handler would refuse ("Category is on four kinds; say which",
   *  "Tea is not one of the choices") became a card that failed when
   *  confirmed, or a refusal fed back after the turn. The planner runs the
   *  same resolution in the write door (chat.ts validateWrite): a reason
   *  goes back to the model while it can still correct the call, and a card
   *  says what it will do. */
  registerPlanner("platform.edit-field", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const said = str(args.field);
    if (!said) return { error: "field is required" };
    let entityKind = str(args.entity_kind);
    if (!entityKind) {
      const worked = await kindOfField(ctx.orgId, said);
      if ("error" in worked) return { error: worked.error };
      entityKind = worked.kind;
    }
    const found = await findField(ctx.orgId, entityKind, said);
    const native = "error" in found ? await findNativeField(ctx.orgId, entityKind, said) : null;
    if ("error" in found && !native) return { error: found.error };
    const label = "error" in found ? native!.label : found.label;
    const current =
      "error" in found
        ? (await readFieldOverride(ctx.orgId, entityKind, native!.name)).choices
        : ((await resolveFieldDefsForKind(ctx.orgId, entityKind)).find((d) => d.id === found.id)?.choices ?? null);
    const edited = choicesEdited(current, args, label);
    if (edited && "error" in edited) return { error: edited.error };
    const lines: string[] = [];
    if (str(args.display_label)) lines.push(`Call it "${str(args.display_label)}"`);
    if (typeof args.required === "boolean") lines.push(args.required ? "Make it required" : "No longer required");
    if (typeof args.hidden === "boolean") lines.push(args.hidden ? "Take it off forms and lists" : "Show it again");
    if (str(args.unit)) lines.push(`Unit: ${str(args.unit)}`);
    if (edited) {
      const gone = (current ?? []).filter((c) => !edited.choices.includes(c));
      const added = edited.choices.filter((c) => !(current ?? []).includes(c));
      if (gone.length) lines.push(`Take off: ${gone.join(", ")}`);
      if (added.length) lines.push(`Add: ${added.join(", ")}`);
      lines.push(`Choices after: ${edited.choices.length ? edited.choices.join(", ") : "none"}`);
    } else if (str(args.choices)) {
      lines.push(`Choices: ${str(args.choices)}`);
    } else if (args.choices === null) {
      lines.push("Choices cleared");
    }
    if (!lines.length) return { error: "nothing to change — pass a new display_label, required, choices, add_choices, remove_choices, unit, or hidden" };
    return { title: `Change "${label}" on ${entityKind}`, lines };
  });

  registerHandler("platform.edit-field", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const said = str(args.field);
    if (!said) return { ok: false, error: "field is required" };
    let entityKind = str(args.entity_kind);
    if (!entityKind) {
      const worked = await kindOfField(ctx.orgId, said);
      if ("error" in worked) return { ok: false, error: worked.error };
      entityKind = worked.kind;
    }
    const hidden = typeof args.hidden === "boolean" ? args.hidden : undefined;
    const found = await findField(ctx.orgId, entityKind, said);
    if ("error" in found) {
      // Not one of the workspace's own fields: it may be one the MODULE ships
      // (a part's manufacturer, a machine's serial number). Those are not defs to edit — what a
      // workspace changes about them is the label, whether they show, and a
      // dropdown's choices — so they go to the override layer instead. Without
      // this, "hide the manufacturer field" was answered with a list of custom fields.
      const native = await findNativeField(ctx.orgId, entityKind, said);
      if (!native) return { ok: false, error: found.error };
      // null puts a label or a choice list BACK to the field's own: that is
      // how an edit is undone, and the way to say "clear it" without a
      // second action.
      const label = args.display_label === null ? null : str(args.display_label) || undefined;
      const before = await readFieldOverride(ctx.orgId, entityKind, native.name);
      const edited = choicesEdited(before.choices, args, native.label);
      if (edited && "error" in edited) return { ok: false, error: edited.error };
      const choices = edited
        ? edited.choices
        : args.choices === null
          ? null
          : str(args.choices)
            ? str(args.choices)
                .split(",")
                .map((c) => c.trim())
                .filter(Boolean)
            : undefined;
      if (label === undefined && hidden === undefined && choices === undefined) {
        return { ok: false, error: `"${native.label}" is built in. You can rename it, hide it, or set its choices` };
      }
      await upsertNativeFieldOverride(ctx.orgId, entityKind, native.name, {
        displayLabel: label,
        hidden,
        choices,
      });
      const said2 = [
        label ? `now called "${label}"` : label === null ? "back to its own name" : "",
        hidden === true ? "hidden" : hidden === false ? "showing again" : "",
        choices ? "choices set" : choices === null ? "choices cleared" : "",
      ]
        .filter(Boolean)
        .join(", ");
      return {
        ok: true,
        summary: `"${native.label}" on ${entityKind}: ${said2}`,
        data: {
          name: native.name,
          built_in: true,
          entity_kind: entityKind,
          before,
          changed: { label: label !== undefined, hidden: hidden !== undefined, choices: choices !== undefined },
        },
      };
    }
    const wide = scopeRefusal(found, entityKind, "change");
    if (wide) return wide;

    // What the def and its override say now, kept with the result so the
    // change can be put back exactly.
    const defBefore = (await resolveFieldDefsForKind(ctx.orgId, entityKind)).find((d) => d.id === found.id);
    const before = {
      display_label: defBefore?.display_label ?? found.label,
      required: defBefore?.required ?? false,
      unit: defBefore?.unit ?? null,
      choices: defBefore?.choices ?? null,
      hidden: (await readFieldOverride(ctx.orgId, entityKind, found.name)).hidden,
    };

    // Hiding is the override layer even for a workspace's own field: the def
    // stays, its row on the form goes.
    if (hidden !== undefined) {
      await upsertNativeFieldOverride(ctx.orgId, entityKind, found.name, { hidden });
    }

    // null clears unit or choices: the way an edit that set them is undone.
    const patch: Record<string, unknown> = {};
    if (str(args.display_label)) patch.display_label = str(args.display_label);
    if (typeof args.required === "boolean") patch.required = args.required;
    if (args.unit === null) patch.unit = null;
    else if (str(args.unit)) patch.unit = str(args.unit);
    const edited = choicesEdited(before.choices, args, found.label);
    if (edited && "error" in edited) return { ok: false, error: edited.error };
    if (edited) patch.choices = edited.choices;
    else if (args.choices === null) patch.choices = null;
    else if (str(args.choices)) {
      patch.choices = str(args.choices)
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
    }
    if (Object.keys(patch).length === 0) {
      if (hidden !== undefined) {
        return {
          ok: true,
          summary: `"${found.label}" on ${entityKind} is ${hidden ? "hidden" : "showing again"}`,
          data: { name: found.name, entity_kind: entityKind, before, changed: { hidden: true } },
        };
      }
      return {
        ok: false,
        error: "nothing to change — pass a new display_label, required, choices, add_choices, remove_choices, unit, or hidden",
      };
    }
    const result = await updateFieldDef(ctx.orgId, found.id, patch);
    if (!result.ok) return { ok: false, error: result.message };
    const changed = Object.keys(patch)
      .map((k) => (k === "display_label" ? `now called "${result.def.display_label}"` : k.replace(/_/g, " ")))
      .join(", ");
    return {
      ok: true,
      summary: `"${found.label}" on ${entityKind}: ${changed}`,
      data: {
        id: result.def.id,
        name: result.def.name,
        display_label: result.def.display_label,
        entity_kind: entityKind,
        before,
        changed: {
          hidden: hidden !== undefined,
          display_label: "display_label" in patch,
          required: "required" in patch,
          unit: "unit" in patch,
          choices: "choices" in patch,
        },
      },
    };
  });

  // An edit is undone by the same action, given what each changed part said
  // before. Only the parts that changed go back; the rest is not touched.
  registerUndo("platform.edit-field", (result) => {
    const d = (result as { data?: Record<string, unknown> } | null)?.data;
    const before = d?.before as Record<string, unknown> | undefined;
    const changed = d?.changed as Record<string, boolean> | undefined;
    const name = typeof d?.name === "string" ? d.name : "";
    const kind = typeof d?.entity_kind === "string" ? d.entity_kind : "";
    if (!before || !changed || !name || !kind) return null;
    const args: Record<string, unknown> = { entity_kind: kind, field: name };
    const list = (v: unknown): string | null => (Array.isArray(v) && v.length ? v.join(", ") : null);
    if (d?.built_in) {
      if (changed.label) args.display_label = before.label ?? null;
      if (changed.choices) args.choices = list(before.choices);
    } else {
      if (changed.display_label) args.display_label = before.display_label;
      if (changed.required) args.required = before.required;
      if (changed.unit) args.unit = before.unit ?? null;
      if (changed.choices) args.choices = list(before.choices);
    }
    if (changed.hidden) args.hidden = before.hidden;
    return Object.keys(args).length > 2 ? { action_id: "platform:edit-field", args } : null;
  });

  registerHandler("platform.remove-field", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const said = str(args.field);
    if (!said) return { ok: false, error: "field is required" };
    let entityKind = str(args.entity_kind);
    if (!entityKind) {
      const worked = await kindOfField(ctx.orgId, said);
      if ("error" in worked) return { ok: false, error: worked.error };
      entityKind = worked.kind;
    }
    const found = await findField(ctx.orgId, entityKind, said);
    if ("error" in found) return { ok: false, error: found.error };
    const wide = scopeRefusal(found, entityKind, "remove");
    if (wide) return wide;
    const result = await deleteFieldDef(ctx.orgId, found.id);
    if (!result.ok) return { ok: false, error: result.message };
    return {
      ok: true,
      // Said out loud, because "removed" reads as "deleted my data" and it is not.
      summary: `"${found.label}" removed from ${entityKind}. Values already recorded are kept.`,
      data: { name: result.def.name },
    };
  });

  registerHandler("platform.group-fields", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const entityKind = str(args.entity_kind);
    const section = str(args.section);
    const renameTo = str(args.rename_to);
    const fields = splitNames(str(args.fields));
    if (!entityKind || !section || (fields.length === 0 && !renameTo)) {
      return { ok: false, error: "entity_kind and section are required, plus either fields or rename_to" };
    }
    const result = await groupFields(ctx.orgId, entityKind, section, fields, renameTo || undefined);
    if (!result.ok) return { ok: false, error: result.message };
    return {
      ok: true,
      summary: renameTo
        ? `that heading is called "${result.section}" now`
        : `${result.moved.join(", ")} now under "${result.section}"`,
      data: {
        section: result.section,
        fields: result.moved,
        entity_kind: entityKind,
        before: result.before,
        ...(result.renamed_from ? { renamed_from: result.renamed_from } : {}),
      },
    };
  });

  // A renamed heading gets its name back; grouped fields go back to wherever
  // each one was, one step per heading.
  registerUndo("platform.group-fields", (result) => {
    const d = (result as { data?: Record<string, unknown> } | null)?.data;
    const kind = typeof d?.entity_kind === "string" ? d.entity_kind : "";
    if (!kind) return null;
    if (typeof d?.renamed_from === "string" && typeof d.section === "string") {
      return { action_id: "platform:group-fields", args: { entity_kind: kind, section: d.section, rename_to: d.renamed_from } };
    }
    const before = Array.isArray(d?.before) ? (d.before as Array<{ field: string; section: string | null }>) : [];
    return fieldsBackWhereTheyWere(kind, before);
  });

  registerHandler("platform.ungroup-fields", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const entityKind = str(args.entity_kind);
    const fields = splitNames(str(args.fields));
    if (!entityKind || fields.length === 0) {
      return { ok: false, error: "entity_kind and fields are required" };
    }
    const result = await ungroupFields(ctx.orgId, entityKind, fields);
    if (!result.ok) return { ok: false, error: result.message };
    return {
      ok: true,
      summary: `${result.moved.join(", ")} no longer under a heading`,
      data: { fields: result.moved, entity_kind: entityKind, before: result.before },
    };
  });

  // Back under the heading each one was under. A field that was under none
  // has nothing to go back to, and a run that touched only those offers nothing.
  registerUndo("platform.ungroup-fields", (result) => {
    const d = (result as { data?: Record<string, unknown> } | null)?.data;
    const kind = typeof d?.entity_kind === "string" ? d.entity_kind : "";
    const before = Array.isArray(d?.before) ? (d.before as Array<{ field: string; section: string | null }>) : [];
    if (!kind) return null;
    return fieldsBackWhereTheyWere(kind, before.filter((b) => b.section !== null));
  });

  registerHandler("platform.create-instance", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const moduleName = str(args.module_name).toLowerCase();
    const displayName = str(args.display_name);
    if (!moduleName || !displayName) {
      return { ok: false, error: "module_name and display_name are required" };
    }
    const instanceName = str(args.instance_name).toLowerCase() || instanceSlugFromName(displayName);
    if (!instanceName) {
      return { ok: false, error: "couldn't derive a short name — pass instance_name (lowercase, hyphens)" };
    }
    const result = await provisionInstance({
      orgId: ctx.orgId,
      moduleName,
      instanceName,
      displayName,
    });
    if (!result.ok) return { ok: false, error: result.message };
    return {
      ok: true,
      summary: `"${displayName}" created — its records are ${instanceName}:item`,
      // The kind id is what every other tool needs to act on the new list.
      data: {
        instance: result.instance.instance_name,
        module: result.instance.module_name,
        kind: `${result.instance.instance_name}:item`,
      },
    };
  });

  /** The feature a person NAMED. They say "Purchases" or "purchase orders",
   *  never "purchases" the package name, so both are matched — and a word that
   *  fits two features asks rather than picking. */
  const findModule = (said: string): { name: string; label: string } | { error: string } => {
    const entries = listEntries().map((e) => ({
      name: e.manifest.name,
      label: e.manifest.displayName || e.manifest.name,
    }));
    const byName = entries.filter((e) => e.name === said.trim().toLowerCase());
    if (byName.length === 1) return byName[0]!;
    const hit = matchByLabel(said, entries);
    if (!hit) return { error: `no feature called "${said}" — see get_workspace_setup for what this workspace has` };
    if ("ambiguous" in hit) {
      return { error: `"${said}" could be ${hit.ambiguous.map((a) => `"${a.label}"`).join(" or ")} — which one?` };
    }
    return hit;
  };

  registerHandler("platform.enable-module", async (ctx: ActionInvokeContext) => {
    const said = str((ctx.args ?? {}).module);
    if (!said) return { ok: false, error: "module is required (the feature's name, e.g. Purchases)" };
    const found = findModule(said);
    if ("error" in found) return { ok: false, error: found.error };
    let result;
    try {
      result = await enableModuleForOrg(ctx.orgId, found.name, { userId: ctx.userId ?? undefined });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : `couldn't turn on ${found.label}` };
    }
    // The same 'user' claim the screen records, so a later bundle uninstall
    // never auto-disables a feature someone asked for by name.
    await recordClaim(ctx.orgId, USER_SOURCE, "module", found.name);
    return {
      ok: true,
      summary: result.alreadyEnabled
        ? `${found.label} was already on`
        : `${found.label} is on`,
      data: { module: found.name, already_enabled: result.alreadyEnabled },
    };
  });

  // Turning it off again. A feature that was already on was left as it was,
  // so there is nothing to put back.
  registerUndo("platform.enable-module", (result) => {
    const d = (result as { data?: { module?: unknown; already_enabled?: unknown } } | null)?.data;
    if (typeof d?.module !== "string" || d.already_enabled) return null;
    return { action_id: "platform:disable-module", args: { module: d.module } };
  });

  registerHandler("platform.disable-module", async (ctx: ActionInvokeContext) => {
    const said = str((ctx.args ?? {}).module);
    if (!said) return { ok: false, error: "module is required (the feature's name, e.g. Shipments)" };
    const found = findModule(said);
    if ("error" in found) return { ok: false, error: found.error };
    try {
      await disableModuleForOrg(ctx.orgId, found.name);
    } catch (err) {
      // "Cannot disable X: Y depends on it" is the answer, not a failure.
      return { ok: false, error: err instanceof Error ? err.message : `couldn't turn off ${found.label}` };
    }
    return {
      ok: true,
      summary: `${found.label} is off. Records already stored are kept.`,
      data: { module: found.name },
    };
  });

  /** The list a person NAMED. "Machines" may be the module's own kind or one of
   *  the workspace's named instances of it, and either can already have been
   *  renamed, so what is matched is what the workspace CALLS it today. */
  const findThing = async (
    orgId: string,
    said: string,
  ): Promise<
    | { targetKind: "entity_kind" | "instance"; targetId: string; label: string; before: { name: string; plural: string } }
    | { error: string }
  > => {
    const [kinds, instances, overrides] = await Promise.all([
      listKindsForOrg(orgId),
      listInstances(orgId),
      listOverrides(orgId),
    ]);
    const labelOf = (targetKind: string, targetId: string, fallback: string): string =>
      overrides.find((o) => o.target_kind === targetKind && o.target_id === targetId)?.display_label ?? fallback;
    const pluralOf = (targetKind: string, targetId: string, fallback: string): string =>
      overrides.find((o) => o.target_kind === targetKind && o.target_id === targetId)?.display_label_plural ?? fallback;

    // `before` is what it is called today, singular and plural: the rename's
    // way back.
    type Candidate = {
      label: string;
      targetKind: "entity_kind" | "instance";
      targetId: string;
      before: { name: string; plural: string };
    };
    const candidates: Candidate[] = [];
    for (const k of kinds) {
      const label = labelOf("entity_kind", k.id, k.display_name);
      // The plural is what people usually say ("call my parts spools"), so it is
      // matched as well as the singular rather than instead of it.
      const plural = pluralOf("entity_kind", k.id, k.display_name_plural ?? pluralise(label));
      const before = { name: label, plural };
      candidates.push({ label, targetKind: "entity_kind", targetId: k.id, before });
      if (plural !== label) candidates.push({ label: plural, targetKind: "entity_kind", targetId: k.id, before });
    }
    for (const i of instances) {
      if (i.is_default) continue;
      const label = labelOf("instance", i.instance_name, i.display_name ?? i.instance_name);
      candidates.push({
        label,
        targetKind: "instance",
        targetId: i.instance_name,
        before: { name: label, plural: pluralOf("instance", i.instance_name, pluralise(label)) },
      });
    }
    const hit = matchByLabel(said, candidates);
    if (!hit) {
      return { error: `nothing here is called "${said}" — see get_workspace_setup for what the lists are called` };
    }
    if ("ambiguous" in hit) {
      // Two labels for the SAME thing is not a question worth asking, and a
      // list is two things by construction: the instance row, and the kind
      // synthesised from it (`pantry` and `pantry:item`, both called Pantry).
      // Prefer the instance, which is what the presentation layer keys a list's
      // label on. Without this, renaming any list you had made was a dead end:
      // "could be Pantry or Pantry - which one?".
      const inst = hit.ambiguous.find((a) => a.targetKind === "instance");
      const others = hit.ambiguous.filter(
        (a) => !(a.targetKind === "instance") && !(inst && a.targetId === `${inst.targetId}:item`),
      );
      if (inst && others.length === 0) {
        return { targetKind: "instance", targetId: inst.targetId, label: inst.label, before: inst.before };
      }
      const distinct = [...new Set(hit.ambiguous.map((a) => `${a.targetKind}:${a.targetId}`))];
      if (distinct.length > 1) {
        return { error: `"${said}" could be ${hit.ambiguous.map((a) => `"${a.label}"`).join(" or ")} — which one?` };
      }
      const first = hit.ambiguous[0]!;
      return { targetKind: first.targetKind, targetId: first.targetId, label: first.label, before: first.before };
    }
    return { targetKind: hit.targetKind, targetId: hit.targetId, label: hit.label, before: hit.before };
  };

  registerHandler("platform.rename-thing", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const said = str(args.target);
    const name = str(args.name);
    if (!said || !name) return { ok: false, error: "target and name are required" };
    const found = await findThing(ctx.orgId, said);
    if ("error" in found) return { ok: false, error: found.error };
    const plural = str(args.plural) || pluralise(name);
    await upsertOverride({
      orgId: ctx.orgId,
      targetKind: found.targetKind,
      targetId: found.targetId,
      displayLabel: name,
      displayLabelPlural: plural,
    });
    return {
      ok: true,
      summary: `"${found.label}" is now called ${plural}`,
      data: { target: found.targetId, name, plural, before: found.before },
    };
  });

  // Called what it was called. The thing is named by its NEW name, which is
  // what the workspace calls it by the time the undo runs.
  registerUndo("platform.rename-thing", (result) => {
    const d = (result as { data?: { name?: unknown; before?: { name?: unknown; plural?: unknown } } } | null)?.data;
    if (typeof d?.name !== "string" || typeof d.before?.name !== "string" || typeof d.before?.plural !== "string") return null;
    return { action_id: "platform:rename-thing", args: { target: d.name, name: d.before.name, plural: d.before.plural } };
  });

  /** An instance by what it is called. Promote and fold-back both name lists,
   *  and neither should need the short name a person never sees. */
  const findInstance = async (
    orgId: string,
    said: string,
  ): Promise<{ name: string; label: string; module: string } | { error: string }> => {
    const instances = await listInstances(orgId);
    const candidates = instances.map((i) => ({
      label: i.display_name ?? i.instance_name,
      name: i.instance_name,
      module: i.module_name,
    }));
    const byName = candidates.filter((c) => c.name === said.trim().toLowerCase());
    if (byName.length === 1) return byName[0]!;
    const hit = matchByLabel(said, candidates);
    if (!hit) return { error: `no list called "${said}" — see get_workspace_setup (instances)` };
    if ("ambiguous" in hit) {
      return { error: `"${said}" could be ${hit.ambiguous.map((a) => `"${a.label}"`).join(" or ")} — which one?` };
    }
    return hit;
  };

  registerHandler("platform.promote-category", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const category = str(args.category);
    const said = str(args.from);
    if (!said || !category) return { ok: false, error: "from (the list it is in) and category are required" };
    const parent = await findInstance(ctx.orgId, said);
    if ("error" in parent) return { ok: false, error: parent.error };
    const displayName = str(args.display_name) || category;
    const instanceName = str(args.instance_name).toLowerCase() || instanceSlugFromName(displayName);
    if (!instanceName) {
      return { ok: false, error: "couldn't derive a short name — pass instance_name (lowercase, hyphens)" };
    }
    try {
      const result = await promoteCategory({
        orgId: ctx.orgId,
        parentInstance: parent.name,
        category,
        instanceName,
        displayName,
      });
      return {
        ok: true,
        summary: `${displayName} is its own list now, with ${result.moved} moved out of ${parent.label}`,
        data: {
          instance: result.instance.instance_name,
          moved: result.moved,
          kind: `${result.instance.instance_name}:item`,
          from: parent.name,
          category,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "couldn't promote that category" };
    }
  });

  // Folded back into the list it came out of, stamped with the same category:
  // the pair this action was designed with.
  registerUndo("platform.promote-category", (result) => {
    const d = (result as { data?: { instance?: unknown; from?: unknown; category?: unknown } } | null)?.data;
    if (typeof d?.instance !== "string" || typeof d.from !== "string" || typeof d.category !== "string") return null;
    return { action_id: "platform:demote-category", args: { list: d.instance, into: d.from, category: d.category } };
  });

  // Moving records between lists.
  //
  // The capability was already here and complete - a column flip plus every
  // reference that stored the old kind beside the id (tags, files, QR tokens,
  // activity), with a preview - and it was reachable only from the records
  // screen. The assistant had no way to do it at all, so asked to move the tea
  // on a page into the Tea list it improvised: one day it created a second
  // copy of each and said it had moved them, the next it proposed deleting
  // them (2026-09-08, reported twice with screenshots). Neither is a bug in
  // its judgement so much as the absence of a right answer to reach for.
  registerHandler("platform.move-records", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    // A list arg arrives as a real array from invoke_action and as delimited
    // text from a wire's text box; readListArg is the one reader for both.
    const ids = readListArg(args, "ids");
    const toSaid = str(args.to);
    if (!toSaid) return { ok: false, error: "to (the list to move them into) is required" };
    if (ids.length === 0) {
      return { ok: false, error: "ids are required - read the records first and pass their real ids, never their names" };
    }
    const to = await findInstance(ctx.orgId, toSaid);
    if ("error" in to) return { ok: false, error: to.error };
    // `from` is a courtesy, not a requirement: a person saying "put these in
    // Tea" has said everything that matters, and the records themselves know
    // where they are. Given, it is checked, because a wrong `from` is the one
    // way this could move something nobody meant.
    const fromSaid = str(args.from);
    let from: { name: string; label: string; module: string };
    if (fromSaid) {
      const f = await findInstance(ctx.orgId, fromSaid);
      if ("error" in f) return { ok: false, error: f.error };
      from = f;
    } else {
      const found = await instancesHolding(ctx.orgId, to.module, ids);
      if ("error" in found) return { ok: false, error: found.error };
      from = { name: found.instance, label: found.instance, module: to.module };
    }
    if (from.name === to.name) {
      return { ok: true, summary: `Already in ${to.label}.`, data: { moved: 0 } };
    }
    if (!getMover(from.module)) {
      return { ok: false, error: `${from.module} records cannot be moved between lists.` };
    }
    try {
      const result = await moveRecords(ctx.orgId, from.module, ids, from.name, to.name);
      const n = result.moved.length;
      // Every record it moved, by its NEW kind: the panel draws each as a chip
      // that opens it where it now lives.
      const toKind = getMover(from.module)!.kindFor(to.name);
      return {
        ok: true,
        summary: n === 1 ? `Moved 1 record into ${to.label}.` : `Moved ${n} records into ${to.label}.`,
        data: {
          moved: n,
          to: to.name,
          from: from.name,
          carried: result.fieldsCarried,
          touched: result.moved.map((id) => ({ kind: toKind, id })),
          // Where they are now, so the card can offer to take the person
          // there: a move that lands somewhere they have to go and find is
          // half a change.
          destination: { kind: toKind, label: to.label },
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "couldn't move those" };
    }
  });

  // The same reading as the handler above, with the write left off: the
  // confirm card lists every record by name and says which list it leaves
  // and which it joins. "Move records into another list" on its own was the
  // card a person saw for five named teas (2026-09-09).
  registerPlanner("platform.move-records", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const ids = readListArg(args, "ids");
    const toSaid = str(args.to);
    // Every way this cannot be planned is said, in the words the handler
    // would refuse with: the model reads them and fixes the call. Silence here
    // was a bare confirm card (2026-09-11).
    if (!toSaid) return { error: "to (the list to move them into) is required" };
    if (ids.length === 0) return { error: "ids are required - read the records first and pass their real ids, never their names" };
    const to = await findInstance(ctx.orgId, toSaid);
    if ("error" in to) return { error: to.error };
    const fromSaid = str(args.from);
    let from: { name: string; label: string; module: string };
    if (fromSaid) {
      const f = await findInstance(ctx.orgId, fromSaid);
      if ("error" in f) return { error: f.error };
      from = f;
    } else {
      const found = await instancesHolding(ctx.orgId, to.module, ids);
      if ("error" in found) return { error: found.error };
      const f = await findInstance(ctx.orgId, found.instance);
      from = "error" in f ? { name: found.instance, label: found.instance, module: to.module } : f;
    }
    const mover = getMover(from.module);
    if (!mover) return { error: `${from.module} records cannot be moved between lists.` };
    const kind = mover.kindFor(from.name);
    const lines: string[] = [];
    let missing = 0;
    for (const id of ids.slice(0, 200)) {
      const ent = await lookup(ctx.orgId, kind, id).catch(() => null);
      if (!ent) missing += 1;
      lines.push(ent?.title ?? `a record that no longer exists (${id.slice(0, 8)})`);
    }
    // Not one of them is a record: these are names, or ids from another list.
    // A card listing five "no longer exists" lines is a card about nothing.
    if (missing === ids.length) {
      return { error: `none of those ids is a record in ${from.label} - pass the ids list_records returns, not names` };
    }
    const n = lines.length;
    return {
      title: n === 1 ? `Move 1 record from ${from.label} into ${to.label}` : `Move ${n} records from ${from.label} into ${to.label}`,
      lines,
    };
  });

  // The inverse of a move is the same move the other way, on the same ids,
  // which the result already names. Exact, because the handler's field
  // carry-over is additive (a field is added to the destination, never
  // removed), so the way back loses nothing the way there had.
  registerUndo("platform.move-records", (result) => {
    const d = (result as { data?: { touched?: Array<{ id?: unknown }>; to?: unknown; from?: unknown } } | null)?.data;
    const ids = (d?.touched ?? []).map((t) => t.id).filter((id): id is string => typeof id === "string");
    if (!ids.length || typeof d?.to !== "string" || typeof d?.from !== "string") return null;
    return { action_id: "platform:move-records", args: { ids, to: d.from, from: d.to } };
  });

  registerHandler("platform.demote-category", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const said = str(args.list);
    const intoSaid = str(args.into);
    if (!said || !intoSaid) return { ok: false, error: "list and into are required" };
    const inst = await findInstance(ctx.orgId, said);
    if ("error" in inst) return { ok: false, error: inst.error };
    const into = await findInstance(ctx.orgId, intoSaid);
    if ("error" in into) return { ok: false, error: into.error };
    const category = str(args.category) || inst.label;
    try {
      const result = await demoteInstance({
        orgId: ctx.orgId,
        instanceName: inst.name,
        parentInstance: into.name,
        category,
      });
      return {
        ok: true,
        summary: `${inst.label} folded back into ${into.label} as "${category}", with ${result.moved} moved`,
        data: { moved: result.moved, category, list: inst.name, display_name: inst.label, into: into.name },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "couldn't fold that list back" };
    }
  });

  // Given its own list again, with the same short name and label, from the
  // category it was folded in under.
  registerUndo("platform.demote-category", (result) => {
    const d = (result as { data?: { category?: unknown; list?: unknown; display_name?: unknown; into?: unknown } } | null)?.data;
    if (typeof d?.category !== "string" || typeof d.list !== "string" || typeof d.display_name !== "string" || typeof d.into !== "string") {
      return null;
    }
    return {
      action_id: "platform:promote-category",
      args: { from: d.into, category: d.category, display_name: d.display_name, instance_name: d.list },
    };
  });

  registerHandler("platform.rename-workspace", async (ctx: ActionInvokeContext) => {
    const name = str((ctx.args ?? {}).name).trim();
    if (!name) return { ok: false, error: "name is required" };
    const before = await meta
      .selectFrom("orgs")
      .select(["name"])
      .where("id", "=", ctx.orgId)
      .executeTakeFirst();
    // The NAME only. The slug is in every link, bookmark and printed label that
    // points at this workspace, and there is no undo for a sticker.
    await meta
      .updateTable("orgs")
      .set({ name, updated_at: new Date() })
      .where("id", "=", ctx.orgId)
      .execute();
    await activity.log({
      orgId: ctx.orgId,
      userId: ctx.userId ?? undefined,
      action: "org_renamed",
      ref: { module: null, entityType: "org", entityId: ctx.orgId },
      diff: { name: { from: before?.name ?? null, to: name } },
    });
    return { ok: true, summary: `this workspace is called "${name}" now`, data: { name, before: before?.name ?? null } };
  });

  registerUndo("platform.rename-workspace", (result) => {
    const d = (result as { data?: { name?: unknown; before?: unknown } } | null)?.data;
    if (typeof d?.before !== "string" || !d.before.trim() || d.before === d.name) return null;
    return { action_id: "platform:rename-workspace", args: { name: d.before } };
  });

  registerHandler("platform.set-simple-mode", async (ctx: ActionInvokeContext) => {
    const on = (ctx.args ?? {}).on;
    if (typeof on !== "boolean") return { ok: false, error: "on must be true (simple) or false (everything)" };
    const was = await meta.selectFrom("orgs").select("focused").where("id", "=", ctx.orgId).executeTakeFirst();
    await meta
      .updateTable("orgs")
      .set({ focused: on, updated_at: new Date() })
      .where("id", "=", ctx.orgId)
      .execute();
    await activity.log({
      orgId: ctx.orgId,
      userId: ctx.userId ?? undefined,
      action: on ? "focused_enabled" : "focused_disabled",
      ref: { module: null, entityType: "org", entityId: ctx.orgId },
      diff: { focused: on },
    });
    return {
      ok: true,
      summary: on ? "simple mode is on: the advanced screens are put away" : "simple mode is off: everything is showing",
      data: { focused: on, before: !!was?.focused },
    };
  });

  // Set back the way it was. Setting it to what it already was left nothing to undo.
  registerUndo("platform.set-simple-mode", (result) => {
    const d = (result as { data?: { focused?: unknown; before?: unknown } } | null)?.data;
    if (typeof d?.focused !== "boolean" || typeof d.before !== "boolean" || d.before === d.focused) return null;
    return { action_id: "platform:set-simple-mode", args: { on: d.before } };
  });

  registerHandler("platform.set-field-preset", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const said = str(args.preset);
    if (!said) return { ok: false, error: "preset is required" };
    if (typeof args.on !== "boolean") return { ok: false, error: "on must be true or false" };
    // By key or by the words on the switch ("provenance", "Provenance").
    const byKey = FIELD_PRESETS.find((p) => p.key === said.trim().toLowerCase());
    const matched = byKey
      ? { key: byKey.key }
      : matchByLabel(said, FIELD_PRESETS.map((p) => ({ label: p.label, key: p.key })));
    if (!matched || "ambiguous" in matched) {
      return {
        ok: false,
        error: `no set of fields called "${said}". There is: ${FIELD_PRESETS.map((p) => p.label).join(", ")}`,
      };
    }
    const key = matched.key;
    const result = args.on ? await turnPresetOn(ctx.orgId, key) : await turnPresetOff(ctx.orgId, key);
    if (!result.ok) return { ok: false, error: result.message };
    const preset = FIELD_PRESETS.find((p) => p.key === key)!;
    return {
      ok: true,
      summary: args.on
        ? `${preset.label} is on: ${(result.created ?? []).length || "no"} field(s) added`
        : `${preset.label} is off. Anything already recorded in those fields is kept.`,
      data: { preset: key, on: args.on, created: result.created ?? [], removed: result.removed ?? [] },
    };
  });

  // The switch the other way. A set that was already on (nothing added) or
  // already off (nothing taken away) was not changed, so nothing goes back.
  registerUndo("platform.set-field-preset", (result) => {
    const d = (result as { data?: { preset?: unknown; on?: unknown; created?: unknown; removed?: unknown } } | null)?.data;
    if (typeof d?.preset !== "string" || typeof d.on !== "boolean") return null;
    const touched = d.on ? d.created : d.removed;
    if (!Array.isArray(touched) || touched.length === 0) return null;
    return { action_id: "platform:set-field-preset", args: { preset: d.preset, on: !d.on } };
  });

  registerHandler("platform.set-wire-enabled", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const wireId = str(args.wire_id);
    if (!wireId) return { ok: false, error: "wire_id is required (see get_workspace_setup, automations)" };
    if (typeof args.enabled !== "boolean") {
      return { ok: false, error: "enabled must be true (on) or false (off)" };
    }
    const was = await meta
      .selectFrom("entity_action_bindings")
      .select("enabled")
      .where("id", "=", wireId)
      .where("org_id", "=", ctx.orgId)
      .executeTakeFirst();
    const result = await setWireEnabled(ctx.orgId, wireId, args.enabled, ctx.userId);
    if (!result.ok) return { ok: false, error: result.message };
    return {
      ok: true,
      summary: `automation ${result.wire.action_id} is now ${result.wire.enabled ? "on" : "off"}`,
      data: { id: result.wire.id, enabled: result.wire.enabled, before: was?.enabled ?? result.wire.enabled },
    };
  });

  // Set back the way it was; a toggle to what it already was left nothing to undo.
  registerUndo("platform.set-wire-enabled", (result) => {
    const d = (result as { data?: { id?: unknown; enabled?: unknown; before?: unknown } } | null)?.data;
    if (typeof d?.id !== "string" || typeof d.enabled !== "boolean" || typeof d.before !== "boolean" || d.before === d.enabled) return null;
    return { action_id: "platform:set-wire-enabled", args: { wire_id: d.id, enabled: d.before } };
  });

  // ── Approvals: the two buttons on an approver's card (approvals.ts) ──
  // One decision function for both doors (this press and the settings page),
  // so who may answer and what a yes does cannot drift between them.
  for (const decision of ["approve", "deny"] as const) {
    registerHandler(`platform.${decision}-request`, async (ctx: ActionInvokeContext) => {
      const requestId = str((ctx.args ?? {}).request_id);
      if (!requestId) return { ok: false, error: "request_id is required" };
      if (!ctx.userId) return { ok: false, error: "a person has to press this" };
      const r = await decideApprovalRequest({
        requestId,
        deciderId: ctx.userId,
        decision,
        note: str((ctx.args ?? {}).note) || null,
      });
      if (!r.ok) return { ok: false, error: r.message };
      const asks = r.request.remedies.map((x) => x.label).join(" and ");
      return {
        ok: true,
        summary: decision === "approve" ? `Approved: ${asks}. They have been told.` : `Declined. They have been told.`,
        data: { request_id: requestId, status: r.request.status, applied: r.applied },
      };
    });
  }
}
