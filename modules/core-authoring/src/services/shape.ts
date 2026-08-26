// Everything that happens to a model's reply between "text came back" and
// "validate it" — in ONE place, because there were two.
//
// The interactive build (drafts.ts) and the operator eval (super-admin's
// /authoring-eval) each carried their own copy of the same five steps. When
// the corroboration layer landed in the interactive path, the eval kept
// measuring the OLD pipeline: a re-run reported the local models byte-identical
// to before, which looked like "the layer does nothing" and was actually "the
// eval never ran it" (2026-08-26). An eval that does not exercise the product's
// path measures a product that does not exist. So both callers use this, and a
// capability rule keeps a third copy from appearing.

import { applyLeanNatives, parseJsonObject, unwrapApp, unwrapBuild, type SeedGroup } from "./compile.js";
import { declineToBuild, deriveRequires, dropRedundantFields, tooVagueToBuild, type KindFields } from "./corroborate.js";

export interface ShapeDeps {
  /** What the person asked for — the vagueness gate reads it. */
  intent: string;
  /** Every field each kind already has, natives and custom — the dedupe reads it. */
  kinds: Map<string, KindFields>;
  /** Base kind → its native fields, for the lean-natives expansion. */
  natives: Map<string, { name: string; role?: string | null }[]>;
  /** Every module the workspace knows, for deriving `requires`. The base-kind
   *  map alone misses a module that has ACTIONS but no kinds of its own
   *  (core-discussion's comment action) — a wire onto one then failed as
   *  missing_requires_module because its module was filtered as unknown. */
  modules?: ReadonlySet<string>;
}

export interface Shaped {
  /** The bundle (or app) ready for validation, or null when the reply held none. */
  candidate: unknown;
  interpretation: string | null;
  seed: SeedGroup[];
  /** What corroboration changed, in words, for the interpretation. */
  notes: string[];
}

/** True for the app-authoring tasks, whose reply wraps an `app` not a `bundle`. */
export const isAppTask = (task: string): boolean => /app/.test(task);

/**
 * Parse, unwrap, expand lean natives, then corroborate. Pure apart from the
 * maps it is handed, so both callers and the tests see one behaviour.
 */
export function shapeCandidate(text: string, task: string, deps: ShapeDeps): Shaped {
  const parsedJson = parseJsonObject(text);
  if (isAppTask(task)) {
    const u = unwrapApp(parsedJson);
    return { candidate: u.app, interpretation: u.interpretation, seed: [], notes: [] };
  }
  const u = unwrapBuild(parsedJson);
  const candidate = applyLeanNatives(sanitizeBundle(u.bundle), deps.natives);
  const notes: string[] = [];
  let seed = u.seed;
  if (candidate && typeof candidate === "object") {
    // AI proposed; code corroborates. Each rule the prompt already states,
    // enforced here because a stated rule is a request.
    if (tooVagueToBuild(deps.intent)) {
      declineToBuild(candidate as Record<string, unknown>);
      seed = [];
      notes.push("The request did not say what to track, so nothing was added; say what the workspace is for and I will build it.");
    } else {
      const dropped = dropRedundantFields(candidate as Record<string, unknown>, deps.kinds);
      if (dropped.length) {
        notes.push(`Left out ${dropped.map((d) => `${d.name} (${d.entity_kind} already has ${d.duplicates})`).join(", ")}.`);
      }
      // Real modules = the prefixes of the BASE kinds (the natives map is keyed
      // by base kind, never by an instance's `<name>:item`), plus whatever the
      // caller knows from the action registry — a module can have actions and
      // no kinds.
      const knownModules = new Set([
        ...[...deps.natives.keys()].map((k) => k.split(":")[0]!).filter(Boolean),
        ...(deps.modules ?? []),
      ]);
      deriveRequires(candidate as Record<string, unknown>, knownModules.size ? knownModules : undefined);
    }
  }
  const interpretation = [u.interpretation, ...notes].filter(Boolean).join(" ") || null;
  return { candidate, interpretation, seed, notes };
}

/** Drop entries that are not objects from every list a bundle carries. A
 *  constrained decoder (Gemini under a response schema, 2026-08-26) emitted
 *  `null` items inside field_defs, and the first code to touch one threw
 *  "Cannot read properties of null (reading 'entity_kind')" — a 500 from a
 *  model reply, which is the one thing a model reply must never cause. */
export function sanitizeBundle(bundle: unknown): unknown {
  if (!bundle || typeof bundle !== "object") return bundle;
  const b = bundle as Record<string, unknown>;
  const objectsOnly = (v: unknown): unknown[] | undefined =>
    Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : undefined;
  for (const key of ["field_defs", "field_overrides", "wires", "provides_instances", "saved_views"]) {
    const cleaned = objectsOnly(b[key]);
    if (cleaned) b[key] = cleaned;
  }
  for (const inst of (b.provides_instances as Array<Record<string, unknown>> | undefined) ?? []) {
    for (const key of ["field_defs", "field_overrides", "wires", "saved_views"]) {
      const cleaned = objectsOnly(inst[key]);
      if (cleaned) inst[key] = cleaned;
    }
  }
  return b;
}

/** Every module the authoring context can see: the prefix of each kind id
 *  and of each action id. Cheap, and exactly the set `requires` may name. */
export function modulesOf(ctx: { kinds: Array<{ id: string }>; actions?: Array<{ id: string }> }): Set<string> {
  const out = new Set<string>();
  for (const k of ctx.kinds) { const m = k.id.split(":")[0]; if (m && !m.startsWith("@")) out.add(m); }
  for (const a of ctx.actions ?? []) { const m = a.id.split(":")[0]; if (m && !m.startsWith("@")) out.add(m); }
  return out;
}

/** The workspace's kinds as the corroboration layer reads them. */
export function kindFieldsOf(ctx: { kinds: Array<{ id: string; fields: Array<{ name: string; role?: string }> }> }): Map<string, KindFields> {
  return new Map(ctx.kinds.map((k) => [k.id, { fields: k.fields.map((f) => ({ name: f.name, role: f.role ?? null })) }]));
}
