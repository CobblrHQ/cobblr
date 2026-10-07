import { platform, type ResolvedEntity, type TidyCandidate, type TidyFinderContext } from "@cobblr/platform-contract";
import { scanBetterTable } from "@cobblr/platform-contract/scan-triage";
import { assembleMergedMenu, heuristicMatch, type PerceivedItem, type ScanMenuEntry } from "./matchmaker.js";
import { destinationTables } from "./destination.js";
import { routeWhereKept, type KeptTable } from "./kept-route.js";
import type { CoreScanDB } from "../db.js";
import type { Kysely } from "kysely";

export function tidyHome(item: PerceivedItem, current: ScanMenuEntry, menu: ScanMenuEntry[], twins: KeptTable[]): ScanMenuEntry | null {
  const candidates = heuristicMatch(item, menu);
  const known = routeWhereKept(candidates, menu, { twins });
  const kept = candidates[0];
  if (known && kept?.instance && kept.instance !== current.instance) return menu.find((m) => m.module === kept.module && m.instance === kept.instance) ?? null;
  const better = scanBetterTable({ name: item.name ?? "", category: item.category, metadata: item.metadata }, current.kind, destinationTables(menu), current.module);
  return better ? menu.find((m) => (m.instance ?? m.module) === better.instance_name && m.module === better.module_name) ?? null : null;
}
const ref = (r: ResolvedEntity) => ({ kind: r.kind, id: r.id, name: r.title, ...(r.detailUrl ? { url: r.detailUrl } : {}) });

async function bestHomes(ctx: TidyFinderContext): Promise<TidyCandidate[]> {
  const token = await platform().auth.mintSession({ userId: ctx.as.userId });
  // loopback-ok: #5153 moves this onto selfFetch
  const menu = await assembleMergedMenu(`http://127.0.0.1:${process.env.API_PORT || 4000}`, ctx.as.orgSlug, token, ctx.orgId);
  const live = menu.filter((m) => !m.bundle_external_id);
  const records: Array<{ record: ResolvedEntity; table: ScanMenuEntry }> = [];
  for (const table of live) {
    const page = await platform().entities.listAll(ctx.orgId, table.kind, {}, { system: true }, { cap: Infinity });
    if (!page.complete) throw Error(`Tidy-up could not finish reading ${table.label}`);
    records.push(...page.items.filter((r) => !r.retired && !r.fields._source_workspace_slug).map((record) => ({ record, table })));
  }
  const groups = new Map<string, { to: ScanMenuEntry; sources: Map<string, ResolvedEntity[]>; records: ResolvedEntity[] }>();
  const bundles = new Map<string, { to: ScanMenuEntry; records: ResolvedEntity[] }>();
  for (const { record, table } of records) {
    const fields = { ...record.fields, ...((record.fields.metadata ?? {}) as Record<string, unknown>) };
    const item: PerceivedItem = { name: record.title, category: String(fields.category ?? ""), barcode: typeof fields.barcode === "string" ? fields.barcode : null, metadata: fields };
    const twins = records.filter((r) => r.record.id !== record.id && r.record.title.trim().toLowerCase() === record.title.trim().toLowerCase()).map((r) => ({ module: r.table.module, instance: r.table.instance, kind: r.table.kind }));
    const targetKey = await ctx.memo(`home:${record.kind}:${record.id}`, JSON.stringify({ title: record.title, fields, twins }), async () => {
      let to = tidyHome(item, table, live, twins);
      if (!to && (table.is_fallback || !table.instance)) {
        const options = live.filter((m) => m.module === table.module && m.instance && !m.is_fallback && m.instance !== table.instance);
        const name = options.length ? await ctx.classify({ name: item.name, category: item.category, fields }, options.map((m) => ({ name: m.instance!, label: m.label, noun: m.noun }))) : null;
        to = options.find((m) => m.instance === name) ?? null;
      }
      if (to && to.module === table.module && to.instance !== table.instance) return { collection: to.instance ?? to.module };
      const offered = tidyHome(item, table, menu, twins);
      return offered?.bundle_external_id ? { bundle: offered.bundle_external_id } : null;
    });
    if (targetKey?.collection) {
      const to = live.find((m) => (m.instance ?? m.module) === targetKey.collection && m.module === table.module);
      if (!to) continue;
      const key = `${to.module}:${to.instance ?? to.module}`;
      const group = groups.get(key) ?? { to, sources: new Map<string, ResolvedEntity[]>(), records: [] };
      const source = table.instance ?? table.module;
      const sourceRecords = group.sources.get(source) ?? [];
      sourceRecords.push(record); group.sources.set(source, sourceRecords);
      group.records.push(record); groups.set(key, group);
    } else if (targetKey?.bundle) {
      const to = menu.find((m) => m.bundle_external_id === targetKey.bundle);
      if (!to) continue;
      const group = bundles.get(targetKey.bundle) ?? { to, records: [] };
      group.records.push(record); bundles.set(targetKey.bundle, group);
    }
  }
  return [
    ...[...groups].map(([key, g]): TidyCandidate => ({ id: `move:${key}`, kind: "better-home", records: g.records.map(ref), why: `Move ${g.records.length} ${g.records.length === 1 ? "thing" : "things"} to ${g.to.label}.`, priority: 25, action: { route: `/instances/${g.to.instance ?? g.to.module}`, steps: [...g.sources].map(([from, rows]) => ({ action_id: "platform:move-records", args: { ids: rows.map((r) => r.id), from, to: g.to.instance ?? g.to.module } })) } })),
    ...[...bundles].filter(([, g]) => g.records.length >= 5).map(([id, g]): TidyCandidate => ({ id: `bundle:${id}`, kind: "fitting-bundle", records: g.records.map(ref), why: `Consider ${g.to.label} for ${g.records.length} things you keep.`, priority: 35, action: { route: "/bundles", bundle_id: id } })),
  ];
}

export function registerScanTidyFinders(): void {
  platform().tidy.registerFinder({ id: "core-scan.best-homes", module: "core-scan", find: bestHomes });
  platform().tidy.registerFinder({ id: "core-scan.unfiled", module: "core-scan", async find(ctx) {
    const db = await platform().tenants.getDb(ctx.orgId) as Kysely<CoreScanDB>;
    const rows = await db.selectFrom("core_scan_inbox_items").select(["id", "suggested_name"]).where("status", "=", "pending").where("created_at", "<", new Date(ctx.now.getTime() - 3 * 86400000)).execute();
    return rows.length ? [{ id: "unfiled-scans", kind: "unfiled-scan", records: rows.map((r) => ({ kind: "core-scan:inbox-item", id: r.id, name: r.suggested_name ?? "A capture" })), why: `File ${rows.length} captures waiting more than three days.`, priority: 30, action: { route: "/scan" } }] : [];
  } });
}
