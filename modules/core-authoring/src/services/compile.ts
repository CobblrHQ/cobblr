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
): Promise<AuthoringContext> {
  const warnings: string[] = [];
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
    warnings.push(
      "No kinds selected — using all declared kinds. Pick 1-3 for the best result; a small model wires to the wrong kind when given too many.",
    );
  }
  if (chosen.length > MAX_KINDS) {
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

  return { task, kinds, actions, outputContract: OUTPUT_CONTRACT, warnings };
}

// The compact output contract — field_defs + wires ONLY (v1 scope guard).
// Keeping the output surface minimal is the single biggest small-model
// reliability lever; do not widen it (no saved_views/catalogs/lens) until
// the eval pass-rate on this surface is high.
const OUTPUT_CONTRACT = `{
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
    return `You are generating a Cobblr "bundle": a JSON config that adds custom fields and/or event→action wires to an existing app. Output ONLY the JSON object, nothing else.

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
};

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
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}
