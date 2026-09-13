// The destinations of a move plan, as the fit rule sees them.
//
// The scan menu is assembled from three reads (the instances, the per-instance
// overrides that carry a bundle's noun and words, the field defs with their
// category axis); this reads the same three through the plan's WorkspaceApi
// for the lists a sentence named, so a record is matched to "spices" by what
// the Spice Rack declares and not only by the word in its name. The rule
// itself is @cobblr/platform-contract/table-fit, shared with the scan floor.

import type { KindRec, WorkspaceApi } from "@cobblr/workspace-tools";
import { platform } from "@cobblr/platform-contract";
import type { FitTable } from "@cobblr/platform-contract/table-fit";

/** The module's own noun for one of its scannable records ("part"), when the
 *  kernel is up; the tests run the plan without one and go by overrides. */
function scannableNouns(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    for (const s of platform().entities.listScannable()) out.set(s.kind.split(":")[0]!, s.noun);
  } catch {
    /* no kernel in a unit test: nouns come from the overrides */
  }
  return out;
}

export async function fitTablesFor(wsApi: WorkspaceApi, kinds: KindRec[]): Promise<Map<string, FitTable>> {
  const out = new Map<string, FitTable>();
  // registry-filter-ok: the caller hands the DESTINATIONS of a move, which are named lists by construction; a module's primary kind is never one
  const named = kinds.filter((k) => !!k.instance_name);
  if (!named.length) return out;
  const overrides = new Map<string, { item_noun?: string; scan_keywords?: string[] }>();
  try {
    const r = await wsApi.request("GET", "/entity-kind-overrides");
    for (const o of ((r.body as { items?: Array<{ target_kind?: string; target_id?: string; config?: { item_noun?: string; scan_keywords?: unknown } }> }).items ?? [])) {
      if (o.target_kind === "instance" && typeof o.target_id === "string" && o.config) {
        overrides.set(o.target_id, {
          ...(typeof o.config.item_noun === "string" ? { item_noun: o.config.item_noun } : {}),
          ...(Array.isArray(o.config.scan_keywords) ? { scan_keywords: o.config.scan_keywords.filter((k): k is string => typeof k === "string" && k.trim() !== "") } : {}),
        });
      }
    }
  } catch {
    /* best-effort: a table with no declared words still routes by its noun */
  }
  const nouns = scannableNouns();
  for (const k of named) {
    const override = overrides.get(`${k.module_name}:${k.instance_name}`);
    let fields: FitTable["fields"] = [];
    let categoryField: FitTable["category_field"];
    try {
      const r = await wsApi.request("GET", `/field-defs?kind=${encodeURIComponent(k.id)}`);
      // Only what is a field def: a name, a label, a type. Anything else the
      // route hands back (a fixture that answers every path alike) is not.
      const defs = ((r.body as { items?: Array<{ name?: unknown; display_label?: unknown; type?: unknown; choices?: string[] | null; field_role?: string | null }> }).items ?? [])
        .filter((d): d is { name: string; display_label: string; type: string; choices?: string[] | null; field_role?: string | null } => typeof d.name === "string" && typeof d.display_label === "string" && typeof d.type === "string")
        .filter((d) => d.type !== "computed");
      fields = defs.map((d) => ({ name: d.name, label: d.display_label, ...(d.choices?.length ? { choices: d.choices } : {}) }));
      const cat = defs.find((d) => d.field_role === "category");
      if (cat) categoryField = { name: cat.name, label: cat.display_label, values: cat.choices ?? [] };
    } catch {
      /* no fields: the table is still routable by its noun and words */
    }
    out.set(k.id, {
      noun: override?.item_noun || nouns.get(k.module_name ?? "") || "",
      label: k.display_name ?? k.instance_name!,
      fields,
      ...(override?.scan_keywords?.length ? { scan_keywords: override.scan_keywords } : {}),
      ...(categoryField ? { category_field: categoryField } : {}),
    });
  }
  return out;
}
