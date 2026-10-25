// /api/v1/orgs/:slug/modules/digifab/history — print history + at-a-glance stats.
//
// Read-only aggregate over digifab_jobs (the prints Cobblr sent + tracked to a
// terminal state). A summary (count, success rate, filament, hours) + the recent
// prints, over a window. Per-printer rollups so you can see which machine did
// what. No new storage — it's a read model on the jobs table.
//
// A machine finishing a print is not a good part (#7891). Success counts the
// bed-clear verdict: a completed print judged good. A scrapped one is counted
// apart, and one nobody has judged yet (or a cloud task with no verdict at all)
// is left out of the rate rather than guessed either way.

import { Router } from "express";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { tenantContext, tenantDb } from "../db.js";
import { asyncHandler } from "./util.js";

export const historyRouter = Router({ mergeParams: true });

const TERMINAL = ["completed", "failed", "cancelled"];
const n = (v: unknown) => (v == null ? 0 : Number(v));

/** Good parts over the attempts that have a verdict, as a whole percent; null with none. */
export function successRate(c: { total: number; good: number; unjudged: number }): number | null {
  const judged = c.total - c.unjudged;
  return judged > 0 ? Math.round((c.good / judged) * 100) : null;
}
const GOOD = sql<number>`count(*) filter (where status = 'completed' and outcome = 'good')`;
const SCRAPPED = sql<number>`count(*) filter (where status = 'completed' and outcome = 'scrap')`;
const PARTLY_SCRAPPED = sql<number>`count(*) filter (where status = 'completed' and outcome = 'good' and outcome_scrap_qty > 0)`;

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
    const orgId = tenantContext(req).org.id;
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
        GOOD.as("good"),
        SCRAPPED.as("scrapped"),
        PARTLY_SCRAPPED.as("partly_scrapped"),
        sql<number>`coalesce(sum((material_grams)::numeric) filter (where status = 'completed'), 0)`.as("filament_g"),
        sql<number>`coalesce(sum(extract(epoch from (updated_at - created_at))) filter (where status = 'completed'), 0)`.as("seconds"),
      ])
      .executeTakeFirst();

    // Daily buckets over the window — the analytics trend. digifab_jobs only here;
    // Bambu cloud tasks are folded in below (they aren't jobs rows).
    const seriesRows = await db
      .selectFrom("digifab_jobs")
      .where("status", "in", TERMINAL)
      .where("updated_at", ">", since)
      .select([
        sql<string>`to_char(date_trunc('day', updated_at), 'YYYY-MM-DD')`.as("day"),
        sql<number>`count(*) filter (where status = 'completed')`.as("completed"),
        sql<number>`count(*) filter (where status = 'failed')`.as("failed"),
        SCRAPPED.as("scrapped"),
        sql<number>`coalesce(sum((material_grams)::numeric) filter (where status = 'completed'), 0)`.as("filament_g"),
      ])
      .groupBy("day")
      .execute();

    // What the finished prints cost, by day and printer: a priced print adds its
    // cost, an unpriced one (no spool price, no grams) is counted, never as zero.
    const workspaceCurrency = await platform().money.currency(orgId);
    const costRows = await db
      .selectFrom("digifab_jobs")
      .where("status", "=", "completed")
      .where("updated_at", ">", since)
      .select([
        sql<string>`to_char(date_trunc('day', updated_at), 'YYYY-MM-DD')`.as("day"),
        "connection_id",
        "target_device",
        "cost_currency",
        sql<string | null>`sum(cost_amount)`.as("cost"),
        sql<number>`count(*) filter (where cost_amount is null)`.as("unpriced"),
      ])
      .groupBy(["day", "connection_id", "target_device", "cost_currency"])
      .execute();
    const money = async (parts: Array<{ amount: number; currency: string; day: string }>): Promise<number | null> => {
      if (!parts.length) return 0;
      if (parts.every((p) => p.currency === workspaceCurrency)) return parts.reduce((a, p) => a + p.amount, 0);
      const total = await platform().money.total(orgId, parts.map((p) => ({ value: { amount: p.amount, currency: p.currency }, day: p.day })), workspaceCurrency);
      return Object.keys(total.excluded).length ? null : total.amount;
    };
    const costParts = costRows.filter((r) => r.cost != null).map((r) => ({ amount: Number(r.cost), currency: r.cost_currency || workspaceCurrency, day: r.day, conn: r.connection_id, dev: r.target_device }));
    const round = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);

    // Device names: prefer the user's linked machine label, else the remote name.
    const links = await db
      .selectFrom("digifab_device_links")
      .select(["connection_id", "remote_device_id", "machine_label", "remote_device_name"])
      .execute();
    const nameOf = (connId: string | null, dev: string | null) => {
      const l = links.find((x) => x.connection_id === connId && x.remote_device_id === dev);
      return l?.machine_label || l?.remote_device_name || dev || "—";
    };
    const connections = new Map((await platform().devices.connections().list(orgId)).map((c) => [c.id, c.label]));

    const recent = await db
      .selectFrom("digifab_jobs")
      .where("status", "in", TERMINAL)
      .where("updated_at", ">", since)
      .select(["id", "file_ref", "metadata", "connection_id", "target_device", "status", "outcome", "outcome_good_qty", "outcome_scrap_qty", "material_grams", "cost_amount", "cost_currency", "created_at", "updated_at"])
      .orderBy("updated_at", "desc")
      // list-cap-ok: the latest 50 finished jobs are the feed; the rollups beside it count every job
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
        GOOD.as("good"),
        SCRAPPED.as("scrapped"),
        sql<number>`coalesce(sum((material_grams)::numeric) filter (where status = 'completed'), 0)`.as("filament_g"),
      ])
      .execute();

    // Bambu prints come from the cloud print-history (digifab_bambu_tasks) — far
    // richer than the MQTT-observed rows: model name (translated), cover thumbnail,
    // weight, duration. One row per cloud task; supersedes digifab_observed_prints
    // for Bambu (which the pump can no longer name well).
    type Item = { id: string; file_ref: string; metadata?: Record<string, unknown>; sub_label: string | null; cover: string | null; device: string; connection_id: string | null; device_id: string | null; status: string; outcome: "good" | "scrap" | null; good_qty: number | null; scrap_qty: number | null; filament_g: number | null; cost: number | null; cost_currency: string | null; at: string; duration_s: number };
    const taskRows = await db.selectFrom("digifab_bambu_tasks").select(["connection_id", "task_id", "raw", "captured_at"]).execute();
    const taskItems: Array<Item & { printer: { connection_id: string; device_id: string | null } }> = taskRows
      .map((t) => {
        const r = t.raw as Record<string, unknown>;
        const serial = (r.deviceId as string) || null;
        const name = (r.designTitleTranslated as string) || (r.designTitle as string) || (r.title as string) || "(print)";
        const at = r.endTime ? new Date(r.endTime as string).toISOString() : new Date(t.captured_at).toISOString();
        const dur = Number(r.costTime) || (r.startTime && r.endTime ? (new Date(r.endTime as string).getTime() - new Date(r.startTime as string).getTime()) / 1000 : 0);
        return {
          id: `task:${t.task_id}`,
          file_ref: name,
          sub_label: tidyProfile(r.title as string),
          cover: (r.cover as string) || null,
          device: (r.deviceName as string) || "—",
          connection_id: null,
          device_id: null,
          status: r.status === 3 ? "failed" : "completed",
          // A cloud task has no bed-clear verdict.
          outcome: null,
          good_qty: null,
          scrap_qty: null,
          filament_g: r.weight != null ? Number(r.weight) : null,
          // A cloud task names no spool, so it cannot be priced.
          cost: null,
          cost_currency: null,
          at,
          duration_s: dur,
          printer: { connection_id: t.connection_id, device_id: serial },
        };
      })
      .filter((t) => new Date(t.at) > since);
    const taskHours = taskItems.reduce((h, t) => h + t.duration_s / 3600, 0);

    // by-device: jobs + cloud tasks, one row per printer. A printer is its
    // connection and that manager's device id: names repeat across managers
    // (each calls its own printer "p1"), so a name never joins two (#8052).
    type DeviceRow = { name: string; connection_id: string | null; device_id: string | null; connection: string | null; total: number; completed: number; failed: number; good: number; scrapped: number; unjudged: number; success: number | null; filament_g: number; cost: number | null; unpriced: number };
    const byPrinter = new Map<string, DeviceRow>();
    const printerRow = (connId: string | null, dev: string | null, name: string): DeviceRow => {
      // A cloud task with no serial is known only by its name on that account.
      const key = JSON.stringify([connId, dev, dev ? null : name]);
      const e = byPrinter.get(key) ?? { name, connection_id: connId, device_id: dev, connection: (connId && connections.get(connId)) || null, total: 0, completed: 0, failed: 0, good: 0, scrapped: 0, unjudged: 0, success: null, filament_g: 0, cost: 0, unpriced: 0 };
      byPrinter.set(key, e);
      return e;
    };
    for (const r of byDeviceRows) {
      const e = printerRow(r.connection_id, r.target_device, nameOf(r.connection_id, r.target_device));
      e.total += n(r.total); e.completed += n(r.completed); e.failed += n(r.failed); e.filament_g += n(r.filament_g);
      e.good += n(r.good); e.scrapped += n(r.scrapped); e.unjudged += n(r.completed) - n(r.good) - n(r.scrapped);
    }
    for (const r of costRows) printerRow(r.connection_id, r.target_device, nameOf(r.connection_id, r.target_device)).unpriced += n(r.unpriced);
    const deviceCost = new Map<DeviceRow, Array<{ amount: number; currency: string; day: string }>>();
    for (const p of costParts) {
      const e = printerRow(p.conn, p.dev, nameOf(p.conn, p.dev));
      deviceCost.set(e, [...(deviceCost.get(e) ?? []), p]);
    }
    for (const e of byPrinter.values()) e.cost = deviceCost.has(e) ? round(await money(deviceCost.get(e)!)) : null;
    for (const t of taskItems) {
      const { connection_id: connId, device_id: serial } = t.printer;
      const e = printerRow(connId, serial, serial ? nameOf(connId, serial) : t.device);
      e.total += 1;
      if (t.status === "completed") { e.completed += 1; e.unjudged += 1; e.unpriced += 1; }
      if (t.status === "failed") e.failed += 1;
      e.filament_g += t.filament_g ?? 0;
    }
    for (const e of byPrinter.values()) e.success = successRate(e);

    // recent: union jobs + cloud tasks, newest first.
    const recentMerged: Item[] = [
      ...recent.map((r) => ({
        id: r.id,
        file_ref: r.file_ref,
        metadata: r.metadata,
        sub_label: null as string | null,
        cover: null as string | null,
        device: nameOf(r.connection_id, r.target_device),
        // Identity, so the cockpit can match "prints on THIS printer" by id
        // instead of display-name string equality (audit B2.6: renames + raw
        // device ids silently orphaned a printer's history).
        connection_id: r.connection_id,
        device_id: r.target_device,
        status: r.status,
        outcome: r.status === "completed" ? r.outcome : null,
        good_qty: r.outcome_good_qty,
        scrap_qty: r.outcome_scrap_qty,
        filament_g: r.material_grams == null ? null : Number(r.material_grams),
        cost: r.cost_amount == null ? null : round(Number(r.cost_amount)),
        cost_currency: r.cost_amount == null ? null : r.cost_currency || workspaceCurrency,
        at: new Date(r.updated_at).toISOString(),
        duration_s: Math.max(0, (new Date(r.updated_at).getTime() - new Date(r.created_at).getTime()) / 1000),
      })),
      ...taskItems.map(({ printer: _printer, ...t }) => t),
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);

    const taskCompleted = taskItems.filter((t) => t.status === "completed").length;
    const taskFailed = taskItems.filter((t) => t.status === "failed").length;
    const taskFilament = taskItems.reduce((g, t) => g + (t.filament_g ?? 0), 0);

    // Dense daily series (every day in the window, zero-filled) — jobs + tasks.
    const byDay = new Map<string, { completed: number; failed: number; scrapped: number; filament_g: number }>();
    for (const r of seriesRows) byDay.set(r.day, { completed: n(r.completed), failed: n(r.failed), scrapped: n(r.scrapped), filament_g: Math.round(n(r.filament_g)) });
    for (const t of taskItems) {
      const day = t.at.slice(0, 10);
      const e = byDay.get(day) ?? { completed: 0, failed: 0, scrapped: 0, filament_g: 0 };
      if (t.status === "completed") { e.completed += 1; e.filament_g += Math.round(t.filament_g ?? 0); }
      else if (t.status === "failed") e.failed += 1;
      byDay.set(day, e);
    }
    // `days` daily buckets ending TODAY (not `since`, which lands on yesterday —
    // today's prints are counted by the summary via `updated_at > since`, so the
    // trend must include today or the last bar visibly undercounts).
    const series: Array<{ date: string; completed: number; failed: number; scrapped: number; filament_g: number; cost: number | null }> = [];
    const startMs = Date.now() - (days - 1) * 86_400_000;
    for (let i = 0; i < days; i++) {
      const date = new Date(startMs + i * 86_400_000).toISOString().slice(0, 10);
      series.push({ date, ...(byDay.get(date) ?? { completed: 0, failed: 0, scrapped: 0, filament_g: 0 }), cost: round(await money(costParts.filter((p) => p.day === date))) });
    }
    const unpriced = costRows.reduce((a, r) => a + n(r.unpriced), 0) + taskCompleted;
    const total = n(summary?.total) + taskItems.length;
    const good = n(summary?.good);
    const scrapped = n(summary?.scrapped);
    // Completed with no verdict yet, and every cloud task (it never gets one).
    const unjudged = n(summary?.completed) - good - scrapped + taskCompleted;

    res.json({
      days,
      series,
      summary: {
        total,
        // `completed` is the machine finishing; `good` is what came out usable.
        completed: n(summary?.completed) + taskCompleted,
        good,
        scrapped,
        // Judged good with some of the plate scrapped ("9 good, 1 scrap").
        partly_scrapped: n(summary?.partly_scrapped),
        unjudged,
        success: successRate({ total, good, unjudged }),
        failed: n(summary?.failed) + taskFailed,
        cancelled: n(summary?.cancelled),
        filament_g: Math.round(n(summary?.filament_g) + taskFilament),
        hours: Math.round((n(summary?.seconds) / 3600 + taskHours) * 10) / 10,
        // What the priced prints cost, and how many finished prints could not be priced.
        cost: costParts.length ? round(await money(costParts)) : null,
        unpriced,
      },
      currency: workspaceCurrency,
      by_device: [...byPrinter.values()],
      recent: recentMerged,
    });
  }),
);
