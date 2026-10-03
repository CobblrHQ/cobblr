import { restore as restoreDeletedRecord } from "./deleted-records.js";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { restoreHistoryVersion } from "./history-restore.js";
import { z } from "zod";
import { setBulkField, restoreBulkField, type BulkFieldResult } from "./bulk-set-field.js";
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

import { contentsWordOf, setContentsWord } from "./contents-word.js";
import { contentsWordText } from "@cobblr/platform-contract";
import { SYSTEM_VIEWER, isFieldScope, platform, pluralise, readListArg, type ActionInvokeContext } from "@cobblr/platform-contract";
import { matchByLabel, splitNames } from "@cobblr/platform-contract/said-names";
import { kindWordsFrom, type KindWords } from "@cobblr/platform-contract/kind-label";
import { disableModuleForOrg, enableModuleForOrg } from "../modules/enable.js";
import { listEntries } from "../modules/registry.js";
import { meta } from "../db/meta.js";
import { actionLabelOf, registerHandler, registerPlanner, registerUndo } from "./actions.js";
import { getMover, instancesHolding, moveRecords } from "./move-records.js";
import { bringBack, markGone } from "./dispositions.js";
import { offerRecords, offerTargets } from "./share-offers.js";
import { findShareTarget, shareRecords, stopSharingRecords } from "./share-picks.js";
import { decideShareEdit, describeShareEdits, listShareEdits, type ShareEditDecision } from "./share-edits.js";
import { leaveAddition, listAdditions, takeAddition } from "./share-additions.js";
import { DISPOSITION_LABELS, dispositionOf, type RecordDisposition } from "@cobblr/platform-contract/disposition";
import * as activity from "./activity.js";
import { upsertNativeFieldOverride } from "./native-field-overrides.js";
import { moveFieldValues, unmoveFieldValues, type FieldMove } from "./move-field-values.js";
import { declineSellers, trackSellers, untrackSellers } from "./seller-upgrade.js";
import { USER_SOURCE, claimsForSource } from "./bundle-claims.js";
import { listAll, listKindsForOrg, lookup } from "./entities.js";
import {
  FieldDefCreate,
  createFieldDef,
  deleteFieldDef,
  kindFieldsWithMeaning,
  effectiveFieldDef,
  resolveFieldDefsForKind,
  updateFieldDef,
} from "./field-defs.js";
import { choiceLearns, sameChoice, withLearnedChoice } from "@cobblr/platform-contract/field-choices";
import { listOverrides, upsertOverride } from "./entity-kind-overrides.js";
import { FIELD_PRESETS } from "./field-presets.js";
import { turnPresetOff, turnPresetOn } from "./field-preset-switch.js";
import { groupFields, ungroupFields } from "./field-sections.js";
import { demoteInstance, promoteCategory } from "./instance-promote.js";
import { listInstances } from "./instances.js";
import { countInstanceItems, getInstance, provisionInstance, tearDownInstance } from "./instances.js";
import { setWireEnabled } from "./wires.js";
import { decideApprovalRequest } from "./approvals.js";
import { confirmHeldChange, keepHeldChange } from "./ai-held-changes.js";
import { confirmServiceJob, mayConfirm } from "./service-confirm.js";
import { cancelRun } from "./service-supervisor.js";
import { invokeAs, retryJob, skipJob, stableJson } from "./services.js";
import { render } from "./templates.js";

/** A service input with every string in it filled from the event
 *  (`{{event.jobId}}`): the wire engine fills only top-level strings, and an
 *  input is an object. */
function renderEventValues(value: unknown, data: Record<string, unknown>): unknown {
  if (typeof value === "string") return value.includes("{{") ? render(value, data) : value;
  if (Array.isArray(value)) return value.map((v) => renderEventValues(v, data));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderEventValues(v, data)]));
  return value;
}

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
  // Anyone on the People list, member or not: an owner, a borrower's name.
  person: { type: "person" },
  people: { type: "person" },
  owner: { type: "person" },
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
/** Whether a list offers a choice named the way a person names it: the same
 *  match a removal uses (exact, case aside, a unique prefix). */
function hasChoice(choices: readonly string[], said: string): boolean {
  const hit = matchByLabel(said, choices.map((c) => ({ label: c })));
  return !!hit && !("ambiguous" in hit);
}

function namesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.flatMap((x) => (typeof x === "string" ? splitNames(x) : []));
  return splitNames(str(v));
}

function choicesEdited(
  current: string[] | null,
  args: Record<string, unknown>,
  fieldLabel: string,
): { choices: string[]; added: string[]; removed: string[] } | { error: string } | undefined {
  const add = namesOf(args.add_choices);
  const remove = namesOf(args.remove_choices);
  if (add.length === 0 && remove.length === 0) return undefined;
  if (namesOf(args.choices).length || args.choices === null) {
    return { error: "pass either choices (the whole list) or add_choices / remove_choices, not both" };
  }
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  let next = [...(current ?? [])];
  const added: string[] = [];
  const removed: string[] = [];
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
    removed.push(hit.label);
  }
  for (const more of add) {
    if (next.some((c) => same(c, more))) continue;
    next.push(more);
    added.push(more);
  }
  return { choices: next, added, removed };
}

/** What a choices edit did, said the way the person asked for it: "Added
 *  Aran to the Yarn weight choices (DK, Worsted, Aran)". The generic
 *  '"Yarn weight" on inventory:part: choices' was the whole result line on
 *  the card after a phrase command ran (walked on the rig, 2026-09-20). */
