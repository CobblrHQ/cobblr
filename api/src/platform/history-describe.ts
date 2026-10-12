// A record's history, said in words (#4517).
//
// The log stores what changed (`changes`, old → new, activity-changes.ts) or,
// for rows written before that, the patch alone. This turns either into what
// a person reads: each field under its label (the workspace's relabel, the
// manifest's label, the custom field's label), each value by its type (a
// place by its name, a date as a date, a photo as a photo with where it came
// from), never a column name, an id or a storage path. One place, so the
// History panel, the dashboard and the Activity page say a change the same
// way.
import { changesIn, isInternalField, type ActivityChange } from "@cobblr/platform-contract/activity-changes";
import { referenceStem, saidLabel, saidValue, stockReadingOf, type SaidFieldType } from "@cobblr/platform-contract/activity-said";
import { quantityWithUnit } from "@cobblr/platform-contract/plural";
import type { PhotoSource } from "@cobblr/platform-contract/photo-source";
import { formatStoredMoney, moneyStorageOf, type MoneyFieldLike, type MoneyStorage } from "@cobblr/platform-contract/money";
import { platform } from "@cobblr/platform-contract";
import { meta } from "../db/meta.js";
import { resolveFieldDefsForKind } from "./field-defs.js";
import { lookup as lookupEntity } from "./entities.js";
import { describe as describeFiles } from "./files.js";

export interface ShownPhoto {
  file_id: string;
  /** The small picture, by the file's own address (fetched with the bearer). */
  thumb: string;
  filename: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  source: PhotoSource | null;
  /** The stored address, for the curious: only ever in the detail card. */
  path: string;
}

export interface ShownValue {
  /** The value in words; null is "(empty)". */
  text: string | null;
  photo?: ShownPhoto;
}

export interface SaidChange {
  field: string;
  label: string;
  /** Absent on a row written before old values were kept: only the new one is known. */
  from?: ShownValue;
  to: ShownValue;
}

interface FieldInfo extends SaidFieldType {
  label: string;
  /** Money, and how it is stored: said through the one money formatter. */
  money?: MoneyStorage | null;
}

/** What an activity row carries beside its fields (how it came, what it
 *  answered): never a field anyone changed. The record's own internal fields
 *  are the contract's one rule, isInternalField. */
const ROW_KEYS = new Set(["changes", "via", "event", "updates", "order_id", "said", "declined"]);
const notSaid = (field: string) => ROW_KEYS.has(field) || isInternalField(field);

/** The fields of one kind, labelled the way its forms are. */
async function fieldsOf(orgId: string, kinds: string[]): Promise<Map<string, FieldInfo>> {
  const out = new Map<string, FieldInfo>();
  const all = await platform().entities.listKindsForOrg(orgId);
  for (const k of kinds) {
    const rec = all.find((r) => r.id === k);
    for (const f of rec?.fields ?? []) {
      if (!out.has(f.name)) out.set(f.name, { label: saidLabel(f.name, (f as { label?: string }).label), type: f.type, choices: f.choices ?? null, money: moneyStorageOf(f as MoneyFieldLike) });
    }
  }
  const relabels = await meta
    .selectFrom("native_field_overrides")
    .select(["entity_kind", "name", "display_label"])
    .where("org_id", "=", orgId)
    .where("entity_kind", "in", kinds)
    .where("display_label", "is not", null)
    .execute();
  for (const r of relabels) {
    const f = out.get(r.name);
    out.set(r.name, { ...(f ?? {}), label: r.display_label as string });
  }
  for (const k of kinds) {
    for (const d of await resolveFieldDefsForKind(orgId, k).catch(() => [])) {
      if (!out.has(d.name)) out.set(d.name, { label: saidLabel(d.name, d.display_label), type: d.type, choices: (d.choices as SaidFieldType["choices"]) ?? null, money: moneyStorageOf(d as MoneyFieldLike) });
    }
  }
  return out;
}

/** The changes a row carries: old → new, or the row's own fields (an older
 *  edit's new values, what a record was made with, what an action recorded),
 *  so the Activity page's details read in words too, never as raw JSON. */
function changesOfRow(action: string, diff: unknown): ActivityChange[] {
  if (action === "secret_field_revealed" || action === "secret_field_copied") return [];
  const kept = changesIn(diff);
  if (kept) return kept;
  if (!diff || typeof diff !== "object" || Array.isArray(diff)) return [];
  const d = diff as Record<string, unknown>;
  const out: ActivityChange[] = [];
  for (const [field, to] of Object.entries(d)) {
    if (notSaid(field) || to === undefined) continue;
    out.push({ field, from: undefined, to });
  }
  for (const key of ["metadata", "fields"]) {
    const bag = d[key];
    if (bag && typeof bag === "object" && !Array.isArray(bag)) {
      for (const [field, to] of Object.entries(bag as Record<string, unknown>)) out.push({ field, custom: true, from: undefined, to });
    }
  }
  return out;
}

const FILE_IN_PATH = /\/core-files\/files\/([0-9a-f-]{36})\/raw/i;

