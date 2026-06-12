// The prompt compiler — the product, not the model (business-models/06).
//
// assembleContext() gathers the MINIMAL SUFFICIENT CONTEXT for a task:
// the relevant entity-kind schemas + the actions those kinds can be wired
// to + the output contract. compilePrompt() wraps that + the user's
// intent into one deterministic prompt whose answer is a schema-validated
// bundle. The TASK is a parameter (a registry of templates), not a
// hardcode — so create-bundle is the first of a taxonomy (add-view,
// wire-event, …), each with its own context recipe + output contract.

import { platform, type EntityKindRecord } from "@cobblr/platform-contract";
import { getTemplate, type TemplateEntry } from "./templates.js";

export interface ContextField {
  name: string;
  type: string;
  role?: string;
  required?: boolean;
}
export interface ContextKind {
  id: string;
  displayName: string;
  fields: ContextField[];
}
export interface ContextAction {
  id: string;
  label: string;
  description: string;
}
export interface AuthoringContext {
  task: string;
  kinds: ContextKind[];
  actions: ContextAction[];
  outputContract: string;
  /** Present only for task "customize-template": the manifest to start from. */
  baseTemplate?: { id: string; name: string; manifest: Record<string, unknown> };
  /** The requesting user's workspace role — part of the read-only context block
   *  (spec §Feature 2). Surfaced so the user/preview can see that e.g. only an
   *  owner/admin can apply a bundle that enables new modules. Kept OUT of the
   *  generation prompt wording on purpose: the prompt is eval-tuned (authoring-
   *  eval baseline) and must not drift without an eval run. */
  requesterRole?: string;
  warnings: string[];
}

export interface ValidationError {
  path: string;
  code: string;
  message: string;
}

// Minimal sufficient context: too many kinds tanks small-model accuracy
// (it wires to the wrong one). Cap and warn; the UI should push the user
// to pick 1-3.
const MAX_KINDS = 5;

/** Thin wrapper over the kernel's applies-to resolver — the integration
 *  point the spec flagged to confirm. platform().actions.listApplicable
 *  already evaluates each action's `appliesTo` predicate against the
 *  kind, so we don't re-implement matching here. */
export async function listActionsForKind(kind: string, orgId: string): Promise<ContextAction[]> {
  const apps = await platform().actions.listApplicable(kind, orgId);
  return apps.map((a) => ({ id: a.id, label: a.label, description: a.description ?? "" }));
}

export async function assembleContext(
  orgId: string,
  selectedKinds?: string[],
  task = "create-bundle",
  baseTemplateId?: string,
  requesterRole?: string,
): Promise<AuthoringContext> {
  const warnings: string[] = [];

  // customize-template: start from a catalog template. Default the kind
  // scope to the kinds that template touches, so context stays minimal.
  let template: TemplateEntry | undefined;
  if (task === "customize-template") {
    if (!baseTemplateId) {
      throw new Error('Task "customize-template" requires a base_template_id.');
    }
    template = getTemplate(baseTemplateId);
    if (!template) {
      throw new Error(`Unknown template "${baseTemplateId}". Use GET /templates to list available ids.`);
    }
    if (!selectedKinds || selectedKinds.length === 0) selectedKinds = template.kinds;
  }

  // design-workspace (whole-app bundle) and design-app (a worker app over the
  // existing kinds) both legitimately want the FULL catalog; the tighter tasks
  // want a 1-3 kind scope for small-model accuracy.
  const fullCatalogTask = task === "design-workspace" || task === "design-app" || task === "design-app-custom";
  const all = await platform().entities.listKinds();
  let chosen: EntityKindRecord[];
  if (selectedKinds && selectedKinds.length > 0) {
    const byId = new Map(all.map((k) => [k.id, k]));
    chosen = [];
    for (const id of selectedKinds) {
      const k = byId.get(id);
      if (k) chosen.push(k);
      else warnings.push(`Unknown entity kind "${id}" was ignored.`);
    }
  } else {
    chosen = all;
    if (!fullCatalogTask) {
      warnings.push(
        "No kinds selected — using all declared kinds. Pick 1-3 for the best result; a small model wires to the wrong kind when given too many.",
      );
    }
  }
  if (!fullCatalogTask && chosen.length > MAX_KINDS) {
    warnings.push(
      `${chosen.length} kinds in scope — capped to ${MAX_KINDS}. More kinds = lower small-model success rate. Narrow the selection.`,
    );
    chosen = chosen.slice(0, MAX_KINDS);
  }

  const kinds: ContextKind[] = chosen.map((k) => ({
    id: k.id,
    displayName: k.display_name,
    fields: (k.fields ?? []).map((f) => ({ name: f.name, type: f.type, role: f.role, required: f.required })),
  }));

  // Actions wireable to the chosen kinds, deduped by id.
  const actionMap = new Map<string, ContextAction>();
  for (const k of chosen) {
    for (const a of await listActionsForKind(k.id, orgId)) actionMap.set(a.id, a);
  }
  const actions = [...actionMap.values()];

  const baseTemplate = template
    ? { id: template.id, name: template.name, manifest: template.manifest }
    : undefined;

  return { task, kinds, actions, outputContract: OUTPUT_CONTRACT, baseTemplate, requesterRole, warnings };
}

