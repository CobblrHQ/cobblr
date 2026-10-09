import type { PlatformTidy, TidyCandidate, TidyFinderContext, ResolvedEntity } from "@cobblr/platform-contract";
import { fieldDay, platform } from "@cobblr/platform-contract";
import { listAll, listKindsForOrg, resolveKind } from "./entities.js";
import { listInstances } from "./instances.js";
import { resolveFieldDefsForKind } from "./field-defs.js";

type Collection = { kind: string; label: string; route: string; records: ResolvedEntity[]; defs: Awaited<ReturnType<typeof resolveFieldDefsForKind>> };
const snapshots = new WeakMap<TidyFinderContext, Promise<Collection[]>>();
async function collections(ctx: TidyFinderContext): Promise<Collection[]> {
  let snap = snapshots.get(ctx);
  if (!snap) {
    snap = (async () => {
      const instances = await listInstances(ctx.orgId);
      const kinds = await listKindsForOrg(ctx.orgId);
      // registry-filter-ok: primary kinds are walked once per collection here; every secondary kind is added below.
      const offered = instances.filter((i) => kinds.some((k) => k.module_name === i.module_name && k.is_primary)).map((i) => ({ kind: `${i.instance_name}:item`, label: i.display_name, route: i.is_default ? `/${i.module_name}` : `/instances/${i.instance_name}` }));
      for (const k of kinds) if (!k.is_primary && !k.instance_name && !offered.some((o) => o.kind === k.id)) offered.push({ kind: k.id, label: k.display_name, route: "/" });
      const out: Collection[] = [];
      for (const o of offered) {
        const kind = (await resolveKind(ctx.orgId, o.kind)).instance ? o.kind : (await resolveKind(ctx.orgId, o.kind)).base;
        const page = await listAll(ctx.orgId, kind, {}, { system: true }, { cap: Infinity });
        if (!page.complete) throw new Error(`Tidy-up could not finish reading ${o.label}`);
        const records = page.items.filter((r) => !r.retired && !r.fields._source_workspace_slug);
        out.push({ ...o, route: o.route === "/" ? records[0]?.detailUrl || "/" : o.route, kind, records, defs: await resolveFieldDefsForKind(ctx.orgId, kind) });
      }
      return out;
    })();
    snapshots.set(ctx, snap);
  }
  return snap;
}
const ref = (r: ResolvedEntity) => ({ kind: r.kind, id: r.id, name: r.title, ...(r.detailUrl ? { url: r.detailUrl } : {}) });
const values = (r: ResolvedEntity) => ({ ...r.fields, ...((r.fields.metadata ?? {}) as Record<string, unknown>) });
function suggest(kind: string, c: Collection, rows: ResolvedEntity[], why: string, priority: number): TidyCandidate {
  return { id: `${kind}:${c.kind}`, kind, records: rows.map(ref), why, priority, action: { route: c.route } };
}

export function registerWorkspaceTidyFinders(registry: PlatformTidy): void {
  registry.registerFinder({ id: "platform.low-stock", async find(ctx) {
    const out: TidyCandidate[] = [];
    for (const c of await collections(ctx)) {
      const rows = c.records.filter((r) => { const f = values(r); return f.min_qty != null && f.qty != null && Number(f.on_hand ?? f.qty) <= Number(f.min_qty); });
      if (rows.length) out.push(suggest("low-stock", c, rows, `Check ${rows.length} low-stock things in ${c.label}.`, 20));
    }
    return out;
  } });
  registry.registerFinder({ id: "platform.warranties", async find(ctx) {
    const out: TidyCandidate[] = [];
    const today = ctx.now.toISOString().slice(0, 10), soon = new Date(ctx.now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
    for (const c of await collections(ctx)) {
      const fields = c.defs.filter((d) => d.type === "date" && /warranty|coverage/i.test(`${d.name} ${d.display_label} ${c.label}`));
      const rows = c.records.filter((r) => fields.some((d) => { const day = fieldDay(values(r)[d.name]); return day && day >= today && day <= soon; }));
      if (rows.length) out.push(suggest("warranty-ending", c, rows, `Review ${rows.length} warranties ending within 30 days in ${c.label}.`, 15));
    }
    return out;
  } });
  registry.registerFinder({ id: "platform.overdue-loans", async find(ctx) {
    const out: TidyCandidate[] = [];
    const today = ctx.now.toISOString().slice(0, 10);
    for (const c of await collections(ctx)) {
      const dates = c.defs.filter((d) => d.type === "date" && /return|lent.*until|loan.*until/i.test(`${d.name} ${d.display_label}`));
      const rows = c.records.filter((r) => dates.some((d) => { const day = fieldDay(values(r)[d.name]); return day && day < today && !values(r).returned_at; }));
      if (rows.length) out.push(suggest("overdue-loan", c, rows, `Follow up on ${rows.length} things past their return date in ${c.label}.`, 10));
    }
    return out;
  } });
  registry.registerFinder({ id: "platform.near-duplicates", async find(ctx) {
    const out: TidyCandidate[] = [];
    for (const c of await collections(ctx)) {
      const seen = new Map<string, ResolvedEntity>();
      const duplicates = new Map<string, ResolvedEntity>();
      for (const r of c.records) {
        const f = values(r);
        for (const [field, value] of [["name", r.title], ["barcode", f.barcode ?? f.upc], ["serial", f.serial ?? f.serial_number]]) {
          if (typeof value !== "string" || !value.trim()) continue;
          const key = `${field}:${value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")}`;
          const twin = seen.get(key);
          if (twin) { duplicates.set(twin.id, twin); duplicates.set(r.id, r); }
          else seen.set(key, r);
        }
      }
      if (duplicates.size) out.push(suggest("near-duplicate", c, [...duplicates.values()], `Review ${duplicates.size} things with matching names or identifiers in ${c.label}.`, 40));
    }
    return out;
  } });
  registry.registerFinder({ id: "platform.missing-fields", async find(ctx) {
    const out: TidyCandidate[] = [];
    for (const c of await collections(ctx)) {
      if (c.records.length < 5) continue;
      const filled = (r: ResolvedEntity, name: string) => { const v = values(r)[name]; return v != null && v !== ""; };
      for (const def of c.defs.filter((d) => d.type !== "computed")) {
        if (c.records.filter((r) => filled(r, def.name)).length / c.records.length < 0.8) continue;
        const rows = c.records.filter((r) => !filled(r, def.name));
        if (rows.length) out.push({ ...suggest("missing-field", c, rows, `Add ${def.display_label} to ${rows.length} things in ${c.label}.`, 50), id: `missing-field:${c.kind}:${def.name}` });
      }
    }
    return out;
  } });
  registry.registerFinder({ id: "platform.empty-places", async find(ctx) {
    const out: TidyCandidate[] = [];
    const kinds = await listKindsForOrg(ctx.orgId);
    for (const k of kinds.filter((k) => k.traits?.containment === "container")) {
      const places = await listAll(ctx.orgId, k.id, {}, { system: true }, { cap: Infinity });
      const empty: ResolvedEntity[] = [];
      for (const r of places.items.filter((r) => !r.retired)) {
        if (!(await platform().placement.contents({ orgId: ctx.orgId, container: { kind: r.kind, id: r.id } })).length) empty.push(r);
      }
      if (empty.length) out.push(suggest("empty-place", { kind: k.id, label: k.display_name, route: empty[0]?.detailUrl || "/", records: [], defs: [] }, empty, `Review ${empty.length} empty places.`, 60));
    }
    return out;
  } });
}
