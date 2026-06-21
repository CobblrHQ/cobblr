// /api/v1/orgs/:slug/modules/digifab/history — print history + at-a-glance stats.
//
// Read-only aggregate over digifab_jobs (the prints Cobblr sent + tracked to a
// terminal state). A summary (count, success rate, filament, hours) + the recent
// prints, over a window. Per-printer rollups so you can see which machine did
// what. No new storage — it's a read model on the jobs table.

import { Router } from "express";
import { sql } from "kysely";
import { tenantDb } from "../db.js";
import { asyncHandler } from "./util.js";

export const historyRouter = Router({ mergeParams: true });

const TERMINAL = ["completed", "failed", "cancelled"];
const n = (v: unknown) => (v == null ? 0 : Number(v));

// Bambu/Orca print-PROFILE names are often Chinese (e.g. "成年人版 0.2mm 层高,
// 3 层墙, 15% 填充"). Bambu translates the model title but NOT the profile, so we
// map the handful of formulaic slicer terms to English for display. Multi-char
// terms first (层高/层墙 before the standalone 层/墙) so partial matches don't win.
const ZH_PROFILE: [RegExp, string][] = [
  [/层高/g, "layer"], [/层墙/g, "walls"], [/圈墙|道墙/g, "walls"], [/墙/g, "walls"],
  [/填充/g, "infill"], [/成年人版|成人版/g, "Adult"], [/儿童版/g, "Kids"], [/迷你版/g, "Mini"],
  [/标准/g, "Standard"], [/草稿/g, "Draft"], [/精细/g, "Fine"], [/强度/g, "Strength"],
  [/外观/g, "Visual"], [/速度/g, "Speed"], [/喷嘴/g, "nozzle"],
  [/无支撑/g, "no supports"], [/有支撑/g, "with supports"], [/支撑/g, "supports"],
  [/无/g, "no"], [/层/g, "layers"], [/版/g, ""],
];
function tidyProfile(s: string | null | undefined): string | null {
  if (!s) return null;
  let out = String(s);
  for (const [re, en] of ZH_PROFILE) out = out.replace(re, en);
  return out.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim() || null;
}

historyRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db = tenantDb(req);
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const since = new Date(Date.now() - days * 86_400_000);

    const summary = await db
      .selectFrom("digifab_jobs")
      .where("status", "in", TERMINAL)
      .where("updated_at", ">", since)
      .select([
        sql<number>`count(*)`.as("total"),
        sql<number>`count(*) filter (where status = 'completed')`.as("completed"),
        sql<number>`count(*) filter (where status = 'failed')`.as("failed"),
        sql<number>`count(*) filter (where status = 'cancelled')`.as("cancelled"),
        sql<number>`coalesce(sum((material_grams)::numeric) filter (where status = 'completed'), 0)`.as("filament_g"),
        sql<number>`coalesce(sum(extract(epoch from (updated_at - created_at))) filter (where status = 'completed'), 0)`.as("seconds"),
      ])
      .executeTakeFirst();

    // Device names: prefer the user's linked machine label, else the remote name.
    const links = await db
      .selectFrom("digifab_device_links")
      .select(["connection_id", "remote_device_id", "machine_label", "remote_device_name"])
      .execute();
    const nameOf = (connId: string | null, dev: string | null) => {
      const l = links.find((x) => x.connection_id === connId && x.remote_device_id === dev);
      return l?.machine_label || l?.remote_device_name || dev || "—";
    };

    const recent = await db
      .selectFrom("digifab_jobs")
      .where("status", "in", TERMINAL)
      .where("updated_at", ">", since)
      .select(["id", "file_ref", "connection_id", "target_device", "status", "material_grams", "created_at", "updated_at"])
      .orderBy("updated_at", "desc")
      .limit(50)
      .execute();

    // Per-(connection, device) rollup.
    const byDeviceRows = await db
      .selectFrom("digifab_jobs")
      .where("status", "in", TERMINAL)
      .where("updated_at", ">", since)
      .where("target_device", "is not", null)
      .groupBy(["connection_id", "target_device"])
      .select([
        "connection_id",
        "target_device",
        sql<number>`count(*)`.as("total"),
        sql<number>`count(*) filter (where status = 'completed')`.as("completed"),
        sql<number>`count(*) filter (where status = 'failed')`.as("failed"),
        sql<number>`coalesce(sum((material_grams)::numeric) filter (where status = 'completed'), 0)`.as("filament_g"),
      ])
      .execute();

    // Bambu prints come from the cloud print-history (digifab_bambu_tasks) — far
    // richer than the MQTT-observed rows: model name (translated), cover thumbnail,
    // weight, duration. One row per cloud task; supersedes digifab_observed_prints
    // for Bambu (which the pump can no longer name well).
    type Item = { id: string; file_ref: string; sub_label: string | null; cover: string | null; device: string; status: string; filament_g: number | null; at: string; duration_s: number };
    const taskRows = await db.selectFrom("digifab_bambu_tasks").select(["task_id", "raw", "captured_at"]).execute();
    const taskItems: Item[] = taskRows
      .map((t) => {
        const r = t.raw as Record<string, unknown>;
        const name = (r.designTitleTranslated as string) || (r.designTitle as string) || (r.title as string) || "(print)";
        const at = r.endTime ? new Date(r.endTime as string).toISOString() : new Date(t.captured_at).toISOString();
        const dur = Number(r.costTime) || (r.startTime && r.endTime ? (new Date(r.endTime as string).getTime() - new Date(r.startTime as string).getTime()) / 1000 : 0);
        return {
          id: `task:${t.task_id}`,
          file_ref: name,
          sub_label: tidyProfile(r.title as string),
          cover: (r.cover as string) || null,
          device: (r.deviceName as string) || "—",
          status: r.status === 3 ? "failed" : "completed",
          filament_g: r.weight != null ? Number(r.weight) : null,
          at,
          duration_s: dur,
        };
      })
      .filter((t) => new Date(t.at) > since);
    const taskHours = taskItems.reduce((h, t) => h + t.duration_s / 3600, 0);

    // by-device: jobs + cloud tasks, keyed by resolved device name.
    const byName = new Map<string, { name: string; total: number; completed: number; failed: number; filament_g: number }>();
    for (const r of byDeviceRows) {
      const name = nameOf(r.connection_id, r.target_device);
      const e = byName.get(name) ?? { name, total: 0, completed: 0, failed: 0, filament_g: 0 };
      e.total += n(r.total); e.completed += n(r.completed); e.failed += n(r.failed); e.filament_g += n(r.filament_g);
      byName.set(name, e);
    }
    for (const t of taskItems) {
      const e = byName.get(t.device) ?? { name: t.device, total: 0, completed: 0, failed: 0, filament_g: 0 };
      e.total += 1;
      if (t.status === "completed") e.completed += 1;
      if (t.status === "failed") e.failed += 1;
      e.filament_g += t.filament_g ?? 0;
      byName.set(t.device, e);
    }

    // recent: union jobs + cloud tasks, newest first.
    const recentMerged: Item[] = [
      ...recent.map((r) => ({
        id: r.id,
        file_ref: r.file_ref,
        sub_label: null as string | null,
        cover: null as string | null,
        device: nameOf(r.connection_id, r.target_device),
        status: r.status,
        filament_g: r.material_grams == null ? null : Number(r.material_grams),
        at: new Date(r.updated_at).toISOString(),
        duration_s: Math.max(0, (new Date(r.updated_at).getTime() - new Date(r.created_at).getTime()) / 1000),
      })),
      ...taskItems,
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);

    const taskCompleted = taskItems.filter((t) => t.status === "completed").length;
    const taskFailed = taskItems.filter((t) => t.status === "failed").length;
    const taskFilament = taskItems.reduce((g, t) => g + (t.filament_g ?? 0), 0);
    res.json({
      days,
      summary: {
        total: n(summary?.total) + taskItems.length,
        completed: n(summary?.completed) + taskCompleted,
        failed: n(summary?.failed) + taskFailed,
        cancelled: n(summary?.cancelled),
        filament_g: Math.round(n(summary?.filament_g) + taskFilament),
        hours: Math.round((n(summary?.seconds) / 3600 + taskHours) * 10) / 10,
      },
      by_device: [...byName.values()],
      recent: recentMerged,
    });
  }),
);
