// What a store's mixed pack holds, learned centrally (#3769, #5764). When
// every part of a split pack is filed with a colour, the pack's contents go to
// the barcode network as store facts: the store, the product, the options that
// say which pack, and each unit's colour, box colour and part number. No
// person, workspace, price or photo; the reporter is the usual opaque actor.
// The next workspace asks before reading a pack's photo with a model.
//
// Sent only when this instance is connected to the network with a write
// target (the owner's #3769 decision: hosted workspaces contribute, with no
// switch; a self-hosted install sends nothing until its operator connects it).
// Asking needs only the read token.

import { sql, type Kysely } from "kysely";
import type { BoxChoice } from "@cobblr/platform-contract/box-label";
import { storeVariantOf } from "@cobblr/platform-contract/same-product";
import { opaqueUserActor } from "@cobblr/platform-contract/photo-retention";
import type { CoreScanDB } from "../db.js";
import { mergeMeta } from "./metadata.js";
import type { ValueOrigin } from "./barcode-corrections.js";

export interface PackKey {
  host: string;
  title: string;
  options: string[];
}

export interface PackAnswer {
  units: BoxChoice[];
  /** "single": one person's word; "confident": two or more agree. */
  confidence: "single" | "confident";
}

export function packTarget(env: NodeJS.ProcessEnv = process.env): { match: string; confirm: string; readToken: string; writeToken: string } | null {
  const resolver = (env.COBBLR_BARCODE_RESOLVER_URL ?? "").replace(/\/+$/, "");
  if (resolver && env.COBBLR_BARCODE_RESOLVER_TOKEN) {
    return {
      match: `${resolver}/pack-match`,
      confirm: `${resolver}/pack-confirm`,
      readToken: env.COBBLR_BARCODE_RESOLVER_TOKEN,
      writeToken: env.COBBLR_BARCODE_RESOLVER_CORRECTION_TOKEN ?? "",
    };
  }
  const bidb = (env.COBBLR_BIDB_URL ?? "").replace(/\/+$/, "");
  const key = (env.COBBLR_BIDB_KEY ?? "").trim();
  if (bidb && key) return { match: `${bidb}/v1/pack-match`, confirm: `${bidb}/v1/pack-confirm`, readToken: key, writeToken: key };
  return null;
}

/** What the network says a pack holds, or null (unknown, contested, not
 *  connected, or it could not be asked: the photo read then decides). */
