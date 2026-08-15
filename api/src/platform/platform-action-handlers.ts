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

import { isFieldScope, type ActionInvokeContext } from "@cobblr/platform-contract";
import { registerHandler } from "./actions.js";
import { listKindsForOrg } from "./entities.js";
import { FieldDefCreate, createFieldDef } from "./field-defs.js";
import { provisionInstance } from "./instances.js";
import { setWireEnabled } from "./wires.js";

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

  registerHandler("platform.set-wire-enabled", async (ctx: ActionInvokeContext) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const wireId = str(args.wire_id);
    if (!wireId) return { ok: false, error: "wire_id is required (see get_workspace_setup, automations)" };
    if (typeof args.enabled !== "boolean") {
      return { ok: false, error: "enabled must be true (on) or false (off)" };
    }
    const result = await setWireEnabled(ctx.orgId, wireId, args.enabled, ctx.userId);
    if (!result.ok) return { ok: false, error: result.message };
    return {
      ok: true,
      summary: `automation ${result.wire.action_id} is now ${result.wire.enabled ? "on" : "off"}`,
      data: { id: result.wire.id, enabled: result.wire.enabled },
    };
  });
}