/** An amount in the unit it is kept in, through the workspace's own words:
 *  "8.4 m", "3 skeins", "1 skein", or the bare number for a count of each. */
export async function saidAmount(orgId: string, n: number, unit: string | null): Promise<string> {
  const amount = parseFloat(n.toFixed(3));
  if (!unit || unit.toLowerCase() === "each") return String(amount);
  const resolved = await platform().units.resolve(orgId, unit).catch(() => null);
  return quantityWithUnit(amount, unit, resolved);
}

/** Every row's changes, said. `rows[i].kinds` is the record's collection kind
 *  then its module kind, so a relabel on either is found. */
export async function describeChanges(
  orgId: string,
  slug: string,
  rows: Array<{ action: string; diff: unknown; kinds: string[] }>,
): Promise<SaidChange[][]> {
  const raw = rows.map((r) => changesOfRow(r.action, r.diff).filter((c) => (!notSaid(c.field) || c.custom) && !c.field.startsWith("money_currency_")));
  if (raw.every((r) => r.length === 0)) return raw.map(() => []);

  const currency = await platform().money.currency(orgId);
  const fieldsByKinds = new Map<string, Map<string, FieldInfo>>();
  for (const r of rows) {
    const key = r.kinds.join("|");
    if (!fieldsByKinds.has(key)) fieldsByKinds.set(key, await fieldsOf(orgId, r.kinds));
  }

  // Photos: one describe for every file any row names.
  const fileIds = new Set<string>();
  for (const cs of raw) for (const c of cs) for (const v of [c.from, c.to]) {
    const m = typeof v === "string" ? FILE_IN_PATH.exec(v) : null;
    if (m) fileIds.add(m[1]!.toLowerCase());
  }
  const files = new Map((await describeFiles(orgId, [...fileIds]).catch(() => null) ?? []).map((f) => [f.fileId.toLowerCase(), f]));

  // References: each `<x>_id` value named by its record's title.
  const kinds = await platform().entities.listKindsForOrg(orgId);
  const titles = new Map<string, string | null>();
  const refKind = (field: string, own: string[]): string | null => {
    const stem = referenceStem(field);
    if (!stem) return null;
    if (stem === "parent") return own[own.length - 1] ?? null;
    const sameModule = own.map((k) => k.split(":")[0]);
    return (
      kinds.find((k) => k.id.endsWith(`:${stem}`) && sameModule.includes(k.module_name))?.id ??
      kinds.find((k) => k.id.endsWith(`:${stem}`))?.id ??
      null
    );
  };
  const titleOf = async (kind: string, id: string): Promise<string | null> => {
    const key = `${kind} ${id}`;
    if (!titles.has(key)) titles.set(key, (await lookupEntity(orgId, kind, id).catch(() => null))?.title ?? null);
    return titles.get(key) ?? null;
  };

  const amountIn = (n: number, unit: string | null) => saidAmount(orgId, n, unit);
  const show = async (value: unknown, field: string, info: FieldInfo | undefined, own: string[]): Promise<ShownValue> => {
    if (field === "image_path" || info?.type === "image-path") {
      if (value === null || value === undefined || value === "") return { text: null };
      const m = FILE_IN_PATH.exec(String(value));
      const f = m ? files.get(m[1]!.toLowerCase()) : undefined;
      if (!f) return { text: "a photo" };
      return {
        text: f.filename,
        photo: {
          file_id: f.fileId,
          thumb: `/api/v1/orgs/${slug}/modules/core-files/files/${f.fileId}/raw?variant=thumb`,
          filename: f.filename,
          size_bytes: f.sizeBytes,
          width: f.width,
          height: f.height,
          source: f.photoSource,
          path: String(value),
        },
      };
    }
    if (info?.money) {
      if (value === null || value === undefined || value === "") return { text: null };
      const said = formatStoredMoney(value, info.money, { currency });
      if (said) return { text: said };
    }
    const kind = refKind(field, own);
    if (kind && typeof value === "string" && value) return { text: (await titleOf(kind, value)) ?? "a record that is gone" };
    // A stock reading is how much, in the unit it is kept in (#6039).
    const reading = stockReadingOf(value);
    if (reading) return { text: await amountIn(reading.remaining, reading.unit) };
    return { text: saidValue(value, info ?? {}) };
  };

  return Promise.all(
    raw.map(async (cs, i) => {
      const own = rows[i]!.kinds;
      const info = fieldsByKinds.get(own.join("|"))!;
      return Promise.all(
        cs.map(async (c): Promise<SaidChange> => {
          const f = info.get(c.field);
          if (c.secret || f?.type === "secret") return { field: c.field, label: f?.label ?? saidLabel(c.field), to: { text: "updated" } };
          const said: SaidChange = { field: c.field, label: f?.label ?? saidLabel(c.field), to: await show(c.to, c.field, f, own) };
          if (changesIn(rows[i]!.diff)) said.from = await show(c.from, c.field, f, own);
          return said;
        }),
      );
    }),
  );
}
