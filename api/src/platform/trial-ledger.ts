// The trial ledger, read back: what a person built in a sandbox, as a list
// they can read and choose from. docs/design-decisions/trial-ledger.md.
//
// The list starts at hand-over (SANDBOX_HANDED_OVER in try-sandbox.ts). A
// sandbox arrives stocked, and the stock is made through the same doors the
// person uses, as the same guest, so nothing in a row says "seed"; the one
// moment that splits the platform's work from the person's is the hand-over
// row, and everything after it is theirs. A workspace with no such row (not a
// sandbox) has a ledger of everything, which is the honest answer for it.
//
// Net state only. The log says what the person did; live rows say what is
// still there. Something made and then deleted is not on the list, and the
// stock's bundles are not on it even though their rows look exactly like the
// person's. Every line carries what a replay will need, so this one read
// feeds both the page and, later, the picker.
import { sql } from "kysely";
import { meta } from "../db/meta.js";
import { listEntries } from "../modules/registry.js";
import { isDefaultModule } from "../modules/enable.js";
import { USER_SOURCE } from "./bundle-claims.js";
import { listKindsForOrg } from "./entities.js";
import { SANDBOX_HANDED_OVER } from "./try-sandbox.js";
import { collectionLabelFor } from "@cobblr/platform-contract/kind-label";

export interface LedgerBundle {
  external_id: string;
  version: string;
  name: string;
  words: string;
}
export interface LedgerModule {
  module_name: string;
  name: string;
  words: string;
}
export interface LedgerInstance {
  module_name: string;
  instance_name: string;
  display_name: string;
  words: string;
}
export interface LedgerField {
  id: string;
  entity_kind: string;
  name: string;
  display_label: string;
  type: string;
  words: string;
}
export interface LedgerAutomation {
  id: string;
  source_kind: string;
  action_id: string;
  words: string;
}
export interface LedgerScan {
  entity_kind: string;
  entity_id: string;
  instance: string | null;
  name: string;
  photo_file_ids: string[];
  words: string;
}
export interface LedgerRecords {
  entity_kind: string;
  label: string;
  ids: string[];
  scanned: number;
  words: string;
}

export interface TrialLedger {
  /** The hand-over, when the workspace is a sandbox; null means everything counts. */
  since: string | null;
  bundles: LedgerBundle[];
  modules: LedgerModule[];
  instances: LedgerInstance[];
  fields: LedgerField[];
  automations: LedgerAutomation[];
  scans: LedgerScan[];
  records: LedgerRecords[];
  /** What the list does not carry, said rather than left to wonder. */
  left_behind: string[];
}

/** What stays here. Fixed words: a list that only says what comes is half a list. */
export const LEFT_BEHIND = [
  "the records the sandbox came stocked with",
  "the activity feed and notifications",
  "conversations with the assistant",
  "scan sessions and their history",
  "the guest account itself",
];

async function handedOverAt(orgId: string): Promise<Date | null> {
  const row = await meta
    .selectFrom("activity_log")
    .select(sql<Date | null>`max(occurred_at)`.as("at"))
    .where("org_id", "=", orgId)
    .where("action", "=", SANDBOX_HANDED_OVER)
    .executeTakeFirst();
  return row?.at ?? null;
}

const after = <T extends { created_at?: Date | null; enabled_at?: Date | null; installed_at?: Date | null }>(
  rows: T[],
  since: Date | null,
  at: (r: T) => Date | null | undefined,
): T[] => (since ? rows.filter((r) => (at(r) ?? new Date(0)) > since) : rows);

interface ActivityRow {
  action: string;
  module_name: string | null;
  entity_type: string;
  entity_id: string;
  diff: unknown;
  occurred_at: Date;
}

