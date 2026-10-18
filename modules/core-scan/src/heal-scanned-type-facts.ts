// One-shot heal: a record filed from a scan before the commit wrote what the
// scan knows gets it now, and so does the type it is filed under.
//
// DONE WHEN: /healthz reports 0 for this shim on prod, staging and dev, i.e.
// no tenant DB has a resolved core_scan_inbox_items row filed into an
// instance whose record (or its parent type) still lacks a value the row's
// barcode, its item's name or its re-read tag supplies. Then delete this file
// and its boot call. Nothing re-creates the shape: the scan commit writes the
// same facts at filing time (inbox.ts, services/scan-field-facts.ts).
//
// BORN WITH: identifierFromScan + choicesNamedIn in the scan commit, so a
// record filed today already carries them.
//
// WHY IT EXISTS (#3990): spools filed from a box barcode had no UPC on their
// filament type (the barcode was never written to the identifier field), so
// the next scan of the same box found nothing; and spools scanned from a
// maker's tag before the tag mapping learned the nozzle and bed ranges, drying
// temperature, density and empty spool weight carry none of them.
//
// What it writes, only ever into an EMPTY field:
// - the scanned barcode into the identifier field it fits (the record's own,
//   or one its type copies up);
// - a choice the record's name plainly says, on the record's OWN fields; the
//   type's key fields (what decides which type a record sits under) are left
//   alone, since changing one on a filed record moves it;
// - what a re-read of a claimed tag URL says, into fields the record or its
//   type declares, minus the key fields.
// Never a colour: a colour field is the colour rule's.

