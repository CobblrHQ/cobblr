// /api/v1/orgs/:slug/modules/digifab/printing-profiles — a machine's Printing
// profile (Services §14.3), and the digifab.pick-printer action that reads it.
//
// One profile per machine, not per slicer: a slicer maps the neutral printer
// model id to its own presets, so a second slicer reads the same values.

import { Router } from "express";
import { z } from "zod";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb, type DigifabDB } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { classify } from "../state.js";
import { occupiesDevice, NOT_OCCUPYING_STATUSES } from "../jobs-core.js";
import { rankPrinters, type LoadedSpool, type PrintAsk, type PrinterCandidate, type PrintingProfile } from "../pick-printer.js";
import type { RemoteDevice } from "../drivers/types.js";

export const printingProfilesRouter = Router({ mergeParams: true });

/** The kind a machine record is, as the machines module declares it. */
const MACHINE_KIND = "machines:machine";

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

function volumeOf(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const xs = v.map(num);
  return xs.every((x): x is number => x !== null && x > 0) ? (xs as [number, number, number]) : null;
}

export function profileOf(row: {
  printer_model: string | null;
  nozzle_mm: unknown;
  build_volume_mm: unknown;
  default_quality: string | null;
  preset_hints: unknown;
} | undefined | null): PrintingProfile | null {
  if (!row) return null;
  const hints: Record<string, string> = {};
  if (row.preset_hints && typeof row.preset_hints === "object") {
    for (const [k, v] of Object.entries(row.preset_hints as Record<string, unknown>)) if (typeof v === "string" && v.trim()) hints[k] = v.trim();
  }
  return {
    printer_model: row.printer_model?.trim() || null,
    nozzle_mm: num(row.nozzle_mm),
    build_volume_mm: volumeOf(row.build_volume_mm),
    default_quality: row.default_quality?.trim() || null,
    preset_hints: hints,
  };
}

/** The filament types a preset hint can be set for on this machine: the types
 *  of the spools loaded in it, and any type that already has a hint. */
async function filamentTypesFor(orgId: string, machineId: string, hinted: string[]): Promise<Array<{ id: string; name: string | null }>> {
  const ids = new Set(hinted);
  const contents = await platform().placement.contents({ orgId, container: { kind: MACHINE_KIND, id: machineId } }).catch(() => []);
  for (const c of contents) {
    const t = await platform()
      .pairings.findBySources({ orgId, sourceKind: c.kind, sourceIds: [c.id], targetKind: c.kind, relationshipKind: "instance-of" })
      .catch(() => []);
    if (t[0]?.targetId) ids.add(t[0].targetId);
  }
  const out: Array<{ id: string; name: string | null }> = [];
  for (const id of ids) {
    const kind = contents[0]?.kind ?? "inventory:part";
    const snap = await platform().entities.snapshot(orgId, kind, id).catch(() => null);
    out.push({ id, name: typeof snap?.name === "string" ? snap.name : null });
  }
  return out;
}

// GET /:machineId — the machine's Printing profile (or an empty one), and the
// filament types a preset hint can be set for.
printingProfilesRouter.get(
  "/:machineId",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const row = await db.selectFrom("digifab_printing_profiles").selectAll().where("machine_id", "=", req.params.machineId!).executeTakeFirst();
    const profile = profileOf(row) ?? { printer_model: null, nozzle_mm: null, build_volume_mm: null, default_quality: null, preset_hints: {} };
    res.json({
      machine_id: req.params.machineId,
      profile,
      filament_types: await filamentTypesFor(tenantContext(req).org.id, req.params.machineId!, Object.keys(profile.preset_hints)),
      updated_at: row?.updated_at ?? null,
    });
  }),
);

const ProfileBody = z.object({
  printer_model: z.string().trim().max(120).regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._+-]*$/i, "a neutral id, like bambulab/a1").nullable().optional(),
  nozzle_mm: z.number().positive().max(5).nullable().optional(),
  build_volume_mm: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]).nullable().optional(),
  default_quality: z.string().trim().max(120).nullable().optional(),
  preset_hints: z.record(z.string().min(1).max(80), z.string().trim().max(200)).optional(),
});

// AI-REACH: exempt a machine setting edited on its own panel; the assistant reads it through digifab:pick-printer, which is the door it needs
printingProfilesRouter.put(
  "/:machineId",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const p = ProfileBody.safeParse(req.body);
    if (!p.success) return void badBody(res, p.error);
    const db = tenantDb(req);
    const hints = Object.fromEntries(Object.entries(p.data.preset_hints ?? {}).filter(([, v]) => v));
    const values = {
      machine_id: req.params.machineId!,
      printer_model: p.data.printer_model ?? null,
      nozzle_mm: p.data.nozzle_mm ?? null,
      build_volume_mm: p.data.build_volume_mm ? (sql`${JSON.stringify(p.data.build_volume_mm)}::jsonb` as never) : null,
      default_quality: p.data.default_quality ?? null,
      preset_hints: sql`${JSON.stringify(hints)}::jsonb` as never,
      updated_at: new Date(),
    };
    const row = await db
      .insertInto("digifab_printing_profiles")
      .values(values)
      .onConflict((oc) => oc.column("machine_id").doUpdateSet({ ...values, machine_id: undefined as never }))
      .returningAll()
      .executeTakeFirstOrThrow();
    res.json({ machine_id: row.machine_id, profile: profileOf(row), updated_at: row.updated_at });
  }),
);

/** Grams left on a spool record, from its quantity and unit; null when the
 *  record does not say. */
function gramsLeft(snap: Record<string, unknown>): number | null {
  const q = num(snap.qty);
  if (q === null) return null;
  const unit = String(snap.unit ?? "").trim().toLowerCase();
  if (unit === "g" || unit === "gram" || unit === "grams") return q;
  if (unit === "kg") return q * 1000;
  return null;
}