export async function trialLedger(orgId: string): Promise<TrialLedger> {
  const since = await handedOverAt(orgId);
  const claims = await meta
    .selectFrom("bundle_resource_claims")
    .select(["source", "resource_type", "resource_key"])
    .where("org_id", "=", orgId)
    .execute();
  const claimedByBundle = (type: "module" | "instance", key: string): boolean =>
    claims.some((c) => c.resource_type === type && c.resource_key === key && c.source !== USER_SOURCE);
  const claimedByUser = (type: "module" | "instance", key: string): boolean =>
    claims.some((c) => c.resource_type === type && c.resource_key === key && c.source === USER_SOURCE);

  const bundles = after(
    await meta
      .selectFrom("bundles")
      .select(["external_id", "version", "name", "installed_at"])
      .where("org_id", "=", orgId)
      .orderBy("installed_at")
      .execute(),
    since,
    (r) => r.installed_at,
  ).map((b) => ({ external_id: b.external_id, version: b.version, name: b.name, words: `Installed ${b.name}` }));

  const entries = new Map(listEntries().map((e) => [e.manifest.name, e]));
  const modules = after(
    await meta
      .selectFrom("org_modules")
      .select(["module_name", "enabled_at"])
      .where("org_id", "=", orgId)
      .orderBy("enabled_at")
      .execute(),
    since,
    (r) => r.enabled_at,
  )
    .filter((m) => {
      const entry = entries.get(m.module_name);
      if (!entry || isDefaultModule(entry)) return false;
      // A module the person asked for by name. One a bundle brought is the
      // bundle's own intent, unless they also asked for it themselves.
      return claimedByUser("module", m.module_name) || !claimedByBundle("module", m.module_name);
    })
    .map((m) => {
      const name = entries.get(m.module_name)?.manifest.displayName ?? m.module_name;
      return { module_name: m.module_name, name, words: `Turned on ${name}` };
    });

  const instanceRows = await meta
    .selectFrom("workspace_module_instances")
    .select(["module_name", "instance_name", "display_name", "created_at"])
    .where("org_id", "=", orgId)
    .orderBy("created_at")
    .execute();
  // registry-filter-ok: the workspace's instance rows, not the kind registry; a bundle's instance is the bundle's own intent
  const instances = after(instanceRows, since, (r) => r.created_at)
    .filter((i) => !claimedByBundle("instance", i.instance_name))
    .map((i) => ({
      module_name: i.module_name,
      instance_name: i.instance_name,
      display_name: i.display_name,
      words: `Made ${i.display_name} in ${entries.get(i.module_name)?.manifest.displayName ?? i.module_name}`,
    }));
  const instancesForLabel = instanceRows.map((i) => ({
    instance_name: i.instance_name,
    display_name: i.display_name,
    module_name: i.module_name,
  }));

  // The workspace's own words for its kinds: "parts", "locations", a named
  // collection's name. Lowercase, since every line puts them mid-sentence.
  const kinds = await listKindsForOrg(orgId);
  const kindWords = (kind: string, n: number): string => {
    const k = kinds.find((x) => x.id === kind);
    const one = (k?.display_name ?? collectionLabelFor(kind, instancesForLabel)).toLowerCase();
    const many = (k?.display_name_plural ?? `${one}s`).toLowerCase();
    return n === 1 ? one : many;
  };

  const fields = after(
    await meta
      .selectFrom("module_field_defs")
      .select(["id", "entity_kind", "name", "display_label", "type", "created_at"])
      .where("org_id", "=", orgId)
      .where("bundle_id", "is", null)
      .where("source_module", "is", null)
      .orderBy("created_at")
      .execute(),
    since,
    (r) => r.created_at,
  ).map((f) => ({
    id: f.id,
    entity_kind: f.entity_kind,
    name: f.name,
    display_label: f.display_label,
    type: f.type,
    words: `Added a field ${f.display_label} to ${kindWords(f.entity_kind, 2)}`,
  }));

  const automations = after(
    await meta
      .selectFrom("entity_action_bindings")
      .select(["id", "source_kind", "action_id", "created_at"])
      .where("org_id", "=", orgId)
      .where("bundle_id", "is", null)
      .where("source_module", "is", null)
      .orderBy("created_at")
      .execute(),
    since,
    (r) => r.created_at,
  ).map((b) => ({
    id: b.id,
    source_kind: b.source_kind,
    action_id: b.action_id,
    words: `Set up an automation on ${kindWords(b.source_kind, 2)}`,
  }));

  // The log, after the hand-over: what was scanned, what was made and what
  // was deleted since, so a record that is gone is not offered.
  let log = meta
    .selectFrom("activity_log")
    .select(["action", "module_name", "entity_type", "entity_id", "diff", "occurred_at"])
    .where("org_id", "=", orgId)
    .where((eb) =>
      eb.or([eb("action", "=", "scan_committed"), eb("action", "like", "%\\_created"), eb("action", "like", "%\\_deleted")]),
    )
    .orderBy("occurred_at");
  if (since) log = log.where("occurred_at", ">", since);
  const rows = (await log.execute()) as ActivityRow[];

  const deleted = new Set<string>();
  for (const r of rows) if (r.action.endsWith("_deleted")) deleted.add(`${r.module_name}:${r.entity_type}:${r.entity_id}`);
  const alive = (module: string | null, type: string, id: string): boolean => !deleted.has(`${module}:${type}:${id}`);

  const scans: LedgerScan[] = [];
  for (const r of rows) {
    if (r.action !== "scan_committed") continue;
    const d = (r.diff ?? {}) as { entity_kind?: string; entity_id?: string; instance?: string | null; name?: string; photo_file_ids?: string[] };
    if (!d.entity_kind || !d.entity_id) continue;
    const [module, type] = d.entity_kind.split(":");
    if (!alive(module ?? null, type ?? "", d.entity_id)) continue;
    const photos = Array.isArray(d.photo_file_ids) ? d.photo_file_ids : [];
    scans.push({
      entity_kind: d.entity_kind,
      entity_id: d.entity_id,
      instance: d.instance ?? null,
      name: d.name ?? "",
      photo_file_ids: photos,
      words: `Scanned ${d.name || "something"}${photos.length ? " (with a photo)" : ""}`,
    });
  }
  const scannedIds = new Set(scans.map((s) => `${s.entity_kind}:${s.entity_id}`));

  const byKind = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.action.endsWith("_created") || r.action === "instance_created") continue;
    if (!r.module_name || !alive(r.module_name, r.entity_type, r.entity_id)) continue;
    // A record made in a named collection is that collection's (the create
    // row carries `instance`); the module's default collection is the module's
    // own kind.
    const instance = (r.diff as { instance?: unknown } | null)?.instance;
    const kind =
      typeof instance === "string" && instance && instance !== r.module_name
        ? `${instance}:item`
        : `${r.module_name}:${r.entity_type}`;
    // Only what the workspace can still reach as a kind: a row for a module
    // since turned off, or for a thing that is not a record (a vendor's
    // order line), has no collection to be offered under.
    if (!kinds.some((k) => k.id === kind)) continue;
    const ids = byKind.get(kind) ?? [];
    if (!ids.includes(r.entity_id)) ids.push(r.entity_id);
    byKind.set(kind, ids);
  }
  const records: LedgerRecords[] = [...byKind.entries()].map(([kind, ids]) => {
    const label = kindWords(kind, ids.length);
    const scanned = ids.filter((id) => scannedIds.has(`${kind}:${id}`)).length;
    return {
      entity_kind: kind,
      label,
      ids,
      scanned,
      words: `${ids.length} ${label}${scanned ? ` (${scanned} scanned)` : ""}`,
    };
  });

  return {
    since: since ? since.toISOString() : null,
    bundles,
    modules,
    instances,
    fields,
    automations,
    scans,
    records,
    left_behind: LEFT_BEHIND,
  };
}