// The compact output contract — field_defs + wires ONLY (v1 scope guard).
// Keeping the output surface minimal is the single biggest small-model
// reliability lever; do not widen it (no saved_views/catalogs/lens) until
// the eval pass-rate on this surface is high.
const OUTPUT_CONTRACT = `{
  "interpretation": "<1-2 plain sentences: what you understood the user wants, and what this bundle does. If the request is too vague or can't be built from the kinds above, say so plainly here and leave field_defs/wires empty.>",
  "bundle": {
    "id": "cobblr.user.<slug>",
    "version": "0.1.0",
    "name": "<short name>",
    "description": "<one line>",
    "requires": [{ "module": "<module>" }],
    "field_defs": [
      { "entity_kind": "<kind>", "name": "<snake_case>", "display_label": "<label>",
        "type": "text|number|boolean|date|url", "choices": ["<optional, for text>"] }
    ],
    "wires": [
      { "source_kind": "<kind>", "action_id": "<action>",
        "trigger_type": "user-invoked|event|on-create|on-update|on-delete",
        "trigger_event": "<optional event name>", "template": "<optional Jinja2>" }
    ]
  }
}`;

type TaskBuilder = (ctx: AuthoringContext, intent: string) => string;

// The task taxonomy. create-bundle is the first + best-bounded task
// (sufficient context = a couple of schemas + intent). Add entries here
// (add-view, wire-event, …) as the surface grows — the compiler shape is
// the same; only the recipe + contract differ.
const TASK_TEMPLATES: Record<string, TaskBuilder> = {
  "create-bundle": (ctx, intent) => {
    const kinds = ctx.kinds
      .map(
        (k) =>
          `- ${k.id} (${k.displayName}) — existing fields: ${
            k.fields.map((f) => `${f.name}:${f.type}`).join(", ") || "(none)"
          }`,
      )
      .join("\n");
    const actions = ctx.actions.length
      ? ctx.actions.map((a) => `- ${a.id} — ${a.label}: ${a.description}`).join("\n")
      : "(none — the selected kinds have no wireable actions; you can only add field_defs)";
    return `You are generating a Cobblr "bundle": a JSON config that adds custom fields and/or event→action wires to an existing app. Output ONLY one JSON object — your "interpretation" (what you understood + what the bundle does) plus the "bundle" — in the exact shape below, nothing else.

ENTITY KINDS you may use (use these ids exactly; do not invent kinds or fields):
${kinds}

ACTIONS you may wire to (use these action ids exactly):
${actions}

THE USER WANTS:
"${intent}"

OUTPUT — match this shape exactly:
${ctx.outputContract}

RULES:
- field_defs add a column to entity_kind. type is one of {text,number,boolean,date,url}.
- field_defs.name must match ^[a-z][a-z0-9_]*$ (snake_case).
- wires.source_kind must be one of the entity kind ids above; wires.action_id must be one of the action ids above. Never reference an id not listed.
- trigger_type is one of {user-invoked,event,on-create,on-update,on-delete}; for "event" also set trigger_event.
- requires must list every module owning a referenced kind/action (module = the id prefix before ":").
- id = "cobblr.user.<kebab-slug>"; version = "0.1.0".`;
  },

  // customize-template: start from a refined template and DIFF it for the
  // user's intent. Cheaper + higher quality than from-scratch — the model
  // edits a known-good manifest instead of inventing one. Same output
  // contract, same kernel gate.
  "customize-template": (ctx, intent) => {
    if (!ctx.baseTemplate) throw new Error("customize-template requires a base template in context.");
    const kinds = ctx.kinds
      .map(
        (k) =>
          `- ${k.id} (${k.displayName}) — existing fields: ${
            k.fields.map((f) => `${f.name}:${f.type}`).join(", ") || "(none)"
          }`,
      )
      .join("\n");
    const actions = ctx.actions.length
      ? ctx.actions.map((a) => `- ${a.id} — ${a.label}: ${a.description}`).join("\n")
      : "(none — you can only add/change field_defs)";
    return `You are customizing an existing Cobblr "${ctx.baseTemplate.name}" template for a user. Start from the template below and MODIFY it to fit what they want — keep what fits, change labels/fields/choices, add what's missing, remove what's irrelevant. Output ONLY one JSON object — your "interpretation" plus the resulting "bundle" — matching the shape below, nothing else.

STARTING TEMPLATE (modify this):
${JSON.stringify(ctx.baseTemplate.manifest, null, 2)}

ENTITY KINDS you may use (use these ids exactly; do not invent kinds):
${kinds}

ACTIONS you may wire to (use these action ids exactly):
${actions}

THE USER WANTS:
"${intent}"

OUTPUT — same shape as the template, matching this contract:
${ctx.outputContract}

RULES:
- Keep the template's structure; this is an EDIT, not a rewrite.
- field_defs.name must match ^[a-z][a-z0-9_]*$ (snake_case). type is one of {text,number,boolean,date,url}.
- wires.source_kind / action_id must be ids listed above. Never reference an id not listed.
- requires must list every module owning a referenced kind/action.
- Give it a fresh id "cobblr.user.<kebab-slug>" reflecting the user's use case; version "0.1.0".`;
  },

  // design-workspace: the "build my whole workspace from one prompt" task. Unlike
  // create-bundle (a tight 1-3 kind scope), this gets the FULL catalog and is
  // expected to ENABLE several modules + add many fields + wires in ONE bundle.
  // The interpretation MUST own the honest part: what a schema bundle can't do
  // (seed category rows, configure scan, create instance data) becomes follow-ups.
  "design-workspace": (ctx, intent) => {
    const kinds = ctx.kinds
      .map(
        (k) =>
          `- ${k.id} (${k.displayName}) — fields: ${
            k.fields.map((f) => `${f.name}:${f.type}`).join(", ") || "(none)"
          }`,
      )
      .join("\n");
    const actions = ctx.actions.length
      ? ctx.actions.map((a) => `- ${a.id} — ${a.label}: ${a.description}`).join("\n")
      : "(none)";
    return `You are the Cobblr workspace architect. From the user's description of the WHOLE workspace they want, design ONE bundle that ENABLES the modules they need and adds the custom fields + wires to support their entire workflow. Cobblr is a no-code platform of composable modules; a "bundle" is the schema that turns a set of modules into their app. Output ONLY one JSON object — your "interpretation" plus the "bundle" — nothing else.

AVAILABLE ENTITY KINDS (the full catalog — every kind here belongs to an installable module; using a kind enables its module via requires):
${kinds}

AVAILABLE ACTIONS to wire:
${actions}

THE USER WANTS THEIR WHOLE WORKSPACE TO BE:
"${intent}"

OUTPUT — one JSON object, this exact shape (the "seed" key is new — read its rule below).
EVERY field_def MUST include "display_label", and "requires" entries are OBJECTS ({ "module": … }), not bare strings — a bundle missing either is rejected:
{
  "interpretation": "<1-2 sentences: what you set up + what you seeded, and any remaining follow-ups>",
  "bundle": {
    "id": "cobblr.user.<slug>",
    "version": "0.1.0",
    "name": "<short subject noun>",
    "description": "<one line>",
    "requires": [{ "module": "<module>" }],
    "field_defs": [
      { "entity_kind": "<kind>", "name": "<snake_case>", "display_label": "<Human Label>",
        "type": "text|number|boolean|date|url", "choices": ["<optional, for text>"] }
    ],
    "wires": [
      { "source_kind": "<kind>", "action_id": "<action>",
        "trigger_type": "user-invoked|event|on-create|on-update|on-delete",
        "trigger_event": "<optional event name>", "template": "<optional Jinja2>" }
    ]
  },
  "seed": [
    { "kind": "<entity kind id>", "records": [ { "<field>": <value>, ... }, ... ] }
  ]
}

RULES:
- name: the bundle's title is the SUBJECT NOUN of what they track — the thing itself ("Yarn", "Home Inventory", "Plants"), NEVER a use-case or capability suffix ("Yarn Tracker", "Yarn Studio", "Crochet Manager"). The depth and use-cases live in the fields/wires you add, not the title. Keep it 1-3 words, a clean noun.
- requires: list EVERY module you use (module = the id prefix before ":"). Listing it ENABLES it for the workspace. Pick the closest-fitting existing kinds — do NOT invent kinds or fields.
- field_defs add columns to an entity_kind. type ∈ {text,number,boolean,date,url}; name must match ^[a-z][a-z0-9_]*$ (snake_case). For a fixed set of options (categories, statuses, sizes), add a text field with a "choices" array — that is how you seed category vocabularies.
- wires.source_kind / action_id must be ids listed above; never reference an unlisted id. trigger_type ∈ {user-invoked,event,on-create,on-update,on-delete}.
- Be comprehensive: model every "thing they track" as a kind + its fields, and every automation they describe as a wire. This is a whole app, not one tweak.
- seed: ONLY records the user EXPLICITLY enumerated as a fixed starter set — e.g. "hooks from 1mm to 10mm" → one record per size; "rooms: kitchen, garage" → one per room. Each record's "kind" must be one you listed in requires/field_defs; its keys are field names from that kind (native like "name", plus the custom field_defs you added — extra keys are stored as custom-field values). Always include a human "name". Do NOT invent data the user didn't describe (no fake yarn colours, no sample parts). If they enumerated nothing concrete, use "seed": [].
- "interpretation" MUST (a) summarise the workspace + what you seeded, and (b) honestly name any remaining follow-ups you could NOT do — e.g. tuning scan/receipt capture rules, or creating extra named module instances/collections. Don't claim more than you built.
- id = "cobblr.user.<kebab-slug>"; version = "0.1.0".${roleNote(ctx)}`;
  },

  // design-app: build a worker APP — a member-facing page of structured blocks
  // (markdown / create-form / action button / scan) the App Player renders.
  // Unlike a bundle (schema), this is a UI; it binds to EXISTING kinds + actions,
  // so every block is referentially checkable by /apps/validate. v1 sticks to the
  // blocks that render from scratch (no saved-view / record blocks that need data
  // or pre-existing views, no custom HTML).
  "design-app": (ctx, intent) => {
    const kinds = ctx.kinds.map((k) => `- ${k.id} (${k.displayName})`).join("\n");
    const actions = ctx.actions.length
      ? ctx.actions.map((a) => `- ${a.id} — ${a.label}: ${a.description}`).join("\n")
      : "(none — you can still use markdown + scan blocks)";
    return `You are designing a Cobblr "app": a member-facing page built from STRUCTURED BLOCKS (not code), rendered by the App Player. Output ONLY one JSON object — your "interpretation" plus the "app" — nothing else.

ENTITY KINDS you may bind forms/actions to (use these ids exactly; do not invent):
${kinds}

ACTIONS you may add as buttons (use these ids exactly; each needs its kind):
${actions}

THE USER WANTS AN APP THAT:
"${intent}"

OUTPUT — one JSON object, this exact shape:
{
  "interpretation": "<1-2 sentences: what the app does + any follow-ups>",
  "app": {
    "slug": "<kebab-case>",
    "name": "<short name>",
    "pages": [
      { "slug": "<kebab>", "title": "<Page Title>", "blocks": [ <blocks> ] }
    ]
  }
}

BLOCK TYPES you may use (these render from scratch — pick from these only):
- { "type": "markdown", "body": "<text with headings / lists>" } — intro / instructions.
- { "type": "form", "kind": "<kind id>", "mode": "create", "fields": ["<field>", ...] } — a create form for a kind (omit "fields" to show all).
- { "type": "action", "action_id": "<action id>", "kind": "<kind id>", "label": "<button text>" } — an action button (action_id MUST apply to that kind).
- { "type": "scan" } — the barcode / photo scanner.

RULES:
- slug + every page.slug must be kebab-case (^[a-z0-9-]+$).
- form.kind / action.kind must be one of the kind ids above; action.action_id must be one of the action ids above AND apply to its kind. Never reference an id not listed.
- Keep it to 1-3 pages. Build something usable: typically a markdown intro + a create form + the relevant action buttons (+ a scan block if they capture physical items).
- Do NOT use saved-view, record, stat, or custom-HTML blocks — they need existing data/views and are out of scope here. If the user asked for something only those could do, say so plainly in "interpretation" and build what you can.`;
  },

  // design-app-custom: the spec's "generate an app (HTML)" path. The app is ONE
  // custom block — a self-contained HTML+JS fragment the App Player renders in a
  // SANDBOXED iframe. The fragment never holds a token or hits the API directly;
  // it reads/writes through the mediated `window.cobblr` bridge, which is bounded
  // by the viewer's capabilities + field-read-scope (so untrusted generated code
  // can never exceed the member). Same validate → repair → apply loop; the kernel
  // validates the app definition (custom block ≤ 200k) before anything is created.
  "design-app-custom": (ctx, intent) => {
    const kinds = ctx.kinds.map((k) => `- ${k.id} (${k.displayName})`).join("\n");
    const actions = ctx.actions.length
      ? ctx.actions.map((a) => `- ${a.id} — ${a.label}: ${a.description}`).join("\n")
      : "(none)";
    return `You are writing a Cobblr CUSTOM APP: a single self-contained HTML+JS fragment the App Player renders in a sandboxed iframe. It reads and writes the workspace ONLY through the injected \`window.cobblr\` bridge — never fetch(), never a token, never the network. Output ONLY one JSON object — your "interpretation" plus the "app" — nothing else.

ENTITY KINDS available (use these ids exactly):
${kinds}

ACTIONS available (use these ids exactly):
${actions}

THE \`window.cobblr\` BRIDGE your code may call (all return Promises):
- cobblr.viewData(viewId, { limit }) — rows of a saved view (read-scoped) → []
- cobblr.entity(kind, id) — one entity (read-scoped)
- cobblr.get(path) — a raw allowlisted GET (advanced)
- cobblr.me() — { role, grants } for the current viewer
- cobblr.can(actionId) — boolean: may the viewer run this action
- cobblr.invoke(actionId, { entityKind, entityId, args }) — run an action (a write)
- cobblr.appLoad(key) / cobblr.appSave(key, value) — this app's OWN private key/value store (use this for the app's saved state; it can't touch real entities)
- cobblr.mount(el, loader, render) — optional helper: shows loading/error around an async loader

THE USER WANTS AN APP THAT:
"${intent}"

OUTPUT — one JSON object, this exact shape:
{
  "interpretation": "<1-2 sentences: what the app does + any follow-ups>",
  "app": {
    "slug": "<kebab-case>",
    "name": "<short name>",
    "pages": [
      { "slug": "main", "title": "<Page Title>", "blocks": [
        { "type": "custom", "html": "<the full HTML+CSS+JS fragment of the app>" }
      ] }
    ]
  }
}

RULES:
- ONE page with ONE custom block. slug + page.slug must be kebab-case.
- The "html" is a self-contained fragment: inline <style> for CSS and <script> for JS; no external <script src>, no CDNs, no fetch(), no top-level network. Keep it under ~12,000 characters.
- Touch data ONLY via window.cobblr.*. For the app's own saved state use appLoad/appSave (a private bag — NOT real entities). Reference kinds/actions/views by the ids listed above.
- Make it actually work end-to-end for the described use — render real data with viewData/entity where relevant, and wire buttons to invoke/appSave. Guard every bridge call with try/catch and show a friendly message on error.
- If the ask truly needs structured blocks (a plain create form, the scanner) instead of custom code, say so in "interpretation" — but otherwise build the working custom app.`;
  },
};