/** Every linked printer as pick-printer sees it: its profile, the spools placed
 *  in its slots, whether it is free right now, and where it sits in the
 *  person's pool order. */
export async function gatherCandidates(orgId: string, db: Kysely<DigifabDB>): Promise<PrinterCandidate[]> {
  const links = await db.selectFrom("digifab_device_links").selectAll().execute();
  if (!links.length) return [];
  const profiles = new Map(
    (await db.selectFrom("digifab_printing_profiles").selectAll().execute()).map((r) => [r.machine_id, profileOf(r)] as const),
  );
  // Free = the fleet's own reading of the manager's state, no job holding the
  // printer, and no bed waiting for a person to clear it (assign-worker's rule).
  const cached = await db.selectFrom("digifab_fleet_device_cache").select(["connection_id", "devices"]).execute();
  const deviceState = new Map<string, RemoteDevice>();
  for (const c of cached) for (const d of (Array.isArray(c.devices) ? c.devices : []) as RemoteDevice[]) deviceState.set(`${c.connection_id}:${d.id}`, d);
  const active = await db
    .selectFrom("digifab_jobs")
    .select(["connection_id", "target_device", "status"])
    .where("status", "not in", [...NOT_OCCUPYING_STATUSES])
    .execute();
  const busy = new Set(active.filter((a) => a.connection_id && a.target_device && occupiesDevice(a.status)).map((a) => `${a.connection_id}:${a.target_device}`));
  const attention = new Set(
    (await db.selectFrom("digifab_device_attention").select(["connection_id", "remote_device_id"]).execute()).map((a) => `${a.connection_id}:${a.remote_device_id}`),
  );
  const pools = await db.selectFrom("digifab_pools").select(["id"]).orderBy("created_at", "asc").execute();
  const members = await db.selectFrom("digifab_pool_members").select(["pool_id", "connection_id", "remote_device_id"]).orderBy("created_at", "asc").execute();
  const poolOrder = new Map<string, number>();
  let n = 0;
  for (const p of pools) for (const m of members.filter((x) => x.pool_id === p.id)) {
    const key = `${m.connection_id}:${m.remote_device_id}`;
    if (!poolOrder.has(key)) poolOrder.set(key, n++);
  }

  const out: PrinterCandidate[] = [];
  for (const l of links) {
    const key = `${l.connection_id}:${l.remote_device_id}`;
    const dev = deviceState.get(key);
    const idle = !!dev && dev.enabled !== false && classify(dev.state ?? "") === "idle" && !busy.has(key) && !attention.has(key);
    const loaded: LoadedSpool[] = [];
    const contents = await platform()
      .placement.contents({ orgId, container: { kind: MACHINE_KIND, id: l.machine_id } })
      .catch(() => []);
    for (const c of contents) {
      const snap = await platform().entities.snapshot(orgId, c.kind, c.id).catch(() => null);
      if (!snap) continue;
      const md = (snap.metadata ?? {}) as Record<string, unknown>;
      const types = await platform()
        .pairings.findBySources({ orgId, sourceKind: c.kind, sourceIds: [c.id], targetKind: c.kind, relationshipKind: "instance-of" })
        .catch(() => []);
      loaded.push({
        spool: { kind: c.kind, id: c.id, name: typeof snap.name === "string" ? snap.name : null },
        slot: c.slot ?? null,
        material: typeof md.material === "string" ? md.material : null,
        color: typeof md.color === "string" ? md.color : null,
        grams_left: gramsLeft(snap),
        type_id: types[0]?.targetId ?? null,
      });
    }
    out.push({
      machine: { id: l.machine_id, label: l.machine_label },
      device: { connection_id: l.connection_id, remote_device_id: l.remote_device_id, name: l.remote_device_name },
      idle,
      profile: profiles.get(l.machine_id) ?? null,
      loaded,
      pool_order: poolOrder.get(key) ?? null,
    });
  }
  return out;
}

function readAsk(args: Record<string, unknown>): PrintAsk | string {
  const material = typeof args.material === "string" ? args.material.trim() : "";
  if (!material) return "a material is needed (PLA, PETG, ...)";
  const grams = num(args.grams);
  if (grams === null || grams <= 0) return "the grams the print needs are needed";
  const raw = typeof args.bbox_mm === "string" ? args.bbox_mm.split(/[\s,x×]+/).filter(Boolean) : args.bbox_mm;
  const bbox = volumeOf(raw);
  if (!bbox) return "the part's size is needed as x, y, z in mm";
  const nozzle = num(args.nozzle_mm);
  return { material, color: typeof args.color === "string" && args.color.trim() ? args.color.trim() : null, grams, bbox_mm: bbox, nozzle_mm: nozzle };
}

/** digifab.pick-printer: rank the linked printers for a print. Sends nothing. */
export function registerPickPrinter(): void {
  platform().actions.registerHandler("digifab.pick-printer", async (ctx) => {
    const ask = readAsk((ctx.args as Record<string, unknown> | null) ?? {});
    if (typeof ask === "string") return { ok: false, error: ask };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const printers = rankPrinters(ask, await gatherCandidates(ctx.orgId, db));
    const best = printers.find((p) => p.usable && p.fits !== false) ?? null;
    return {
      ok: true,
      best,
      printers,
      summary: best
        ? `${best.machine.label ?? best.device.name ?? "A printer"}: ${best.reason}`
        : printers.length
          ? "No linked printer can take this print as asked."
          : "No printer is linked to a machine manager yet.",
    };
  });
  // It changes nothing, so there is nothing to put back.
  platform().actions.registerUndo("digifab.pick-printer", () => null);
}