function choicesSentence(fieldLabel: string, edited: { choices: string[]; added: string[]; removed: string[] }): string {
  const parts = [
    edited.added.length ? `Added ${edited.added.join(", ")} to` : "",
    edited.removed.length ? `Took ${edited.removed.join(", ")} off` : "",
  ].filter(Boolean);
  const did = parts.length ? parts.join("; ") : "No change to";
  return `${did} the "${fieldLabel}" choices (${edited.choices.length ? edited.choices.join(", ") : "none left"})`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** The workspace's kinds of record, for a refusal both readers can act on:
 *  the plural a person knows them by, the id beside it for a model that will
 *  call again ("parts (inventory:part), machines (machines:machine)"). A
 *  refusal used to say "check list_record_kinds", a tool name a person cannot
 *  do anything with, and on a card it read as something broken (#3237). */
/** The words a summary uses for a kind ("parts", "Spices"): every sentence a
 *  handler returns is the line a person reads on the card after Do it, and
 *  seven of them wrote the kind id into it (#3237). One rule over the
 *  workspace's own kinds list (kind-label.ts, kindWordsFrom). */
async function kindWords(orgId: string, kind: string): Promise<KindWords> {
  return kindWordsFrom(kind, await listKindsForOrg(orgId).catch(() => []), pluralise);
}

/** "Purchase date", "Purchase date and Supplier", "A, B and C": a list for a
 *  sentence a person reads. */
function inWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "nothing";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "no fields", "1 field", "3 fields": never "field(s)". */
function countOf(n: number, noun: string): string {
  return n === 0 ? `no ${pluralise(noun)}` : `${n} ${n === 1 ? noun : pluralise(noun)}`;
}

function kindsInWords(kinds: Array<{ id: string; display_name_plural?: string | null }>): string {
  const named = kinds.map((k) => (k.display_name_plural ? `${k.display_name_plural} (${k.id})` : k.id));
  const shown = named.slice(0, 8);
  return `${shown.join(", ")}${named.length > shown.length ? ` and ${named.length - shown.length} more` : ""}`;
}

export function registerPlatformActionHandlers(): void {
  registerHandler("platform.restore-deleted-record", async (ctx) => {
    const parsed = z.object({ kind: z.string().min(1), entity_id: z.string().min(1) }).safeParse(ctx.args);
    if (!parsed.success) return { ok: false, error: "Choose a deleted record." };
    try { return await restoreDeletedRecord(ctx.orgId, parsed.data.kind, parsed.data.entity_id) ? { ok: true, summary: "Restored the record." } : { ok: false, error: "That record is no longer in Recently deleted." }; }
    catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  const versionSchema = z.object({ kind: z.string().min(1), entity_id: z.string().min(1), entry_id: z.number().int().positive(), expected_latest_id: z.number().int().positive() });
  registerPlanner("platform.restore-record-version", async (ctx) => {
    const parsed = versionSchema.safeParse(ctx.args);
    if (!parsed.success) return { error: "Choose a record and a saved history entry." };
    const rec = await lookup(ctx.orgId, parsed.data.kind, parsed.data.entity_id);
    return { title: `Restore ${rec?.title ?? "this record"}`, lines: ["Restore the values from before the selected edit. Later edits will be replaced."] };
  });
  registerHandler("platform.restore-record-version", async (ctx) => {
    const parsed = versionSchema.safeParse(ctx.args);
    if (!parsed.success || !ctx.userId) return { ok: false, error: "Choose a record and a saved history entry." };
    const membership = await meta.selectFrom("org_memberships").select("role").where("org_id", "=", ctx.orgId).where("user_id", "=", ctx.userId).executeTakeFirst();
    if (!membership || !roleSatisfies(membership.role, ["owner", "admin"])) return { ok: false, error: "An owner, admin or editor can restore a record version." };
    const a = parsed.data;
    try {
      const restored = await restoreHistoryVersion(ctx.orgId, ctx.userId, membership.role, a.kind, a.entity_id, a.entry_id, a.expected_latest_id);
      return { ok: true, summary: "Restored the saved version.", data: { kind: a.kind, entity_id: a.entity_id, entry_id: restored, expected_latest_id: restored } };
    } catch (err) { return { ok: false, error: (err as Error).message }; }
  });
  registerUndo("platform.restore-record-version", (result) => {
    const parsed = versionSchema.safeParse((result as { data?: unknown } | null)?.data);
    return parsed.success ? { action_id: "platform:restore-record-version", args: parsed.data } : null;
  });
  const refsSchema = z.array(z.object({ kind: z.string().min(1), id: z.string().min(1) })).min(1).max(500);
  const changesSchema = z.array(z.object({ kind: z.string().min(1), id: z.string().min(1), title: z.string(), before: z.unknown(), after: z.unknown() })).min(1).max(500);
  registerPlanner("platform.set-field-on-records", async (ctx) => {
    const parsed = refsSchema.safeParse(ctx.args?.records);
    if (!parsed.success) return { error: "Choose between 1 and 500 records, each with a kind and id." };
    const lines: string[] = [];
    for (const r of parsed.data) lines.push((await lookup(ctx.orgId, r.kind, r.id))?.title ?? "A record that is no longer available");
    return { title: `Set ${String(ctx.args?.field ?? "a field")} on ${lines.length} records`, lines };
  });
  registerHandler("platform.set-field-on-records", async (ctx) => {
    const parsed = refsSchema.safeParse(ctx.args?.records);
    if (!parsed.success || typeof ctx.args?.field !== "string" || !("value" in ctx.args)) return { ok: false, error: "Choose records, a field and a value, or null to clear it." };
    try {
      const data = await setBulkField(ctx.orgId, ctx.userId, parsed.data, ctx.args.field, ctx.args.value);
      return { ok: true, data: { field: ctx.args.field, ...data }, summary: `${data.done.length} records changed.${data.failed.length ? ` ${data.failed.length} skipped.` : ""}` };
    } catch (e) { return { ok: false, error: (e as Error).message }; }
  });
  registerUndo("platform.set-field-on-records", (result) => {
    const data = (result as { data?: BulkFieldResult & { field: string } } | null)?.data;
    if (!data?.done.length) return null;
    return { action_id: "platform:restore-batch-field", args: { field: data.field, changes: data.done } };
  });
  registerPlanner("platform.restore-batch-field", async (ctx) => {
    const parsed = changesSchema.safeParse(ctx.args?.changes);
    return parsed.success ? { title: "Restore the batch's previous field values", lines: parsed.data.map((r) => r.title) } : { error: "The batch's changes are missing." };
  });
  registerHandler("platform.restore-batch-field", async (ctx) => {
    const parsed = changesSchema.safeParse(ctx.args?.changes);
    if (!parsed.success || typeof ctx.args?.field !== "string") return { ok: false, error: "The batch's changes are missing." };
    const data = await restoreBulkField(ctx.orgId, ctx.userId, ctx.args.field, parsed.data.map((r) => ({ ...r, before: r.before ?? null, after: r.after ?? null })));
    return { ok: true, data, summary: `${data.done.length} records restored.${data.failed.length ? ` ${data.failed.length} skipped.` : ""}` };
  });

  registerHandler("platform.add-field", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const entityKind = str(args.entity_kind);
    const displayLabel = str(args.display_label) || str(args.name);
    if (!entityKind || !displayLabel) {
      return { ok: false, error: "entity_kind and display_label are required" };
    }
    const typeWord = str(args.type).toLowerCase() || "text";
    const mapped = FIELD_TYPE_WORDS[typeWord] ?? { type: typeWord };
    const choices = namesOf(args.choices).length ? namesOf(args.choices) : undefined;
    // The kind must exist (unless it's a trait scope like @physical, which the
    // service resolves itself) — a field on a kind nobody has saves fine and
    // then applies to nothing, a failure found much later.
    if (!isFieldScope(entityKind)) {
      const kinds = await listKindsForOrg(ctx.orgId);
      if (!kinds.some((k) => k.id === entityKind)) {
        return {
          ok: false,
          // ALLOW-INTERNAL-NOUN: echoes the caller's own word for a kind that is not here; there are no words for it, and the kinds that are come in words beside it
          error: `this workspace has no kind of record called "${entityKind}" to put a field on; it has ${kindsInWords(kinds)} (or a trait scope like @physical puts it on a whole class)`,
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
      ...(args.without_meaning === true ? { without_meaning: true } : {}),
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
    if (!result.ok) {
      // A field meaning what one the kind has is not made twice: say which, so
      // the answer can offer it (or ask again with without_meaning).
      if (result.code === "same_meaning") return { ok: false, error: result.message, data: { existing: result.existing, role: result.role } };
      return { ok: false, error: result.message };
    }
    return {
      ok: true,
      summary: `"${result.def.display_label}" (${result.def.type}) added to ${(await kindWords(ctx.orgId, result.def.entity_kind)).many}`,
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
      return { error: `${(await kindWords(orgId, entityKind)).many} have no custom fields yet` };
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
        error: `no field called "${said}" on ${(await kindWords(orgId, entityKind)).many}. It has: ${defs.map((d) => d.display_label).join(", ")}`,
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
    kind: KindWords,
    verb: string,
  ): { ok: false; error: string } | null =>
    found.scopeLabel
      ? {
          ok: false,
          error:
            `"${found.label}" is not just on ${kind.many} — it is on ${found.scopeLabel}, so a ` +
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
   *  is the answer. Several are narrowed by the choices being taken off: only
   *  one Category list holds Tea, so "take Tea off Category" means that one
   *  (#4574). Still several is a question back, naming them the way the
   *  workspace does; none is the usual refusal. */
  const kindOfField = async (
    orgId: string,
    said: string,
    args: Record<string, unknown> = {},
  ): Promise<{ kind: string } | { error: string }> => {
    const kinds = await listKindsForOrg(orgId);
    const carrying: Array<{ kind: string; choices: string[] | null }> = [];
    const defIds = new Set<string>();
    let nativeHits = 0;
    for (const k of kinds) {
      const custom = await findField(orgId, k.id, said);
      if (!("error" in custom)) {
        const def = (await resolveFieldDefsForKind(orgId, k.id)).find((d) => d.id === custom.id);
        carrying.push({ kind: k.id, choices: def?.choices ?? null });
        defIds.add(custom.id);
        continue;
      }
      const native = await findNativeField(orgId, k.id, said);
      if (native) {
        carrying.push({ kind: k.id, choices: (await readFieldOverride(orgId, k.id, native.name)).choices });
        nativeHits += 1;
      }
    }
    // One def on many kinds is a class-wide field, not an ambiguity; the scope
    // refusal downstream says what it covers.
    if (carrying.length === 1 || (carrying.length > 1 && defIds.size === 1 && nativeHits === 0)) {
      return { kind: carrying[0]!.kind };
    }
    const many = async (ks: Array<{ kind: string }>) =>
      inWords(await Promise.all(ks.map(async (k) => (await kindWords(orgId, k.kind)).many)));
    if (carrying.length > 1) {
      const gone = namesOf(args.remove_choices);
      if (gone.length) {
        const holding = carrying.filter((c) => gone.every((g) => !!c.choices && hasChoice(c.choices, g)));
        if (holding.length === 1) return { kind: holding[0]!.kind };
        if (holding.length > 1) {
          return { error: `${gone.map((g) => `"${g}"`).join(" and ")} is a choice of "${said}" on ${await many(holding)}. Which kind of record do you mean?` };
        }
      }
      // Read by a model (which names the kind on the next call) and by a
      // person whose phrase command ran it (who reads it on the card), so it
      // says the fact in words both can act on and no argument name.
      return { error: `"${said}" is on ${await many(carrying)}. Which kind of record do you mean?` };
    }
    return { error: `no field called "${said}" on any kind of record; name it the way it appears on the form` };
  };

  /** How many records of a kind hold each of these values in a field, so a
   *  card that takes a choice off can say who still uses it. Records keep the
   *  value either way: a choice list is what is offered, not what is stored. */
  const recordsHolding = async (
    orgId: string,
    kind: string,
    field: { name: string; native: boolean },
    values: readonly string[],
  ): Promise<Map<string, number>> => {
    const counts = new Map(values.map((v) => [v, 0]));
    if (!values.length) return counts;
    // SYSTEM-READ: a count for the card about a field's choices, over every record of the kind; no record is shown.
    const { items } = await listAll(orgId, kind, {}, SYSTEM_VIEWER, { cap: 20_000 }).catch(() => ({ items: [] }));
    for (const it of items) {
      const f = (it.fields ?? {}) as Record<string, unknown>;
      const bag = (f.metadata && typeof f.metadata === "object" ? f.metadata : {}) as Record<string, unknown>;
      const v = field.native ? f[field.name] : bag[field.name];
      if (typeof v !== "string") continue;
      for (const want of values) if (sameChoice(v, want)) counts.set(want, (counts.get(want) ?? 0) + 1);
    }
    return counts;
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
      const worked = await kindOfField(ctx.orgId, said, args);
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
      if (gone.length) {
        const field = "error" in found ? { name: native!.name, native: true } : { name: found.name, native: false };
        const using = await recordsHolding(ctx.orgId, entityKind, field, gone);
        const kw = await kindWords(ctx.orgId, entityKind);
        for (const [choice, n] of using) {
          if (n > 0) lines.push(`${n} ${n === 1 ? kw.one : kw.many} ${n === 1 ? "uses" : "use"} ${choice}: ${n === 1 ? "it keeps" : "they keep"} it, but it is no longer offered`);
        }
      }
      if (added.length) lines.push(`Add: ${added.join(", ")}`);
      lines.push(`Choices after: ${edited.choices.length ? edited.choices.join(", ") : "none"}`);
    } else if (namesOf(args.choices).length) {
      lines.push(`Choices: ${namesOf(args.choices).join(", ")}`);
    } else if (args.choices === null) {
      lines.push("Choices cleared");
    }
    if (!lines.length) return { error: "nothing to change — pass a new display_label, required, choices, add_choices, remove_choices, unit, or hidden" };
    return { title: `Change "${label}" on ${(await kindWords(ctx.orgId, entityKind)).many}`, lines };
  });

  registerHandler("platform.edit-field", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const said = str(args.field);
    if (!said) return { ok: false, error: "field is required" };
    let entityKind = str(args.entity_kind);
    if (!entityKind) {
      const worked = await kindOfField(ctx.orgId, said, args);
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
          : namesOf(args.choices).length
            ? namesOf(args.choices)
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
        summary: `"${native.label}" on ${(await kindWords(ctx.orgId, entityKind)).many}: ${said2}`,
        data: {
          name: native.name,
          built_in: true,
          entity_kind: entityKind,
          before,
          changed: { label: label !== undefined, hidden: hidden !== undefined, choices: choices !== undefined },
        },
      };
    }
    const wide = scopeRefusal(found, await kindWords(ctx.orgId, entityKind), "change");
    if (wide) return wide;

    // What the def and its override say now, kept with the result so the
    // change can be put back exactly.
    const defBefore = (await resolveFieldDefsForKind(ctx.orgId, entityKind)).find((d) => d.id === found.id);
    // The choices a person sees: a bundle field's list is the user layer's, so
    // adding to the raw list would drop every earlier addition.
    const effective = defBefore ? await effectiveFieldDef(ctx.orgId, entityKind, defBefore.name) : null;
    const before = {
      display_label: defBefore?.display_label ?? found.label,
      required: defBefore?.required ?? false,
      unit: defBefore?.unit ?? null,
      choices: effective?.choices ?? defBefore?.choices ?? null,
      learns: effective?.learns ?? null,
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
    else if (namesOf(args.choices).length) patch.choices = namesOf(args.choices);
    // Whether a value someone types is remembered as a choice. null puts it
    // back to the field's default (field-choices `choiceLearns`).
    if (typeof args.learns === "boolean" || args.learns === null) patch.learns = args.learns;
    if (Object.keys(patch).length === 0) {
      if (hidden !== undefined) {
        return {
          ok: true,
          summary: `"${found.label}" on ${(await kindWords(ctx.orgId, entityKind)).many} is ${hidden ? "hidden" : "showing again"}`,
          data: { name: found.name, entity_kind: entityKind, before, changed: { hidden: true } },
        };
      }
      return {
        ok: false,
        error: "nothing to change — pass a new display_label, required, choices, add_choices, remove_choices, learns, unit, or hidden",
      };
    }
    const result = await updateFieldDef(ctx.orgId, found.id, patch);
    if (!result.ok) return { ok: false, error: result.message };
    const changed = Object.keys(patch)
      .map((k) =>
        k === "display_label"
          ? `now called "${result.def.display_label}"`
          : k === "learns"
            ? patch.learns === false
              ? "no longer remembers new entries"
              : "remembers new entries"
            : k.replace(/_/g, " "),
      )
      .join(", ");
    const onlyChoices = Object.keys(patch).length === 1 && patch.choices !== undefined;
    const summary =
      onlyChoices && edited
        ? choicesSentence(found.label, edited)
        : onlyChoices && Array.isArray(patch.choices)
          ? `"${found.label}" choices are now: ${(patch.choices as string[]).join(", ") || "none"}`
          : `"${found.label}" on ${(await kindWords(ctx.orgId, entityKind)).many}: ${changed}`;
    return {
      ok: true,
      summary,
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
          learns: "learns" in patch,
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
      if (changed.learns) args.learns = before.learns ?? null;
    }
    if (changed.hidden) args.hidden = before.hidden;
    return Object.keys(args).length > 2 ? { action_id: "platform:edit-field", args } : null;
  });

  // Two fields on one kind that mean one thing, settled into one (#4518): the
  // values of the one let go move into the one kept (only where it is empty),
  // and the one let go is hidden and loses the meaning, so the kind holds one
  // field per meaning again. A person's yes, never automatic; undoable.
  registerHandler("platform.settle-same-meaning", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const entityKind = str(args.entity_kind);
    const keepSaid = str(args.keep);
    const dropSaid = str(args.drop);
    if (!entityKind || !keepSaid || !dropSaid) return { ok: false, error: "entity_kind, keep and drop are required" };
    const fields = await kindFieldsWithMeaning(ctx.orgId, entityKind);
    const pick = (said: string) => fields.find((f) => f.name === said) ?? fields.find((f) => f.label.toLowerCase() === said.toLowerCase());
    const keep = pick(keepSaid);
    const drop = pick(dropSaid);
    const words = await kindWords(ctx.orgId, entityKind);
    if (!keep || !drop) return { ok: false, error: `${words.many} have no field called "${!keep ? keepSaid : dropSaid}"` };
    if (keep.name === drop.name) return { ok: false, error: "Those are the same field." };
    if (!keep.field_role || keep.field_role !== drop.field_role) {
      return { ok: false, error: `"${keep.label}" and "${drop.label}" do not mean the same thing, so there is nothing to settle.` };
    }
    if (drop.source !== "custom") {
      return { ok: false, error: `"${drop.label}" comes with the table, so it stays. Keep it and let "${keep.label}" go instead, or hide it from the field's settings.` };
    }
    const dropDef = (await resolveFieldDefsForKind(ctx.orgId, entityKind)).find((d) => d.name === drop.name);
    if (!dropDef) return { ok: false, error: `"${drop.label}" could not be found to settle.` };
    const moves = await moveFieldValues(ctx.orgId, entityKind, drop.name, keep.name, { nativeTo: keep.source === "built-in" });
    const wasHidden = (await readFieldOverride(ctx.orgId, entityKind, drop.name)).hidden;
    await meta.updateTable("module_field_defs").set({ field_role: null }).where("id", "=", dropDef.id).where("org_id", "=", ctx.orgId).execute();
    await upsertNativeFieldOverride(ctx.orgId, entityKind, drop.name, { hidden: true });
    const moved = moves.filter((m) => m.wrote).length;
    const left = moves.length - moved;
    return {
      ok: true,
      summary:
        `"${keep.label}" is the one ${words.many} use now: ${moved} value${moved === 1 ? "" : "s"} moved from "${drop.label}", which is hidden` +
        (left ? `; ${left} stayed in "${drop.label}" because "${keep.label}" already had a value there` : "") +
        ".",
      data: { entity_kind: entityKind, keep: keep.name, keep_native: keep.source === "built-in", drop: drop.name, drop_id: dropDef.id, drop_role: drop.field_role, was_hidden: wasHidden, moves },
    };
  });
  registerUndo("platform.settle-same-meaning", (result) => {
    const d = (result as { data?: Record<string, unknown> } | null)?.data;
    if (!d?.drop_id) return null;
    return { action_id: "platform:unsettle-same-meaning", args: { ...d } };
  });
  registerHandler("platform.unsettle-same-meaning", async (ctx: ActionInvokeContext) => {
    const a = (ctx.args ?? {}) as { entity_kind?: string; keep?: string; keep_native?: boolean; drop?: string; drop_id?: string; drop_role?: string; was_hidden?: boolean; moves?: FieldMove[] };
    if (!a.entity_kind || !a.keep || !a.drop || !a.drop_id) return { ok: false, error: "entity_kind, keep, drop and drop_id are required" };
    const back = await unmoveFieldValues(ctx.orgId, a.entity_kind, a.drop, a.keep, a.moves ?? [], { nativeTo: !!a.keep_native });
    await meta.updateTable("module_field_defs").set({ field_role: a.drop_role ?? null }).where("id", "=", a.drop_id).where("org_id", "=", ctx.orgId).execute();
    await upsertNativeFieldOverride(ctx.orgId, a.entity_kind, a.drop, { hidden: !!a.was_hidden });
    return { ok: true, summary: `Both fields are back as they were (${back} value${back === 1 ? "" : "s"} put back).`, data: { put_back: back } };
  });

  // The seller upgrade (#4518): yes moves every seller note into a Seller
  // field of its own; no is never asked again for the kind.
  registerHandler("platform.track-sellers", async (ctx: ActionInvokeContext) => {
    const kind = str(((ctx.args ?? {}) as Record<string, unknown>).entity_kind);
    if (!kind) return { ok: false, error: "entity_kind is required" };
    const r = await trackSellers(ctx.orgId, kind);
    if (!r.ok) return { ok: false, error: r.error };
    const moved = r.moves.filter((m) => m.wrote).length;
    const words = await kindWords(ctx.orgId, kind);
    return {
      ok: true,
      summary: `${words.many} track sellers as their own field now: ${moved} seller${moved === 1 ? "" : "s"} moved into "${r.field.label}".`,
      data: { entity_kind: kind, field_id: r.field.id, field_name: r.field.name, host: r.host, moves: r.moves, previous: r.previous },
    };
  });
  registerUndo("platform.track-sellers", (result) => {
    const d = (result as { data?: Record<string, unknown> } | null)?.data;
    if (!d?.field_id) return null;
    return { action_id: "platform:untrack-sellers", args: { ...d } };
  });
  registerHandler("platform.untrack-sellers", async (ctx: ActionInvokeContext) => {
    const a = (ctx.args ?? {}) as { entity_kind?: string; field_id?: string; field_name?: string; host?: string; moves?: FieldMove[]; previous?: "offered" | "declined" | "accepted" | null };
    if (!a.entity_kind || !a.field_id || !a.field_name || !a.host) return { ok: false, error: "entity_kind, field_id, field_name and host are required" };
    const back = await untrackSellers(ctx.orgId, a.entity_kind, { field_id: a.field_id, field_name: a.field_name, host: a.host, moves: a.moves ?? [], previous: a.previous ?? null });
    return { ok: true, summary: `Sellers are notes beside where things came from again (${back} put back).`, data: { put_back: back } };
  });
  registerHandler("platform.decline-seller-field", async (ctx: ActionInvokeContext) => {
    const kind = str(((ctx.args ?? {}) as Record<string, unknown>).entity_kind);
    if (!kind) return { ok: false, error: "entity_kind is required" };
    await declineSellers(ctx.orgId, kind);
    return { ok: true, summary: `Not asked again for ${(await kindWords(ctx.orgId, kind)).many}. The Fields page still offers it.` };
  });

  registerHandler("platform.remove-field", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const said = str(args.field);
    if (!said) return { ok: false, error: "field is required" };
    let entityKind = str(args.entity_kind);
    if (!entityKind) {
      const worked = await kindOfField(ctx.orgId, said, args);
      if ("error" in worked) return { ok: false, error: worked.error };
      entityKind = worked.kind;
    }
    const found = await findField(ctx.orgId, entityKind, said);
    if ("error" in found) return { ok: false, error: found.error };
    const wide = scopeRefusal(found, await kindWords(ctx.orgId, entityKind), "remove");
    if (wide) return wide;
    const result = await deleteFieldDef(ctx.orgId, found.id);
    if (!result.ok) return { ok: false, error: result.message };
    return {
      ok: true,
      // Said out loud, because "removed" reads as "deleted my data" and it is not.
      summary: `"${found.label}" removed from ${(await kindWords(ctx.orgId, entityKind)).many}. Values already recorded are kept.`,
      data: { name: result.def.name },
    };
  });

  /** The arguments group-fields runs on, read once for the plan and the run.
   *  entity_kind and section are required (the schema says so and the door
   *  refuses without them); fields or rename_to is the conditional part
   *  neither a marker nor the door can express, so it is said here. */
  const readGroupFields = (
    args: Record<string, unknown>,
  ): { entityKind: string; section: string; renameTo: string; fields: string[] } | { error: string } => {
    const entityKind = str(args.entity_kind);
    const section = str(args.section);
    const renameTo = str(args.rename_to);
    // A list argument arrives as a comma string, a JSON array or a JSON
    // string of one; namesOf reads all three. This read `str(args.fields)`,
    // which is nothing for an array, so a model that supplied every argument
    // right was told three times that fields were "required" (the 2026-09-22
    // nightly's transcript, #3142).
    const fields = namesOf(args.fields);
    if (!entityKind || !section || (fields.length === 0 && !renameTo)) {
      return { error: "entity_kind and section are required, plus either fields or rename_to" };
    }
    return { entityKind, section, renameTo, fields };
  };

  // What grouping would touch, before a card exists: the kind must be one
  // this workspace has, and each named field must be on it. "put purchase
  // date and supplier under Buying on parts" with no such field was a card
  // that died on press (#3123).
  registerPlanner("platform.group-fields", async (ctx: ActionInvokeContext) => {
    const read = readGroupFields((ctx.args ?? {}) as Record<string, unknown>);
    if ("error" in read) return { error: read.error };
    const kinds = await listKindsForOrg(ctx.orgId);
    const kind = kinds.find((k) => k.id === read.entityKind);
    // ALLOW-INTERNAL-NOUN: echoes the caller's own word for a kind that is not here; there are no words for it, and the kinds that are come in words beside it
    if (!kind) return { error: `"${read.entityKind}" is not a kind of record here; the workspace has ${kindsInWords(kinds)}` };
    const lines: string[] = [];
    const labels: string[] = [];
    for (const f of read.fields) {
      const found = await findField(ctx.orgId, read.entityKind, f);
      if ("error" in found) return { error: found.error };
      lines.push(`${found.label} → under "${read.section}"`);
      labels.push(found.label);
    }
    if (read.renameTo) lines.push(`"${read.section}" → called "${read.renameTo}"`);
    // The card's line names the fields and the kind's words: it read `Put 2
    // field(s) under "Buying" on Part` for a stranger (#3255).
    const many = kindWordsFrom(read.entityKind, kinds, pluralise).many;
    return {
      title: read.renameTo
        ? `Rename the "${read.section}" heading on ${many} to "${read.renameTo}"`
        : `Put ${inWords(labels)} under "${read.section}" on ${many}`,
      lines,
    };
  });

  registerHandler("platform.group-fields", async (ctx: ActionInvokeContext) => {
    const read = readGroupFields((ctx.args ?? {}) as Record<string, unknown>);
    if ("error" in read) return { ok: false, error: read.error };
    const { entityKind, section, renameTo, fields } = read;
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
    const fields = namesOf(args.fields);
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
      summary: `"${displayName}" created, a list of its own`,
      // The kind id is what every other tool needs to act on the new list.
      data: {
        instance: result.instance.instance_name,
        module: result.instance.module_name,
        kind: `${result.instance.instance_name}:item`,
      },
    };
  });

  // A new list is the lightest shape that fits a new kind of thing: the same
  // records as a module the workspace has, under a name of its own. The card
  // says which module it is kept like and what that brings, so "a Mugs list"
  // is never a mystery shape (#4574).
  registerPlanner("platform.create-instance", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const moduleName = str(args.module_name).toLowerCase();
    const displayName = str(args.display_name);
    if (!moduleName || !displayName) return { error: "module_name and display_name are required" };
    const like = findModule(moduleName);
    if ("error" in like) return { error: like.error };
    const instanceName = str(args.instance_name).toLowerCase() || instanceSlugFromName(displayName);
    if (instanceName && (await getInstance(ctx.orgId, instanceName))) return { error: `There is already a list called ${displayName}.` };
    const kind = (await listKindsForOrg(ctx.orgId)).find((k) => k.module_name === like.name && !k.instance_name);
    const fields = (kind?.fields ?? []).filter((f) => !f.readOnly).slice(0, 5).map((f) => humanise(f.name));
    return {
      title: `Make a list called ${displayName}, kept like ${like.label}`,
      lines: [
        `${displayName} keeps the same kind of record as ${like.label}${fields.length ? `: ${inWords(fields)}` : ""}.`,
        "It gets its own place in the menu and its own label codes.",
        "It can be taken away again while nothing is filed in it.",
      ],
    };
  });
  registerUndo("platform.create-instance", (result) => {
    const d = (result as { data?: { instance?: unknown } } | null)?.data;
    return typeof d?.instance === "string" ? { action_id: "platform:remove-list", args: { list: d.instance } } : null;
  });

  /** A list made from a module, taken away while it is empty. A list with
   *  records in it is refused with their count: removing it would take them
   *  too, and that is a different, bigger thing to ask for. */
  const emptyList = async (orgId: string, said: string): Promise<{ name: string; label: string; module: string; display: string } | { error: string }> => {
    const found = await findInstance(orgId, said);
    if ("error" in found) return found;
    const inst = await getInstance(orgId, found.name);
    if (!inst) return { error: `no list called "${said}"` };
    if (inst.is_default) return { error: `${found.label} is the feature's own list; turn the feature off instead.` };
    const held = await countInstanceItems(orgId, found.module, found.name);
    if (held === null) return { error: `Couldn't check what is in ${found.label}, so it was left alone.` };
    if (held > 0) return { error: `${found.label} still holds ${countOf(held, "record")}. Move or delete them first.` };
    return { ...found, display: inst.display_name ?? found.label };
  };
  registerPlanner("platform.remove-list", async (ctx: ActionInvokeContext) => {
    const said = str((ctx.args ?? {}).list);
    if (!said) return { error: "list is required (its name, e.g. Mugs)" };
    const found = await emptyList(ctx.orgId, said);
    if ("error" in found) return { error: found.error };
    return {
      title: `Remove the ${found.display} list`,
      lines: ["It is empty, so nothing filed is lost.", "Its place in the menu and its label codes go with it."],
    };
  });
  registerHandler("platform.remove-list", async (ctx: ActionInvokeContext) => {
    const said = str((ctx.args ?? {}).list);
    if (!said) return { ok: false, error: "list is required (its name, e.g. Mugs)" };
    const found = await emptyList(ctx.orgId, said);
    if ("error" in found) return { ok: false, error: found.error };
    await tearDownInstance(ctx.orgId, found.name);
    return {
      ok: true,
      summary: `Removed the ${found.display} list.`,
      data: { instance: found.name, module: found.module, display_name: found.display },
    };
  });
  registerUndo("platform.remove-list", (result) => {
    const d = (result as { data?: { instance?: unknown; module?: unknown; display_name?: unknown } } | null)?.data;
    if (typeof d?.instance !== "string" || typeof d.module !== "string") return null;
    return {
      action_id: "platform:create-instance",
      args: { module_name: d.module, display_name: typeof d.display_name === "string" ? d.display_name : d.instance, instance_name: d.instance },
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
      // The same 'user' claim the screen records, so a later bundle uninstall
      // never auto-disables a feature someone asked for by name.
      result = await enableModuleForOrg(ctx.orgId, found.name, { userId: ctx.userId ?? undefined, claimedBy: USER_SOURCE });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : `couldn't turn on ${found.label}` };
    }
    // Already on is declined, not acted: nothing was enabled. Said as ok it
    // read as a pass on every seed that turns everything on (#3141).
    if (result.alreadyEnabled) {
      return { ok: false, skipped: true, error: `${found.label} was already on`, data: { module: found.name, already_enabled: true } };
    }
    return { ok: true, summary: `${found.label} is on`, data: { module: found.name, already_enabled: false } };
  });

  // Turning it off again. A feature that was already on was left as it was,
  // so there is nothing to put back.
  registerUndo("platform.enable-module", (result) => {
    const d = (result as { data?: { module?: unknown; already_enabled?: unknown } } | null)?.data;
    if (typeof d?.module !== "string" || d.already_enabled) return null;
    return { action_id: "platform:disable-module", args: { module: d.module } };
  });

  // What the card says, in words a person reads: the feature by its name and
  // what turning it on or off does to their workspace. Without these the card
  // showed the action's name and its argument's label, which is a prompt for
  // the assistant ("The feature, by its name in the app (e.g. Shipments)").
  registerPlanner("platform.enable-module", async (ctx: ActionInvokeContext) => {
    const said = str((ctx.args ?? {}).module);
    if (!said) return { error: "module is required (the feature's name, e.g. Purchases)" };
    const found = findModule(said);
    if ("error" in found) return { error: found.error };
    return {
      title: `Turn on the ${found.label} feature`,
      lines: [`${found.label} appears in the menu for everyone in this workspace.`],
    };
  });

  registerPlanner("platform.disable-module", async (ctx: ActionInvokeContext) => {
    const said = str((ctx.args ?? {}).module);
    if (!said) return { error: "module is required (the feature's name, e.g. Shipments)" };
    const found = findModule(said);
    if ("error" in found) return { error: await notAModuleButABundle(ctx.orgId, said, found.error) };
    return {
      title: `Turn off the ${found.label} feature`,
      lines: [
        `${found.label} leaves the menu for everyone in this workspace.`,
        "Its records are kept, and come back if you turn it on again.",
        `The fields and automations that came with ${found.label} are removed.`,
      ],
    };
  });

  /** The installed bundle a person NAMED: by the bundle's own name, or by the
   *  name of a table it made ("yarn" for the Yarn bundle's Yarn). */
  const findBundle = async (orgId: string, said: string): Promise<{ id: string; name: string; external_id: string } | { error: string }> => {
    const rows = await meta.selectFrom("bundles").select(["id", "name", "external_id"]).where("org_id", "=", orgId).execute();
    if (rows.length === 0) return { error: "this workspace has no bundles installed" };
    const byName = matchByLabel(said, rows.map((r) => ({ ...r, label: r.name })));
    if (byName && !("ambiguous" in byName)) return byName;
    const [instances, claims] = await Promise.all([listInstances(orgId), Promise.all(rows.map((r) => claimsForSource(orgId, r.external_id)))]);
    const tables = rows.flatMap((r, i) =>
      (claims[i] ?? [])
        .filter((c) => c.resource_type === "instance")
        .map((c) => ({ ...r, label: instances.find((x) => x.instance_name === c.resource_key)?.display_name ?? c.resource_key })),
    );
    const byTable = matchByLabel(said, tables);
    if (byTable && !("ambiguous" in byTable)) return { id: byTable.id, name: byTable.name, external_id: byTable.external_id };
    const hit = byName ?? byTable;
    if (hit && "ambiguous" in hit) return { error: `"${said}" could be ${hit.ambiguous.map((a) => `"${a.label}"`).join(" or ")}; which one?` };
    return { error: `no bundle called "${said}"; installed: ${rows.map((r) => r.name).join(", ")}` };
  };
  /** "Turn off yarn" names a table a bundle made, not a feature: say which
   *  action removes it, so the assistant asks again with the right one
   *  instead of telling the person it cannot be done. */
  const notAModuleButABundle = async (orgId: string, said: string, otherwise: string): Promise<string> => {
    const b = await findBundle(orgId, said).catch(() => ({ error: "" }));
    return "error" in b ? otherwise : `"${said}" is not a feature but the ${b.name} bundle: remove it with platform:remove-bundle (bundle: "${b.name}", delete_records: true only when its records should go too)`;
  };
  const wantsRecordsGone = (args: Record<string, unknown> | undefined) => args?.delete_records === true || args?.delete_records === "true";

  registerPlanner("platform.remove-bundle", async (ctx: ActionInvokeContext) => {
    const said = str((ctx.args ?? {}).bundle);
    if (!said) return { error: "bundle is required (its name, e.g. Groceries)" };
    const found = await findBundle(ctx.orgId, said);
    if ("error" in found) return { error: found.error };
    const { previewBundleUninstall } = await import("../routes/bundles.js");
    const p = await previewBundleUninstall(ctx.orgId, found.external_id);
    const gone = wantsRecordsGone(ctx.args);
    // Counted after the plan's earlier steps: a record a step before deletes
    // is not one this removal deletes or keeps.
    const goneBefore = (name: string) => (ctx.before ?? []).filter((b) => b.op === "delete" && b.kind.split(":")[0] === name).length;
    const left = p.instances.map((i) => ({ ...i, before: Math.min(goneBefore(i.name), i.item_count), item_count: Math.max(0, i.item_count - goneBefore(i.name)) }));
    const records = left.reduce((n, i) => n + i.item_count, 0);
    const lines: string[] = [];
    for (const i of left) {
      const emptied = i.before > 0 ? ` The step before deletes ${i.before === 1 ? "its record" : `${i.before} of its records`}.` : "";
      lines.push(
        i.item_count === 0
          ? gone
            ? i.before > 0
              ? `${i.display_name} is deleted, with nothing left in it.${emptied}`
              : `${i.display_name} is deleted. It holds no records yet.`
            : i.before > 0
              ? `The ${i.display_name} list stays, empty.${emptied}`
              : `The ${i.display_name} list stays. It holds no records yet.`
          : gone
            ? `${i.display_name} is deleted with its ${countOf(i.item_count, "record")}. This cannot be undone.${emptied}`
            : `Your ${countOf(i.item_count, `${i.display_name.toLowerCase()} record`)} ${i.item_count === 1 ? "stays" : "stay"}, and can still be found and opened.${emptied}`,
      );
    }
    lines.push(`The fields, views and automations that came with ${found.name} are removed.`);
    if (p.module_names.length) lines.push(`Turned off, as nothing else uses ${p.module_names.length === 1 ? "it" : "them"}: ${p.module_names.join(", ")}.`);
    if (p.places.length) lines.push(`Empty places it made are removed: ${p.places.map((x) => x.name).join(", ")}.`);
    for (const k of p.kept) lines.push(`Kept: ${k.name} (${k.reason}).`);
    return {
      title:
        gone && records > 0
          ? `Remove ${found.name} and its ${countOf(records, "record")} (permanent)`
          : gone
            ? `Remove ${found.name} (permanent)`
            : records > 0
              ? `Remove what ${found.name} added; your records stay`
              : `Remove what ${found.name} added`,
      lines,
    };
  });

  registerHandler("platform.remove-bundle", async (ctx: ActionInvokeContext) => {
    const said = str((ctx.args ?? {}).bundle);
    if (!said) return { ok: false, error: "bundle is required (its name, e.g. Groceries)" };
    const found = await findBundle(ctx.orgId, said);
    if ("error" in found) return { ok: false, error: found.error };
    const { removeBundle } = await import("../routes/bundles.js");
    const deleteData = wantsRecordsGone(ctx.args);
    const out = await removeBundle(ctx.orgId, found, { deleteData });
    return {
      ok: true,
      summary: `${found.name} is removed.${out.kept_words.length ? ` ${out.kept_words.join(" ")}` : ""}`,
      data: { bundle: found.name, removed: out.removed.map((r) => r.name), kept: out.kept.map((k) => k.name), deleted_records: deleteData },
    };
  });

  registerHandler("platform.disable-module", async (ctx: ActionInvokeContext) => {
    const said = str((ctx.args ?? {}).module);
    if (!said) return { ok: false, error: "module is required (the feature's name, e.g. Shipments)" };
    const found = findModule(said);
    if ("error" in found) return { ok: false, error: await notAModuleButABundle(ctx.orgId, said, found.error) };
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

    // The thing by its ID, before its label: the assistant reads kind ids
    // ("machines:machine") and instance names ("pantry") off
    // list_record_kinds and get_workspace_setup and hands one back as the
    // target, which is not wrong, only not a label (#3123). An instance's
    // own name wins over the kind synthesised from it, as below.
    // A list's presentation row is keyed `<module>:<instance>`, the key the
    // nav, the palette and the list's own page read. Keyed by the bare name it
    // was written where nothing looked, and a rename through the assistant
    // said done and changed nothing (#4495).
    const instanceRowId = (i: { module_name: string; instance_name: string }) => `${i.module_name}:${i.instance_name}`;
    const byInstanceName = instances.find((i) => !i.is_default && i.instance_name === said.trim());
    if (byInstanceName) {
      const id = instanceRowId(byInstanceName);
      const label = labelOf("instance", id, byInstanceName.display_name ?? byInstanceName.instance_name);
      return {
        targetKind: "instance",
        targetId: id,
        label,
        before: { name: label, plural: pluralOf("instance", id, pluralise(label)) },
      };
    }
    const byKindId = kinds.find((k) => k.id === said.trim());
    if (byKindId) {
      const label = labelOf("entity_kind", byKindId.id, byKindId.display_name);
      return {
        targetKind: "entity_kind",
        targetId: byKindId.id,
        label,
        before: { name: label, plural: pluralOf("entity_kind", byKindId.id, byKindId.display_name_plural ?? pluralise(label)) },
      };
    }

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
      const id = instanceRowId(i);
      const label = labelOf("instance", id, i.display_name ?? i.instance_name);
      candidates.push({
        label,
        targetKind: "instance",
        targetId: id,
        before: { name: label, plural: pluralOf("instance", id, pluralise(label)) },
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
        (a) => !(a.targetKind === "instance") && !(inst && a.targetId === `${inst.targetId.split(":").pop()}:item`),
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

  // The rename, before the card: which thing, and what it is called now.
  registerPlanner("platform.rename-thing", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const said = str(args.target);
    const name = str(args.name);
    if (!said || !name) return { error: "target and name are required" };
    const found = await findThing(ctx.orgId, said);
    if ("error" in found) return { error: found.error };
    const plural = str(args.plural) || pluralise(name);
    return {
      title: `Call "${found.label}" ${plural} from now on`,
      lines: [`one: ${found.before.name} → ${name}`, `several: ${found.before.plural} → ${plural}`],
    };
  });

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

  // What a kind calls the things inside its records, by the list's name.
  const kindOfFound = (found: { targetKind: "entity_kind" | "instance"; targetId: string }): string =>
    found.targetKind === "instance" ? `${found.targetId.split(":").pop()}:item` : found.targetId;
  registerHandler("platform.rename-contents", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const said = str(args.target);
    if (!said) return { ok: false, error: "target is required" };
    const found = await findThing(ctx.orgId, said);
    if ("error" in found) return { ok: false, error: found.error };
    const kind = kindOfFound(found);
    const before = await contentsWordOf(ctx.orgId, kind);
    const now = await setContentsWord(ctx.orgId, kind, str(args.word) || null);
    return {
      ok: true,
      summary: `What is inside ${found.label} is now called ${contentsWordText(now)}`,
      data: { target: found.label, kind, word: now.word, before: before.custom },
    };
  });
  // What a person types into a field that learns becomes one of its choices
  // (@cobblr/platform-contract/field-choices), from the list the person sees
  // and in any spelling only once. Its undo takes it back off.
  registerHandler("platform.learn-choice", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const kind = str(args.entity_kind);
    const field = str(args.field);
    const value = str(args.value)?.replace(/\s+/g, " ");
    if (!kind || !field || !value) return { ok: false, error: "entity_kind, field and value are required" };
    const def = await effectiveFieldDef(ctx.orgId, kind, field);
    if (!def) return { ok: false, error: `no field "${field}" on ${(await kindWords(ctx.orgId, kind)).many}` };
    const data = { learned: false, entity_kind: kind, field, value };
    if (!choiceLearns(def)) return { ok: true, summary: `"${def.display_label}" does not remember new entries`, data };
    const next = withLearnedChoice(def.choices, value);
    if (!next) return { ok: true, summary: `"${value}" is already a choice for ${def.display_label}`, data };
    const r = await updateFieldDef(ctx.orgId, def.id, { choices: next });
    if (!r.ok) return { ok: false, error: r.message };
    return { ok: true, summary: `"${value}" is now a choice for ${def.display_label}`, data: { ...data, learned: true } };
  });
  registerUndo("platform.learn-choice", (result) => {
    const d = (result as { data?: { learned?: unknown; entity_kind?: unknown; field?: unknown; value?: unknown } } | null)?.data;
    if (!d?.learned || typeof d.entity_kind !== "string" || typeof d.field !== "string" || typeof d.value !== "string") return null;
    return { action_id: "platform:forget-choice", args: { entity_kind: d.entity_kind, field: d.field, value: d.value } };
  });
  registerHandler("platform.forget-choice", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const kind = str(args.entity_kind);
    const field = str(args.field);
    const value = str(args.value);
    if (!kind || !field || !value) return { ok: false, error: "entity_kind, field and value are required" };
    const def = await effectiveFieldDef(ctx.orgId, kind, field);
    if (!def) return { ok: false, error: `no field "${field}" on ${(await kindWords(ctx.orgId, kind)).many}` };
    const next = (def.choices ?? []).filter((c) => !sameChoice(c, value));
    if (next.length === (def.choices ?? []).length) return { ok: true, summary: `"${value}" was not a choice`, data: { forgot: false } };
    const r = await updateFieldDef(ctx.orgId, def.id, { choices: next });
    if (!r.ok) return { ok: false, error: r.message };
    return { ok: true, summary: `"${value}" is no longer a choice for ${def.display_label}`, data: { forgot: true } };
  });

  registerUndo("platform.rename-contents", (result) => {
    const d = (result as { data?: { target?: unknown; before?: unknown } } | null)?.data;
    if (typeof d?.target !== "string") return null;
    return { action_id: "platform:rename-contents", args: { target: d.target, word: typeof d.before === "string" ? d.before : "" } };
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
      return { error: `none of those ids is a record in ${from.label}; pass record ids, not names` };
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

  // A thing that left: sold, given away, thrown out. One door for every kind
  // whose writer can retire a record (dispositions.ts).
  const goneArgs = (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const kind = str(args.entity_kind);
    const ids = readListArg(args, "ids");
    return { args, kind, ids };
  };
  const goneTitles = async (orgId: string, kind: string, ids: readonly string[]) => {
    const lines: string[] = [];
    for (const id of ids.slice(0, 200)) lines.push((await lookup(orgId, kind, id).catch(() => null))?.title ?? `a record that no longer exists (${id.slice(0, 8)})`);
    return lines;
  };
  const priceArg = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""));
    return String(v ?? "").trim() && Number.isFinite(n) ? n : null;
  };

  registerHandler("platform.mark-gone", async (ctx: ActionInvokeContext) => {
    const { args, kind, ids } = goneArgs(ctx);
    if (!kind) return { ok: false, error: "entity_kind (the kind of record) is required" };
    if (!ids.length) return { ok: false, error: "ids are required - read the records first and pass their real ids, never their names" };
    const how = dispositionOf(args.how);
    if (!how) return { ok: false, error: "how is required: sold, given away, parted out, converted, traded, lost or disposed of" };
    const r = await markGone(ctx.orgId, ctx.userId, kind, ids, { how, on: str(args.on) || null, price: priceArg(args.price), to: str(args.to) || null, note: str(args.note) || null });
    if (!r.ok) return { ok: false, error: r.error };
    const n = r.done.length;
    const word = DISPOSITION_LABELS[how];
    return {
      ok: true,
      summary: n === 1 ? `Marked ${r.done[0]!.title} as ${word}.` : `Marked ${n} records as ${word}.`,
      data: { kind, how, touched: r.done.map((d) => ({ kind, id: d.id })), before: r.done.map((d) => ({ id: d.id, before: d.before })) },
    };
  });
  registerPlanner("platform.mark-gone", async (ctx: ActionInvokeContext) => {
    const { args, kind, ids } = goneArgs(ctx);
    if (!kind) return { error: "entity_kind (the kind of record) is required" };
    if (!ids.length) return { error: "ids are required - read the records first and pass their real ids, never their names" };
    const how = dispositionOf(args.how);
    if (!how) return { error: "how is required: sold, given away, parted out, converted, traded, lost or disposed of" };
    const lines = await goneTitles(ctx.orgId, kind, ids);
    return { title: `Mark ${countOf(lines.length, "record")} as ${DISPOSITION_LABELS[how]}`, lines };
  });
  registerUndo("platform.mark-gone", (result) => {
    const d = (result as { data?: { kind?: unknown; touched?: Array<{ id?: unknown }> } } | null)?.data;
    const ids = (d?.touched ?? []).map((t) => t.id).filter((id): id is string => typeof id === "string");
    if (!ids.length || typeof d?.kind !== "string") return null;
    return { action_id: "platform:bring-back", args: { entity_kind: d.kind, ids } };
  });

  registerHandler("platform.bring-back", async (ctx: ActionInvokeContext) => {
    const { kind, ids } = goneArgs(ctx);
    if (!kind) return { ok: false, error: "entity_kind (the kind of record) is required" };
    if (!ids.length) return { ok: false, error: "ids are required - read the records first and pass their real ids, never their names" };
    const r = await bringBack(ctx.orgId, ctx.userId, kind, ids);
    if (!r.ok) return { ok: false, error: r.error, ...(r.blocked ? { blocked: r.blocked } : {}) };
    const n = r.done.length;
    return {
      ok: true,
      summary: n === 1 ? `${r.done[0]!.title} is yours again.` : `${n} records are yours again.`,
      data: { kind, touched: r.done.map((d) => ({ kind, id: d.id })), before: r.done.map((d) => ({ id: d.id, before: d.before })) },
    };
  });
  registerPlanner("platform.bring-back", async (ctx: ActionInvokeContext) => {
    const { kind, ids } = goneArgs(ctx);
    if (!kind) return { error: "entity_kind (the kind of record) is required" };
    if (!ids.length) return { error: "ids are required - read the records first and pass their real ids, never their names" };
    const lines = await goneTitles(ctx.orgId, kind, ids);
    return { title: `Bring back ${countOf(lines.length, "record")}`, lines };
  });
  // Back to exactly what it said before: one undo per call, so it is offered
  // only when every record had left the same way.
  registerUndo("platform.bring-back", (result) => {
    const d = (result as { data?: { kind?: unknown; before?: Array<{ id?: unknown; before?: RecordDisposition | null }> } } | null)?.data;
    const rows = (d?.before ?? []).filter((b): b is { id: string; before: RecordDisposition } => typeof b.id === "string" && !!b.before);
    if (!rows.length || typeof d?.kind !== "string" || rows.length !== (d?.before ?? []).length) return null;
    const first = rows[0]!.before;
    const same = rows.every((r) => JSON.stringify({ ...r.before, held_since: null }) === JSON.stringify({ ...first, held_since: null }));
    if (!same) return null;
    return {
      action_id: "platform:mark-gone",
      args: { entity_kind: d.kind, ids: rows.map((r) => r.id), how: first.how, on: first.on, price: first.price, to: first.to, note: first.note },
    };
  });

  // Hand records over to someone a share links to (share-offers.ts).
  const offerArgs = async (ctx: ActionInvokeContext): Promise<{ error: string } | { kind: string; ids: string[]; target: { link_id: string; to: string }; userId: string }> => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const kind = str(args.entity_kind);
    const ids = readListArg(args, "ids");
    const said = str(args.to);
    if (!kind) return { error: "entity_kind (the kind of record) is required" };
    if (!ids.length) return { error: "ids are required - read the records first and pass their real ids, never their names" };
    if (!ctx.userId) return { error: "a hand-over is made by a person" };
    const targets = await offerTargets(ctx.orgId, ctx.userId);
    if (!targets.length) return { error: "This workspace is not shared with anyone. Share it first in Settings, Sharing." };
    const target = targets.find((t) => t.link_id === said) ?? targets.find((t) => t.to.toLowerCase() === said.toLowerCase());
    if (!target) return { error: `Not shared with "${said}". Shared with: ${targets.map((t) => t.to).join(", ")}.` };
    return { kind, ids, target, userId: ctx.userId };
  };
  const shareArgs = async (ctx: ActionInvokeContext): Promise<{ error: string } | { kind: string; ids: string[]; target: { link_id: string; to: string } }> => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const kind = str(args.entity_kind);
    const ids = readListArg(args, "ids");
    if (!kind) return { error: "entity_kind (the kind of record) is required" };
    if (!ids.length) return { error: "ids are required - read the records first and pass their real ids, never their names" };
    const target = await findShareTarget(ctx.orgId, str(args.with));
    if ("error" in target) return target;
    return { kind, ids, target };
  };
  for (const [handler, stop] of [["platform.share-with", false], ["platform.stop-sharing", true]] as const) {
    registerHandler(handler, async (ctx: ActionInvokeContext) => {
      const a = await shareArgs(ctx);
      if ("error" in a) return { ok: false, error: a.error };
      const refs = a.ids.map((id) => ({ entity_kind: a.kind, id }));
      const r = stop ? await stopSharingRecords(a.target.link_id, refs) : await shareRecords(a.target.link_id, refs);
      if ("error" in r) return { ok: false, error: r.error };
      const n = r.changed.length;
      if (n === 0) return { ok: true, skipped: true, summary: stop ? `Not shared with ${a.target.to}.` : `Already shared with ${a.target.to}.` };
      return {
        ok: true,
        summary: stop ? (n === 1 ? `No longer shared with ${a.target.to}.` : `${n} things no longer shared with ${a.target.to}.`) : n === 1 ? `Shared with ${a.target.to}.` : `Shared ${n} things with ${a.target.to}.`,
        data: { kind: a.kind, with: a.target.link_id, changed: r.changed.map((c) => c.id) },
      };
    });
    registerPlanner(handler, async (ctx: ActionInvokeContext) => {
      const a = await shareArgs(ctx);
      if ("error" in a) return { error: a.error };
      const lines = await goneTitles(ctx.orgId, a.kind, a.ids);
      return { title: `${stop ? "Stop sharing" : "Share"} ${countOf(lines.length, "thing")} with ${a.target.to}`, lines };
    });
    registerUndo(handler, (result) => {
      const d = (result as { skipped?: unknown; data?: { kind?: unknown; with?: unknown; changed?: unknown } } | null);
      const ids = Array.isArray(d?.data?.changed) ? d.data.changed.filter((x): x is string => typeof x === "string") : [];
      if (d?.skipped || !ids.length || typeof d?.data?.kind !== "string" || typeof d.data.with !== "string") return null;
      return { action_id: stop ? "platform:share-with" : "platform:stop-sharing", args: { entity_kind: d.data.kind, ids, with: d.data.with } };
    });
  }

  // The friend's edits, decided (share-spaces.md §10): by id, by record, or
  // by person. Each run says what it decided, so its undo reopens exactly
  // those, and reopening says what each was, so its undo decides them again.
  const suggestionIds = async (ctx: ActionInvokeContext): Promise<{ error: string } | { ids: string[] }> => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const ids = readListArg(args, "ids");
    if (ids.length) return { ids };
    const kind = str(args.entity_kind);
    const id = str(args.entity_id);
    const from = str(args.from).toLowerCase();
    if (!(kind && id) && !from) return { error: "say which: ids, a record (entity_kind and entity_id), or from (a person's name)" };
    const open = await listShareEdits(ctx.orgId, { ...(kind && id ? { kind, id } : {}), open: true }, 500);
    const picked = from ? open.filter((e) => (e.by_name ?? "").toLowerCase().startsWith(from)) : open;
    return { ids: picked.map((e) => e.id) };
  };
  /** Each edit as a confirm card says it: "Voron: Colour green → blue (Vince)". */
  const suggestionLines = async (orgId: string, ids: string[]): Promise<string[]> => {
    const want = new Set(ids);
    const said = await describeShareEdits(orgId, (await listShareEdits(orgId, {}, 1000)).filter((e) => want.has(e.id)));
    return said.map((e) => `${e.title ?? "A record"}: ${e.label} ${e.was ?? "(empty)"} → ${e.now ?? "(empty)"}${e.by_name ? ` (${e.by_name})` : ""}`);
  };
  const decideAll = async (ctx: ActionInvokeContext, decision: ShareEditDecision) => {
    const got = await suggestionIds(ctx);
    if ("error" in got) return { ok: false as const, error: got.error };
    const decided: Array<{ id: string; was: string }> = [];
    let refused: string | null = null;
    for (const id of got.ids) {
      const r = await decideShareEdit(ctx.orgId, ctx.userId ?? null, id, decision);
      if (r.ok) decided.push({ id, was: r.status });
      else refused ??= r.error;
    }
    return { ok: true as const, decided, refused, asked: got.ids.length };
  };
  for (const [handler, decision, done, back] of [
    ["platform.accept-suggestions", "accept", "Accepted", "platform:reopen-suggestions"],
    ["platform.reject-suggestions", "reject", "Rejected", "platform:reopen-suggestions"],
  ] as const) {
    registerHandler(handler, async (ctx: ActionInvokeContext) => {
      const r = await decideAll(ctx, decision);
      if (!r.ok) return { ok: false, error: r.error };
      if (!r.decided.length) return r.refused ? { ok: false, error: r.refused } : { ok: true, skipped: true, summary: "Nothing was waiting." };
      return { ok: true, summary: `${done} ${countOf(r.decided.length, "suggested edit")}.${r.refused ? ` ${r.refused}` : ""}`, data: { ids: r.decided.map((d) => d.id) } };
    });
    registerPlanner(handler, async (ctx: ActionInvokeContext) => {
      const got = await suggestionIds(ctx);
      if ("error" in got) return { error: got.error };
      return { title: `${decision === "accept" ? "Accept" : "Reject"} ${countOf(got.ids.length, "suggested edit")}`, lines: await suggestionLines(ctx.orgId, got.ids) };
    });
    registerUndo(handler, (result) => {
      const ids = (result as { data?: { ids?: unknown } } | null)?.data?.ids;
      return Array.isArray(ids) && ids.length ? { action_id: back, args: { ids } } : null;
    });
  }
  registerPlanner("platform.reopen-suggestions", async (ctx: ActionInvokeContext) => {
    const ids = readListArg((ctx.args ?? {}) as Record<string, unknown>, "ids");
    if (!ids.length) return { error: "ids are required" };
    return { title: `Put ${countOf(ids.length, "suggested edit")} back to waiting`, lines: await suggestionLines(ctx.orgId, ids) };
  });
  registerHandler("platform.reopen-suggestions", async (ctx: ActionInvokeContext) => {
    const ids = readListArg((ctx.args ?? {}) as Record<string, unknown>, "ids");
    if (!ids.length) return { ok: false, error: "ids are required" };
    const was = new Map((await listShareEdits(ctx.orgId, {}, 1000)).filter((e) => ids.includes(e.id)).map((e) => [e.id, e.status]));
    const back: Record<"accepted" | "rejected", string[]> = { accepted: [], rejected: [] };
    let refused: string | null = null;
    for (const id of ids) {
      const before = was.get(id);
      const r = await decideShareEdit(ctx.orgId, ctx.userId ?? null, id, "reopen");
      if (r.ok && (before === "accepted" || before === "rejected")) back[before].push(id);
      else if (!r.ok) refused ??= r.error;
    }
    const n = back.accepted.length + back.rejected.length;
    if (!n) return refused ? { ok: false, error: refused } : { ok: true, skipped: true, summary: "Nothing to put back." };
    return { ok: true, summary: `${countOf(n, "suggested edit")} waiting again.`, data: back };
  });
  registerUndo("platform.reopen-suggestions", (result) => {
    const d = (result as { data?: { accepted?: unknown; rejected?: unknown } } | null)?.data;
    const steps = [];
    if (Array.isArray(d?.accepted) && d.accepted.length) steps.push({ action_id: "platform:accept-suggestions", args: { ids: d.accepted } });
    if (Array.isArray(d?.rejected) && d.rejected.length) steps.push({ action_id: "platform:reject-suggestions", args: { ids: d.rejected } });
    return steps.length ? steps : null;
  });

  for (const [handler, take] of [["platform.take-additions", true], ["platform.leave-additions", false]] as const) {
    registerPlanner(handler, async (ctx: ActionInvokeContext) => {
      const ids = readListArg((ctx.args ?? {}) as Record<string, unknown>, "ids");
      if (!ids.length) return { error: "ids are required" };
      const rows = (await listAdditions(ctx.orgId, false)).filter((a) => ids.includes(a.id));
      return { title: `${take ? "Take" : "Leave"} ${countOf(rows.length, "thing")}`, lines: rows.map((a) => `${a.title}${a.by_name ? ` (added by ${a.by_name})` : ""}`) };
    });
    registerHandler(handler, async (ctx: ActionInvokeContext) => {
      const ids = readListArg((ctx.args ?? {}) as Record<string, unknown>, "ids");
      if (!ids.length) return { ok: false, error: "ids are required" };
      const done: string[] = [];
      let refused: string | null = null;
      for (const id of ids) {
        const r = take ? await takeAddition(ctx.orgId, id) : await leaveAddition(ctx.orgId, id);
        if (r.ok) done.push(r.title);
        else refused ??= r.error;
      }
      if (!done.length) return { ok: false, error: refused ?? "Nothing was waiting." };
      const what = done.length === 1 ? done[0]! : countOf(done.length, "thing");
      return { ok: true, summary: `${take ? "Took" : "Left"} ${what}.${refused ? ` ${refused}` : ""}` };
    });
  }

  registerHandler("platform.offer-to", async (ctx: ActionInvokeContext) => {
    const a = await offerArgs(ctx);
    if ("error" in a) return { ok: false, error: a.error };
    const r = await offerRecords(ctx.orgId, a.userId, a.target.link_id, a.kind, a.ids);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, summary: r.offered === 1 ? `Offered it to ${r.to}.` : `Offered ${r.offered} things to ${r.to}.`, data: { offered: r.offered, to: r.to } };
  });
  registerPlanner("platform.offer-to", async (ctx: ActionInvokeContext) => {
    const a = await offerArgs(ctx);
    if ("error" in a) return { error: a.error };
    const lines: string[] = [];
    for (const id of a.ids.slice(0, 200)) lines.push((await lookup(ctx.orgId, a.kind, id).catch(() => null))?.title ?? `a record that no longer exists (${id.slice(0, 8)})`);
    return { title: `Offer ${countOf(lines.length, "thing")} to ${a.target.to}`, lines };
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

  /** The preset and the direction, read once for the plan and the run. By
   *  key or by the words on the switch ("provenance", "Provenance"). */
  const readPresetSwitch = (args: Record<string, unknown>): { key: string; on: boolean } | { error: string } => {
    const said = str(args.preset);
    if (!said) return { error: "preset is required" };
    if (typeof args.on !== "boolean") return { error: "on must be true or false" };
    const byKey = FIELD_PRESETS.find((p) => p.key === said.trim().toLowerCase());
    const matched = byKey
      ? { key: byKey.key }
      : matchByLabel(said, FIELD_PRESETS.map((p) => ({ label: p.label, key: p.key })));
    if (!matched || "ambiguous" in matched) {
      return { error: `no set of fields called "${said}". There is: ${FIELD_PRESETS.map((p) => p.label).join(", ")}` };
    }
    return { key: matched.key, on: args.on };
  };

  // "turn on provenance", before the card: which set, which way, which fields.
  registerPlanner("platform.set-field-preset", async (ctx: ActionInvokeContext) => {
    const read = readPresetSwitch((ctx.args ?? {}) as Record<string, unknown>);
    if ("error" in read) return { error: read.error };
    const preset = FIELD_PRESETS.find((p) => p.key === read.key)!;
    return {
      title: read.on ? `Turn ${preset.label} on` : `Turn ${preset.label} off (what is recorded stays)`,
      lines: preset.fields.map((f) => f.display_label),
    };
  });

  registerHandler("platform.set-field-preset", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const read = readPresetSwitch(args);
    if ("error" in read) return { ok: false, error: read.error };
    const key = read.key;
    const result = args.on ? await turnPresetOn(ctx.orgId, key) : await turnPresetOff(ctx.orgId, key);
    if (!result.ok) return { ok: false, error: result.message };
    const preset = FIELD_PRESETS.find((p) => p.key === key)!;
    return {
      ok: true,
      summary: args.on
        ? `${preset.label} is on: ${countOf((result.created ?? []).length, "field")} added`
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
      summary: `automation "${(await actionLabelOf(result.wire.action_id).catch(() => null)) ?? result.wire.action_id.split(":").pop()?.replace(/[-_]/g, " ")}" is now ${result.wire.enabled ? "on" : "off"}`,
      data: { id: result.wire.id, enabled: result.wire.enabled, before: was?.enabled ?? result.wire.enabled },
    };
  });

  // Set back the way it was; a toggle to what it already was left nothing to undo.
  registerUndo("platform.set-wire-enabled", (result) => {
    const d = (result as { data?: { id?: unknown; enabled?: unknown; before?: unknown } } | null)?.data;
    if (typeof d?.id !== "string" || typeof d.enabled !== "boolean" || typeof d.before !== "boolean" || d.before === d.enabled) return null;
    return { action_id: "platform:set-wire-enabled", args: { wire_id: d.id, enabled: d.before } };
  });

  // ── An assistant's held delete: the two buttons on its person's card ──
  registerHandler("platform.confirm-held-change", async (ctx: ActionInvokeContext) => {
    const changeId = str((ctx.args ?? {}).change_id);
    if (!changeId) return { ok: false, error: "change_id is required" };
    if (!ctx.userId) return { ok: false, error: "a person has to press this" };
    const r = await confirmHeldChange(changeId, ctx.userId);
    return r.ok ? { ok: true, summary: r.message } : { ok: false, error: r.message };
  });
  registerHandler("platform.keep-held-change", async (ctx: ActionInvokeContext) => {
    const changeId = str((ctx.args ?? {}).change_id);
    if (!changeId) return { ok: false, error: "change_id is required" };
    if (!ctx.userId) return { ok: false, error: "a person has to press this" };
    const r = await keepHeldChange(changeId, ctx.userId);
    return r.ok ? { ok: true, summary: r.message } : { ok: false, error: r.message };
  });

  // ── Services: the yes on a waiting job's card (service-confirm.ts) ──
  // The same function the job card's route calls, so who may say yes and
  // what the yes is bound to cannot drift between the doors.
  // A wire that runs a service. The wire door stamps the job (never the
  // wire's word), the gate decides consent, and a job that follows another
  // service job is counted as its next step, so the loop guard sees the
  // whole chain.
  registerHandler("platform.invoke-service", async (ctx: ActionInvokeContext) => {
    const args = ctx.args ?? {};
    const capability = str(args.capability);
    if (!capability) return { ok: false, error: "which service to run is not set" };
    let input: unknown = args.input ?? {};
    if (typeof input === "string") {
      try {
        input = input.trim() ? JSON.parse(input) : {};
      } catch {
        return { ok: false, error: "the service's input is not JSON" };
      }
    }
    const eventName = ctx.event?.name ?? "";
    const payload = (ctx.event?.payload ?? {}) as Record<string, unknown>;
    input = renderEventValues(input, { event: { ...payload, name: eventName } });
    const causedBy = eventName.startsWith("services.job.") ? str(payload.jobId) : "";
    const attachTo = payload.attachTo && typeof payload.attachTo === "object" ? (payload.attachTo as { kind: string; id: string }) : undefined;
    try {
      const ref = await invokeAs(
        { origin: "wire", userId: null },
        {
          orgId: ctx.orgId,
          capability,
          input,
          ...(causedBy ? { causedByJob: causedBy } : {}),
          ...(attachTo ? { attachTo } : {}),
          // One job per event per capability, however often the event is
          // delivered.
          idempotencyKey: `wire:${eventName}:${causedBy || stableJson(payload)}`,
        },
      );
      return {
        ok: true,
        summary: ref.status === "awaiting_confirm" ? `${capability} is waiting for a person to say yes.` : `Started ${capability}.`,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  registerHandler("platform.confirm-service-job", async (ctx: ActionInvokeContext) => {
    const jobId = str((ctx.args ?? {}).job_id);
    if (!jobId) return { ok: false, error: "job_id is required" };
    if (!ctx.userId) return { ok: false, error: "a person has to press this" };
    try {
      await confirmServiceJob(ctx.orgId, jobId, ctx.userId);
      return { ok: true, message: "Started." };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ── The supervisor's buttons on a stuck run (service-supervisor.ts) ──
  // Who may press: the person whose run it is, or an owner or admin for one
  // an automation started (the confirm's rule).
  const stepAllowed = async (orgId: string, jobId: string, userId: string): Promise<string | null> => {
    const job = await platform().services.job(orgId, jobId);
    if (!job) return "There is no such step here.";
    return mayConfirm(orgId, { requested_by: job.requested_by, capability: job.capability }, userId);
  };
  registerHandler("platform.retry-service-job", async (ctx: ActionInvokeContext) => {
    const jobId = str((ctx.args ?? {}).job_id);
    if (!jobId) return { ok: false, error: "job_id is required" };
    if (!ctx.userId) return { ok: false, error: "a person has to press this" };
    const why = await stepAllowed(ctx.orgId, jobId, ctx.userId);
    if (why) return { ok: false, error: why };
    try {
      const ref = await retryJob(ctx.orgId, jobId, ctx.userId);
      return { ok: true, message: ref.status === "awaiting_confirm" ? "Asked again; it waits for a yes." : "Started again." };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  registerHandler("platform.skip-service-job", async (ctx: ActionInvokeContext) => {
    const jobId = str((ctx.args ?? {}).job_id);
    if (!jobId) return { ok: false, error: "job_id is required" };
    if (!ctx.userId) return { ok: false, error: "a person has to press this" };
    const why = await stepAllowed(ctx.orgId, jobId, ctx.userId);
    if (why) return { ok: false, error: why };
    try {
      await skipJob(ctx.orgId, jobId, ctx.userId);
      return { ok: true, message: "Skipped; the run goes on without it." };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  registerHandler("platform.cancel-service-run", async (ctx: ActionInvokeContext) => {
    const jobId = str((ctx.args ?? {}).job_id);
    if (!jobId) return { ok: false, error: "job_id is required" };
    if (!ctx.userId) return { ok: false, error: "a person has to press this" };
    const why = await stepAllowed(ctx.orgId, jobId, ctx.userId);
    if (why) return { ok: false, error: why };
    try {
      const n = await cancelRun(ctx.orgId, jobId, ctx.userId);
      return { ok: true, message: n ? `Cancelled ${n} step${n === 1 ? "" : "s"}.` : "Stopped: nothing more starts from it." };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
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
