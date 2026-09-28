// The stash a pattern is matched against: every yarn and every hook or needle
// in the workspace's stock tables, read through the platform (never another
// module's own tables).
//
// A yarn is a record that carries yarn facts (weight, fibre, colourway, a
// length per ball); a tool is one with a hook gauge. Records in any inventory
// table count, so a hand-built "My yarn" table matches as well as the Yarn
// bundle's. Retired records and opened units are left out by the resolver.

import { platform } from "@cobblr/platform-contract";
import { millimetres, type StashNotion, type StashTool, type StashYarn } from "./pattern-match.js";

const PAGE = 200;
/** Enough for a big stash; past it the page says the match looked at the first. */
export const STASH_READ_CAP = 2000;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export interface Stash {
  yarns: StashYarn[];
  tools: StashTool[];
  notions: StashNotion[];
  /** More records than STASH_READ_CAP: the match did not see them all. */
  partial: boolean;
}

export async function readStash(orgId: string): Promise<Stash> {
  // Every table in the workspace that counts stock: each kind that declares a
  // quantity, and each named table (instance) of the module that owns it. By
  // what a kind declares, never by a module's name (module isolation).
  const stockKinds = (await platform().entities.listKinds()).filter((k) => k.fields.some((f) => f.name === "qty"));
  const owners = new Set(stockKinds.map((k) => k.module_name));
  const instances = (await platform().instances.list(orgId).catch(() => [])).filter((i) => owners.has(i.module_name) && !i.is_default);
  const kinds = [...new Set([...stockKinds.map((k) => k.id), ...instances.map((i) => `${i.instance_name}:item`)])];
  const yarns: StashYarn[] = [];
  const tools: StashTool[] = [];
  const notions: StashNotion[] = [];
  let seen = 0;
  let partial = false;
  for (const kind of kinds) {
    for (let offset = 0; ; offset += PAGE) {
      if (seen >= STASH_READ_CAP) {
        partial = true;
        break;
      }
      const page = await platform().entities.list(orgId, kind, { limit: PAGE, offset }).catch(() => ({ items: [] }));
      for (const e of page.items) {
        seen++;
        const f = e.fields ?? {};
        const md = ((f.metadata ?? {}) as Record<string, unknown>) || {};
        const notion = str(md.notion_type);
        if (notion) {
          notions.push({ id: e.id, name: e.title, notion, size_mm: millimetres(str(md.notion_size)), qty: num(f.available_qty) ?? num(f.qty) ?? 0 });
          continue;
        }
        const gauge = str(md.hook_gauge);
        if (gauge) {
          tools.push({ id: e.id, name: e.title, size_mm: millimetres(gauge), qty: num(f.available_qty) ?? num(f.qty) ?? 0 });
          continue;
        }
        const isYarn = md.weight_class != null || md.fiber != null || md.colorway != null || md.length_per_skein != null || f.instance === "yarn";
        if (!isYarn) continue;
        const remaining = f.remaining as { open?: { value: number }[] } | undefined;
        const color = str(md.color);
        yarns.push({
          id: e.id,
          name: e.title,
          brand: str(f.manufacturer),
          colorway: str(md.colorway),
          color: color && !color.startsWith("#") ? color : null,
          weight: str(md.weight_class),
          fiber: str(md.fiber),
          free_units: num(f.available_qty) ?? num(f.qty) ?? 0,
          unit: str(f.unit),
          unit_length_m: num(md.length_per_skein) ?? num(md.capacity),
          partials_m: (remaining?.open ?? []).map((a) => Number(a.value)).filter((v) => v > 0),
        });
      }
      if (page.items.length < PAGE) break;
    }
  }
  return { yarns, tools, notions, partial };
}