/** A permission-level note appended to the generation prompt ONLY for non-admin
 *  requesters — so a design that enables modules a member can't enable gets
 *  flagged (in interpretation), not silently rejected at apply. Returns "" for
 *  owner/admin, which keeps the authoring-eval baseline (run as an admin token)
 *  byte-for-byte unchanged. */
function roleNote(ctx: AuthoringContext): string {
  const r = ctx.requesterRole;
  if (!r || r === "owner" || r === "admin") return "";
  return `\n- NOTE: your workspace role is "${r}". You may not be able to ENABLE new modules — prefer kinds whose modules are already on, and in "interpretation" call out any module an owner/admin will need to turn on for this to apply.`;
}

export function compilePrompt(context: AuthoringContext, intent: string): string {
  const builder = TASK_TEMPLATES[context.task];
  if (!builder) throw new Error(`Unknown authoring task "${context.task}".`);
  return builder(context, intent);
}

/** The repair prompt: original prompt + the rejected candidate + the
 *  validator's errors, so the user (copy-paste) or the model (hosted,
 *  Phase 2) can fix every error in one shot. */
export function repairPrompt(
  originalPrompt: string,
  candidate: unknown,
  errors: ValidationError[],
): string {
  const errlines = errors.map((e) => `- [${e.code}] ${e.path}: ${e.message}`).join("\n");
  return `${originalPrompt}

YOUR PREVIOUS ANSWER was rejected by the validator:
${JSON.stringify(candidate, null, 2)}

VALIDATION ERRORS — fix EVERY one and output ONLY the corrected JSON object:
${errlines}`;
}