export async function askPackNetwork(key: PackKey, fetchImpl: typeof fetch = fetch): Promise<PackAnswer | null> {
  const target = packTarget();
  if (!target) return null;
  try {
    const res = await fetchImpl(target.match, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.readToken}` },
      body: JSON.stringify(key),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as { found?: boolean; units?: unknown; confidence?: unknown };
    if (!d.found || !Array.isArray(d.units) || d.units.length < 2) return null;
    const units = (d.units as Array<Record<string, unknown>>)
      .filter((u) => typeof u.colour === "string" && u.colour.trim())
      .map((u) => ({ colour: String(u.colour), label_colour: typeof u.label_colour === "string" ? u.label_colour : null, sku: typeof u.sku === "string" ? u.sku : null }));
    if (units.length !== d.units.length) return null;
    return { units, confidence: d.confidence === "confident" ? "confident" : "single" };
  } catch {
    return null;
  }
}

/** Send one pack's contents. Nothing is sent without a write target or an
 *  actor (an anonymous filing never counts, so it is not sent). */
export async function reportPack(key: PackKey, units: readonly BoxChoice[], origin: ValueOrigin, userId: string | null | undefined, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const target = packTarget();
  if (!target?.writeToken) return false;
  const actor = opaqueUserActor(userId, process.env.JWT_SECRET);
  if (!actor || units.length < 2) return false;
  try {
    const res = await fetchImpl(target.confirm, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${target.writeToken}` },
      body: JSON.stringify({ ...key, units: units.map((u) => ({ colour: u.colour, ...(u.label_colour ? { label_colour: u.label_colour } : {}), ...(u.sku ? { sku: u.sku } : {}) })), origin, corrected_by: actor }),
      signal: AbortSignal.timeout(8_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface PartRow {
  id: string;
  status: string;
  quantity: number | string | null;
  suggested_name: string | null;
  suggested_metadata: unknown;
}

/** What a filed pack holds, from its parts: each part's colour (its name's
 *  last option when a person renamed it), its box's colour and part number,
 *  once per unit. Null while a part is unfiled or of unknown colour. Pure. */
export function filedPackUnits(parts: readonly PartRow[]): { units: BoxChoice[]; origin: ValueOrigin } | null {
  const live = parts.filter((p) => p.status !== "discarded");
  if (live.length === 0 || live.some((p) => p.status !== "resolved")) return null;
  const units: BoxChoice[] = [];
  let person = false;
  for (const p of live) {
    const m = (p.suggested_metadata ?? {}) as { pack_colour?: unknown; pack_unit?: { label_colour?: unknown; sku?: unknown }; box_label?: { colour?: unknown; sku?: unknown }; description?: unknown; box_scan?: unknown };
    const renamed = typeof m.description === "string" && (p.suggested_name ?? "").trim() !== m.description.trim();
    const colour = (renamed ? storeVariantOf(p.suggested_name)?.options.at(-1) : null) ?? (typeof m.pack_colour === "string" ? m.pack_colour : null);
    if (!colour || /unknown/i.test(colour)) return null;
    if (renamed || m.box_scan) person = true;
    const label = renamed ? null : typeof m.pack_unit?.label_colour === "string" ? m.pack_unit.label_colour : null;
    const sku = renamed ? null : typeof m.pack_unit?.sku === "string" ? m.pack_unit.sku : null;
    const n = Math.max(1, Math.round(Number(p.quantity ?? 1)));
    for (let i = 0; i < n; i++) units.push({ colour, label_colour: label, sku });
  }
  return units.length >= 2 ? { units, origin: person ? "person" : "ai" } : null;
}

/** After a part of a split pack is filed: once all its parts are, report the
 *  pack's contents, once. */
export async function reportPackIfFiled(db: Kysely<CoreScanDB>, partMeta: unknown, userId: string | null | undefined, send: typeof reportPack = reportPack): Promise<"reported" | "waiting" | "no"> {
  const pm = (partMeta ?? {}) as { split_from?: unknown; split_off_from?: unknown };
  let parentId = typeof pm.split_from === "string" ? pm.split_from : null;
  if (!parentId && typeof pm.split_off_from === "string") {
    const up = await db.selectFrom("core_scan_inbox_items").select("suggested_metadata").where("id", "=", pm.split_off_from).executeTakeFirst();
    const um = (up?.suggested_metadata ?? {}) as { split_from?: unknown };
    parentId = typeof um.split_from === "string" ? um.split_from : null;
  }
  if (!parentId) return "no";
  const parent = await db.selectFrom("core_scan_inbox_items").select("suggested_metadata").where("id", "=", parentId).executeTakeFirst();
  const meta = (parent?.suggested_metadata ?? {}) as { pack_key?: PackKey; pack_reported?: unknown };
  if (!meta.pack_key || meta.pack_reported) return "no";
  const cols = ["id", "status", "quantity", "suggested_name", "suggested_metadata"] as const;
  const parts = await db.selectFrom("core_scan_inbox_items").select([...cols]).where(sql<boolean>`suggested_metadata->>'split_from' = ${parentId}`).execute();
  const ids = parts.map((p) => p.id);
  const offs = ids.length ? await db.selectFrom("core_scan_inbox_items").select([...cols]).where(sql<boolean>`suggested_metadata->>'split_off_from' = any(${ids})`).execute() : [];
  const filed = filedPackUnits([...parts, ...offs] as PartRow[]);
  if (!filed) return "waiting";
  if (!(await send(meta.pack_key, filed.units, filed.origin, userId))) return "no";
  await db.updateTable("core_scan_inbox_items").set({ suggested_metadata: mergeMeta({ pack_reported: true }) as never }).where("id", "=", parentId).execute();
  return "reported";
}