import { Kysely, sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { registerHealPass } from "@cobblr/platform-contract/heal-pass";
import { choicesNamedIn, identifierFromScan, type FactFieldDef } from "./services/scan-field-facts.js";

interface HealDB {
  core_scan_inbox_items: {
    id: string;
    status: string;
    barcode_text: string | null;
    source_url: string | null;
    target_module: string | null;
    target_kind: string | null;
    target_entity_id: string | null;
    suggested_metadata: unknown;
    created_at: Date;
  };
}

interface MetaDB {
  module_field_defs: {
    org_id: string;
    entity_kind: string;
    name: string;
    type: string | null;
    choices: unknown;
    field_role: string | null;
    decode_role: string | null;
    renderer: string | null;
  };
}

export interface ParentCfg {
  instance: string;
  relationship_kind: string;
  key: Set<string>;
  copy: Set<string>;
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function defsFor(orgId: string, kind: string): Promise<FactFieldDef[]> {
  const meta = platform().db.meta as unknown as Kysely<MetaDB>;
  const rows = await meta
    .selectFrom("module_field_defs")
    .select(["name", "type", "choices", "field_role", "decode_role", "renderer"])
    .where("org_id", "=", orgId)
    .where("entity_kind", "=", kind)
    .execute();
  return rows.map((r) => ({ ...r, choices: strings(r.choices) }));
}

async function parentOf(orgId: string, instance: string): Promise<ParentCfg | null> {
  const p = (await platform().instances.configOf(orgId, instance))?.parent as Record<string, unknown> | undefined;
  if (!p || typeof p.instance !== "string") return null;
  return {
    instance: p.instance,
    relationship_kind: typeof p.relationship_kind === "string" && p.relationship_kind ? p.relationship_kind : "instance-of",
    key: new Set(strings(p.key_fields)),
    copy: new Set(strings(p.copy_fields)),
  };
}

const metadataOf = (snap: Record<string, unknown> | null) => (snap?.metadata as Record<string, unknown> | null | undefined) ?? {};

/** What a filed record is missing that its scan knows: the barcode into the
 *  identifier it fits, the name's plain choices on the record's own fields,
 *  and a re-read tag's values. Never a type's key field, never a colour, and
 *  only ever an empty field. */
export function planScanFacts(a: {
  barcode: string | null;
  name: string;
  own: readonly FactFieldDef[];
  typeDefs: readonly FactFieldDef[];
  parent: ParentCfg | null;
  md: Readonly<Record<string, unknown>>;
  tagFields?: Readonly<Record<string, unknown>> | null;
}): Record<string, unknown> {
  const writable = [...a.own, ...a.typeDefs].filter((d) => d.renderer !== "color-hex" && !a.parent?.key.has(d.name));
  const add: Record<string, unknown> = {
    ...identifierFromScan(a.barcode, writable, a.md),
    ...choicesNamedIn(a.name, writable.filter((d) => a.own.includes(d)), a.md),
  };
  const names = new Set(writable.map((d) => d.name));
  for (const [k, v] of Object.entries(a.tagFields ?? {})) {
    if (names.has(k) && isEmpty(a.md[k]) && !isEmpty(v) && add[k] === undefined) add[k] = v;
  }
  return add;
}

/** What the type is missing that the record carries, in the fields the type
 *  copies up; never a key field or a colour, never over a value. */
export function planTypeTopUp(a: {
  parent: ParentCfg;
  defs: readonly FactFieldDef[];
  has: Readonly<Record<string, unknown>>;
  typeMd: Readonly<Record<string, unknown>>;
}): Record<string, unknown> {
  const up: Record<string, unknown> = {};
  for (const f of a.parent.copy) {
    if (a.parent.key.has(f) || a.defs.find((d) => d.name === f)?.renderer === "color-hex") continue;
    if (!isEmpty(a.has[f]) && isEmpty(a.typeMd[f])) up[f] = a.has[f];
  }
  return up;
}

/** Heal one workspace; answers how many filed records needed it. A claimed
 *  tag that could not be re-read counts, so the workspace is visited again
 *  (an unreachable maker is not a tag with nothing to say). */
export async function healScannedTypeFactsIn(orgId: string, db: Kysely<HealDB>, since: Date): Promise<number> {
  const rows = await db
    .selectFrom("core_scan_inbox_items")
    .select(["id", "barcode_text", "source_url", "target_module", "target_kind", "target_entity_id", "suggested_metadata"])
    .where("created_at", "<", since)
    .where("status", "=", "resolved")
    .where("target_entity_id", "is not", null)
    .where(sql<boolean>`suggested_metadata->'filed_into'->>'instance' is not null`)
    .where((eb) => eb.or([eb("barcode_text", "is not", null), eb("source_url", "is not", null)]))
    .execute();
  if (!rows.length) return 0;

  const defsCache = new Map<string, FactFieldDef[]>();
  const defs = async (kind: string) => {
    if (!defsCache.has(kind)) defsCache.set(kind, await defsFor(orgId, kind));
    return defsCache.get(kind)!;
  };
  const parentCache = new Map<string, ParentCfg | null>();
  const parent = async (instance: string) => {
    if (!parentCache.has(instance)) parentCache.set(instance, await parentOf(orgId, instance));
    return parentCache.get(instance)!;
  };

  let found = 0;
  for (const r of rows) {
    const sm = (r.suggested_metadata ?? {}) as { filed_into?: { kind?: string; instance?: string }; fields?: Record<string, unknown> };
    const kind = sm.filed_into?.kind;
    const instance = sm.filed_into?.instance;
    if (!kind || !instance || !r.target_entity_id) continue;
    const snap = await platform().entities.snapshot(orgId, kind, r.target_entity_id);
    if (!snap) continue;
    const md = metadataOf(snap);

    const own = await defs(kind);
    const p = await parent(instance);
    const typeKind = p ? `${p.instance}:item` : null;
    const typeDefs = typeKind ? (await defs(typeKind)).filter((d) => p!.copy.has(d.name) && !own.some((o) => o.name === d.name)) : [];
    // A tag a resolver claimed at scan time (it seeded fields), read again for
    // what the mapping has learned since.
    let tagFields: Record<string, unknown> | null = null;
    if (r.source_url && sm.fields && Object.keys(sm.fields).length) {
      const again = await platform().scan.resolveUrl(r.source_url).catch(() => null);
      if (again) tagFields = again.fields;
      else found++;
    }
    const add = planScanFacts({
      barcode: r.barcode_text,
      name: typeof snap.name === "string" ? snap.name : "",
      own,
      typeDefs,
      parent: p,
      md,
      tagFields,
    });

    let wrote = false;
    if (Object.keys(add).length) {
      wrote = await platform().entities.mergeMetadata(orgId, kind, r.target_entity_id, add);
    }

    // The type carries what the record now carries, in the fields it copies.
    if (p && typeKind && r.target_module && r.target_kind) {
      const baseKind = `${r.target_module}:${r.target_kind}`;
      const link = await platform().pairings.findBySources({
        orgId,
        sourceKind: baseKind,
        sourceIds: [r.target_entity_id],
        targetKind: baseKind,
        relationshipKind: p.relationship_kind,
      });
      const typeId = link[0]?.targetId;
      if (typeId) {
        const has = { ...md, ...add };
        const typeMd = metadataOf(await platform().entities.snapshot(orgId, typeKind, typeId));
        const up = planTypeTopUp({ parent: p, defs: [...own, ...typeDefs], has, typeMd });
        if (Object.keys(up).length && (await platform().entities.mergeMetadata(orgId, typeKind, typeId, up))) wrote = true;
      }
    }
    if (wrote) found++;
  }
  return found;
}

/** Call from onBoot. A registered pass (heal-pass.ts): the kernel's walk,
 *  budget and stagger, never a walk of its own at boot. */
export function registerScannedTypeFactsHeal(): void {
  registerHealPass({
    name: "core-scan.heal-scanned-type-facts",
    since: "2026-09-29T14:59:51Z",
    shim: "modules/core-scan/src/heal-scanned-type-facts.ts",
    module: "core-scan",
    visit: async ({ orgId, db, since }) => {
      const n = await healScannedTypeFactsIn(orgId, db as Kysely<HealDB>, since);
      if (n > 0) console.log(`[core-scan] org ${orgId}: filled what the scan knew on ${n} filed record(s)`);
      return n;
    },
  });
}
