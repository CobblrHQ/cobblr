// The word a person picked for their things, written where every reader
// already looks (#3650).
//
// A table can offer words (Yarn: ball, skein or hank). Its bundle's labels,
// help and view names say {{noun}} / {{nouns}}; this fills them with the
// word in force before the install writes them, so the stored field
// definitions, overrides and views say the chosen word, and every reader
// (each screen, Cobb, an export, a carried trial) reads it with no change of
// its own. The stored manifest keeps the tokens, so a later change re-fills
// from the source rather than from a filled copy.
//
// The choice lives on the instance's presentation config (`noun_choice`),
// beside the offer (`noun`) the picker reads. Absent means the bundle's
// default: every label written before this existed already says it, so an
// existing workspace has nothing to heal. That is why there is no boot pass
// here: a reconcile that writes the default would write what is already there.
import { meta } from "../db/meta.js";
import { chosenNoun, fillNoun, type NounChoiceDecl, type NounWords } from "@cobblr/platform-contract/kind-label";

/** The word each instance's person picked, by instance name. */
export async function storedNounChoices(orgId: string): Promise<Map<string, string>> {
  const rows = await meta
    .selectFrom("entity_kind_overrides")
    .select(["target_id", "config"])
    .where("org_id", "=", orgId)
    .where("target_kind", "=", "instance")
    .execute();
  const out = new Map<string, string>();
  for (const r of rows) {
    const c = (r.config ?? null) as { noun_choice?: { singular?: unknown } | null } | null;
    const w = c?.noun_choice?.singular;
    const name = String(r.target_id).split(":")[1];
    if (name && typeof w === "string" && w.trim()) out.set(name, w.trim());
  }
  return out;
}

function fillDeep<T>(v: T, noun: NounWords): T {
  if (typeof v === "string") return fillNoun(v, noun) as T;
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, noun)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      // The offer itself stays as written: it is what the picker lists.
      out[k] = k === "noun" ? x : fillDeep(x, noun);
    }
    return out as T;
  }
  return v;
}

type WithNoun = { instance_name?: string; noun?: NounChoiceDecl; qty_unit?: string; item_noun?: string };

/** One instance with its words filled, its unit or item noun set from the
 *  word, and the word recorded as the choice. A copy: the manifest the caller
 *  stores keeps its tokens. */
export function fillInstanceNoun<T extends WithNoun>(inst: T, noun: NounWords): T & { noun_choice?: NounWords } {
  const filled = fillDeep(inst, noun) as T & { noun_choice?: NounWords; item_noun_plural?: string };
  if (inst.noun?.of === "unit") filled.qty_unit = noun.singular;
  if (inst.noun?.of === "item") {
    filled.item_noun = noun.singular;
    filled.item_noun_plural = noun.plural;
  }
  filled.noun_choice = { singular: noun.singular, plural: noun.plural };
  return filled;
}

/** A manifest with every offering table's words filled. `pick` answers the
 *  word asked for or stored for an instance, or null for the default. */
export function withNounsFilled<M extends { provides_instances: WithNoun[] }>(m: M, pick: (instance: string) => string | null): M {
  if (!m.provides_instances.some((i) => i.noun)) return m;
  return {
    ...m,
    provides_instances: m.provides_instances.map((inst) => {
      if (!inst.noun || !inst.instance_name) return inst;
      const want = pick(inst.instance_name);
      return fillInstanceNoun(inst, chosenNoun(inst.noun, want ? { singular: want } : null));
    }),
  };
}