/** Tolerant JSON extraction — strip prose and parse the first {…} block
 *  (same approach as core-scan's enrich-photo). Used for paste-back +
 *  hosted parsing. Returns null if no object parses. */
export function parseJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  const slice = raw.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    // Silent trivial repair (the spec's "auto-fix the trailing comma / smart
    // quote" — fix it locally instead of burning a whole AI repair round-trip
    // on cosmetic noise). Conservative on purpose: only the two highest-
    // frequency, lowest-risk LLM JSON defects. A REAL error (bad field/module
    // ref, schema violation) survives this untouched and is caught by the
    // kernel validator + the repair loop. The output is re-validated regardless,
    // so a bad repair is never worse than today's outright null.
    try {
      return JSON.parse(repairTrivialJson(slice));
    } catch {
      return null;
    }
  }
}

/** Fix only cosmetic JSON noise a model commonly emits: curly double-quotes
 *  used as delimiters, and trailing commas before a closing }/]. Anything
 *  structural is left alone for the validator. */
export function repairTrivialJson(s: string): string {
  return s
    .replace(/[“”]/g, '"') // “ ” → "
    .replace(/,(\s*[}\]])/g, "$1"); // trailing comma before } or ]
}

/** Split a parsed build reply into its interpretation + the bundle manifest.
 *  The contract is `{ "interpretation": "...", "bundle": {...} }`, but we
 *  tolerate a bare bundle (older replies / a model that skipped the wrapper):
 *  if there's no `bundle` object, treat the whole thing as the bundle. */
// One starter record to seed after the schema applies: a kind + the record's
// fields (native + custom, mixed — the create endpoint routes unknowns to
// metadata). Only the design-workspace task produces these.
export interface SeedGroup {
  kind: string;
  records: Array<Record<string, unknown>>;
}

function parseSeed(raw: unknown): SeedGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: SeedGroup[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") continue;
    const kind = (g as { kind?: unknown }).kind;
    const records = (g as { records?: unknown }).records;
    if (typeof kind !== "string" || !Array.isArray(records)) continue;
    const rows = records.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r));
    if (rows.length > 0) out.push({ kind, records: rows });
  }
  return out;
}

export function unwrapBuild(parsed: unknown): {
  interpretation: string | null;
  bundle: unknown;
  seed: SeedGroup[];
} {
  if (parsed && typeof parsed === "object") {
    const p = parsed as { bundle?: unknown; interpretation?: unknown; seed?: unknown };
    if (p.bundle && typeof p.bundle === "object") {
      return {
        interpretation: typeof p.interpretation === "string" ? p.interpretation.trim() : null,
        bundle: p.bundle,
        seed: parseSeed(p.seed),
      };
    }
  }
  return { interpretation: null, bundle: parsed, seed: [] };
}

/** Split a parsed design-app reply into interpretation + the app definition.
 *  Contract: `{ "interpretation": "...", "app": {...} }`; tolerate a bare app
 *  (a model that skipped the wrapper). */
export function unwrapApp(parsed: unknown): { interpretation: string | null; app: unknown } {
  if (parsed && typeof parsed === "object") {
    const p = parsed as { app?: unknown; interpretation?: unknown };
    if (p.app && typeof p.app === "object") {
      return {
        interpretation: typeof p.interpretation === "string" ? p.interpretation.trim() : null,
        app: p.app,
      };
    }
  }
  return { interpretation: null, app: parsed };
}
