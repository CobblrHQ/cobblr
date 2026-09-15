// GET /orgs/:slug/attention — the dashboard's "what needs me" feed (redesign
// B2). Derived ENTIRELY from field semantics the workspace's trackers already
// declare (derive-from-fields, zero per-bundle code):
//
//   · low stock     — inventory-family items where qty ≤ min_qty
//   · overdue/due   — any tracker whose field defs include a date field whose
//                     name/label reads like a deadline (renew/expire/due/
//                     refill/return/service/maintain); items with that date
//                     overdue or within the next 30 days
//   · pending scans — the capture inbox
//
// Aggregates over the SAME public per-module HTTP endpoints the web client
// uses (quickstart.ts precedent) — the host never reaches into module tables.
// Small workspaces by design: caps at 15 instances × 200 items; the client
// caches for 30s.
import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { facesForKind } from "../platform/faces.js";
import { resolveKind } from "../platform/entities.js";
import { hasPrimaryRouter } from "../modules/mount.js";
import { viewQuery } from "@cobblr/platform-contract";
import { dueState, todayFrom } from "../lib/due-day.js";

export const attentionRouter = Router({ mergeParams: true });

const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
const DUE_RE = /(renew|expir|due|refill|return|service|maintain|deadline)/i;
const WINDOW_DAYS = 30;
const INSTANCE_CAP = 15;
const ITEM_CAP = 200;

/** The instances whose items this feed reads: domain modules only, and only
 *  those that answer an items request. A module with no primary router
 *  (`lists`, `digifab`, the hosted overlay) has a default instance like any
 *  other, and asking it is a 501 over loopback per instance per poll, which
 *  the error counter read as failures (#3044). Decided here, in process. */
export function instancesToAsk<T extends { module_name: string }>(rows: T[], answersItems: (moduleName: string) => boolean): T[] {
  return rows.filter((i) => !i.module_name.startsWith("core-") && answersItems(i.module_name));
}

interface AttentionEntry {
  id: string;
  title: string;
  /** Kind-specific action payload: tasks carry {task}; bed-clear carries
   *  {connection_id, device_id} — enough for the client's inline actions. */
  action?: Record<string, string>;
  /** The record the entry is about, by the kind the registry names it (a
   *  named instance's own `<name>:item`; the default instance's records are
   *  the module's kind, `inventory:part`) and its bare name. This is what
   *  lets an answer built from the feed open the thing it names: "what is
   *  low?" named Cumin in plain text with nothing to open when the feed
   *  carried titles only (2026-09-13). Absent for a capture or a device. */
  record?: { kind: string; id: string; name: string };
}

interface AttentionRow {
  kind: "low_stock" | "overdue" | "due_today" | "upcoming" | "pending_scans" | "photo_wanted";
  label: string;
  count: number;
  /** Up to 3 item names, for the row's detail line. */
  sample: string[];
  route: string;
  /** Up to 8 individual items for the row's inline expansion (act-in-place). */
  entries?: AttentionEntry[];
}

async function j<T>(path: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(`${INTERNAL_API}/api/v1${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

attentionRouter.get("/", requireAuth, withTenant, async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const rows: AttentionRow[] = [];

    // Pending captures first — always actionable.
    const inbox = await j<{ items: Array<{ id: string }> }>(
      `/orgs/${slug}/modules/core-scan/inbox?status=pending`,
      token,
    );
    if (inbox && inbox.items.length > 0) {
      rows.push({
        kind: "pending_scans",
        label: "captures waiting to be filed",
        count: inbox.items.length,
        sample: [],
        route: "/scan",
      });
    }

    // "I'll photograph this" — marks a person set at a desk, surfaced where they
    // will next be holding a phone. Reads the SAME facet the scanner's prompt
    // does (platform-contract/scan-triage), so the dashboard and the viewfinder
    // can never disagree about what is waiting. `total` rather than the page
    // length, or the count would silently cap at the entry limit.
    const wantPhoto = await j<{
      items: Array<{ id: string; suggested_name: string | null }>;
      total?: number;
    }>(`/orgs/${slug}/modules/core-scan/inbox?triage=photo_wanted&limit=8`, token);
    if (wantPhoto && wantPhoto.items.length > 0) {
      const name = (i: { suggested_name: string | null }) => i.suggested_name?.trim() || "an unnamed capture";
      rows.push({
        kind: "photo_wanted",
        label: `waiting for a photo from you`,
        count: wantPhoto.total ?? wantPhoto.items.length,
        sample: wantPhoto.items.slice(0, 3).map(name),
        route: "/scan",
        // Each entry deep-links the camera straight at that item, which is the
        // whole point: the row exists so nobody scrolls an inbox on a phone.
        entries: wantPhoto.items.slice(0, 8).map((i) => ({
          id: i.id,
          title: name(i),
          action: { want: i.id },
        })),
      });
    }

    const instances = await j<{
      items: Array<{ module_name: string; instance_name: string; display_name: string; is_default: boolean }>;
    }>(`/orgs/${slug}/instances`, token);
    const domain = instancesToAsk(instances?.items ?? [], hasPrimaryRouter).slice(0, INSTANCE_CAP);

    const now = Date.now();
    // By DAY, the way the schedule beside this feed reads a date, and on the
    // client's day when it says (?today=YYYY-MM-DD). A date is midnight, so a
    // clock comparison called anything due today overdue from 00:01 and the
    // headline said "6 overdue" over a schedule that said 5 and 1 today.
    const today = todayFrom(req.query.today);

    await Promise.all(
      domain.map(async (inst) => {
        const [defs, items] = await Promise.all([
          j<{ items: Array<{ name: string; type: string; display_label?: string }> }>(
            `/orgs/${slug}/field-defs?kind=${encodeURIComponent(`${inst.instance_name}:item`)}&effective=1`,
            token,
          ),
          j<{ items: Array<Record<string, unknown>> }>(
            `/orgs/${slug}/instances/${encodeURIComponent(inst.instance_name)}/items?limit=${ITEM_CAP}`,
            token,
          ),
        ]);
        const rowsOf = items?.items ?? [];
        if (rowsOf.length === 0) return;
        const route = inst.is_default ? `/${inst.module_name}` : `/instances/${inst.instance_name}`;
        // The kind a chip can open: the named instance's own, or for the
        // default instance the module's primary kind (the registry has no
        // `inventory:item`; its records are `inventory:part`).
        const recordKind = inst.is_default
          ? (await resolveKind(req.tenant!.org.id, `${inst.instance_name}:item`).catch(() => ({ base: `${inst.instance_name}:item` }))).base
          : `${inst.instance_name}:item`;
        const recordOf = (id: string, name: string) => ({ kind: recordKind, id, name });

        // Low stock: real columns on inventory-family rows, compared on what
        // is on hand (the list derives it: unopened count plus every open
        // unit still holding something), so an open skein with metres left
        // is not "out".
        const onHandOf = (r: Record<string, unknown>) => Number(r.on_hand ?? r.qty);
        const low = rowsOf.filter((r) => {
          const q = onHandOf(r), m = Number(r.min_qty);
          return Number.isFinite(q) && Number.isFinite(m) && r.min_qty !== null && q <= m;
        });
        if (low.length > 0) {
          rows.push({
            kind: "low_stock",
            label: `low in ${inst.display_name}`,
            count: low.length,
            sample: low.slice(0, 3).map((r) => String(r.name ?? "item")),
            route,
            entries: low.slice(0, 8).map((r) => ({
              id: String(r.id ?? r.name ?? "item"),
              title: `${String(r.name ?? "item")} — ${onHandOf(r)} left (min ${Number(r.min_qty)})`,
              ...(r.id ? { record: recordOf(String(r.id), String(r.name ?? "item")) } : {}),
            })),
          });
        }

        // Deadline-semantic date fields, from the tracker's own declarations.
        const dueFields = (defs?.items ?? []).filter(
          (d) => d.type === "date" && DUE_RE.test(`${d.name} ${d.display_label ?? ""}`),
        );
        if (dueFields.length === 0) return;
        // A stock-face record with nothing on hand has nothing left to date:
        // exhausted milk is not overdue, it is gone (the calendar and the
        // expiry sweeper apply the same rule through the kernel's date query).
        let stockFace = false;
        try {
          stockFace = (await facesForKind(req.tenant!.org.id, `${inst.instance_name}:item`)).faces.includes("stock");
        } catch {
          stockFace = false;
        }
        type Dated = { id: string; name: string; when: number; field: string };
        const overdue: Dated[] = [];
        const dueToday: Dated[] = [];
        const upcoming: Dated[] = [];
        for (const r of rowsOf) {
          if (stockFace && r.qty != null && Number(r.qty) <= 0) continue;
          const meta = (r.metadata ?? {}) as Record<string, unknown>;
          for (const f of dueFields) {
            const raw = meta[f.name];
            if (typeof raw !== "string" || !raw) continue;
            const t = Date.parse(raw);
            if (!Number.isFinite(t)) continue;
            const dated = { id: String(r.id ?? r.name ?? "item"), name: String(r.name ?? "item"), when: t, field: f.name };
            // By calendar day, the way the schedule reads it: due today is
            // today, never overdue (due-day.ts).
            const state = dueState(raw, today, WINDOW_DAYS);
            if (state === "none") continue;
            if (state === "overdue") overdue.push(dated);
            else if (state === "today") dueToday.push(dated);
            else if (state === "upcoming") upcoming.push(dated);
            break; // one signal per item is enough
          }
        }
        // The alert should land on the rows it counted, in the order that
        // matters. A saved view on this collection that ORDERS by one of its
        // due fields ("Use it or lose it", soonest first) is that landing, so
        // the row's route opens it; otherwise the bare table. The reviewer's
        // arrow used to open the whole grocery table with nothing selected
        // and the overdue rows to be found again by hand (2026-09-12).
        const dueNames = new Set(dueFields.map((f) => f.name));
        const views = await j<{ items: Array<{ id: string; config?: Record<string, unknown> }> }>(
          `/orgs/${slug}/modules/core-views/views?kind=${encodeURIComponent(`${inst.instance_name}:item`)}`,
          token,
        );
        const dueView = (views?.items ?? []).find((v) =>
          (viewQuery(v.config).sort ?? []).some((spec) => dueNames.has(spec.replace(/^-/, ""))),
        );
        const dueRoute = dueView ? `${route}?view=${encodeURIComponent(dueView.id)}` : route;
        const ago = (t: number) => {
          const d = Math.round((now - t) / 86_400_000);
          return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d}d ago`;
        };
        const ahead = (t: number) => {
          const d = Math.round((t - now) / 86_400_000);
          return d <= 0 ? "today" : d === 1 ? "tomorrow" : `in ${d}d`;
        };
        // Soonest first, both lists: the most overdue leads, the nearest
        // upcoming leads.
        overdue.sort((a, b) => a.when - b.when);
        upcoming.sort((a, b) => a.when - b.when);
        const kind = `${inst.instance_name}:item`;
        if (overdue.length > 0)
          rows.push({
            kind: "overdue",
            label: `overdue in ${inst.display_name}`,
            count: overdue.length,
            sample: overdue.slice(0, 3).map((d) => d.name),
            route: dueRoute,
            entries: overdue.slice(0, 8).map((d) => ({ id: d.id, title: `${d.name} — ${ago(d.when)}`, action: { record: d.id, kind }, record: recordOf(d.id, d.name) })),
          });
        if (dueToday.length > 0)
          rows.push({
            kind: "due_today",
            label: `due today in ${inst.display_name}`,
            count: dueToday.length,
            sample: dueToday.slice(0, 3).map((d) => d.name),
            route: dueRoute,
            entries: dueToday.slice(0, 8).map((d) => ({ id: d.id, title: `${d.name} — today`, action: { record: d.id, kind }, record: recordOf(d.id, d.name) })),
          });
        if (upcoming.length > 0)
          rows.push({
            kind: "upcoming",
            label: `coming up in ${inst.display_name}`,
            count: upcoming.length,
            sample: upcoming.slice(0, 3).map((d) => d.name),
            route: dueRoute,
            entries: upcoming.slice(0, 8).map((d) => ({ id: d.id, title: `${d.name} — ${ahead(d.when)}`, action: { record: d.id, kind }, record: recordOf(d.id, d.name) })),
          });
      }),
    );

    // NATIVE-column deadlines the field-semantics sweep can't see: projects
    // tasks keep due_date as a real column (not instance-item metadata), so
    // the classic "overdue to-do" never surfaced here (found seeding a demo
    // workspace — two overdue tasks, zero attention rows). 404s harmlessly
    // when the projects module is off (j() → null).
    const tasks = await j<{ items: Array<{ id: string; title: string; status: string; due_date: string | null }> }>(
      `/orgs/${slug}/modules/projects/tasks?limit=${ITEM_CAP}`,
      token,
    );
    if (tasks) {
      const openTasks = tasks.items.filter(
        (t) => t.due_date && !["done", "cancelled"].includes(t.status),
      );
      const overdueTasks = openTasks.filter((t) => dueState(t.due_date, today, WINDOW_DAYS) === "overdue");
      const upcomingTasks = openTasks.filter((t) => ["today", "upcoming"].includes(dueState(t.due_date, today, WINDOW_DAYS)));
      const taskEntry = (t: { id?: string; title: string }) => ({
        id: String(t.id ?? t.title),
        title: t.title,
        action: { task: String(t.id ?? "") },
        ...(t.id ? { record: { kind: "projects:task", id: String(t.id), name: t.title } } : {}),
      });
      if (overdueTasks.length > 0)
        rows.push({
          kind: "overdue",
          label: `overdue ${overdueTasks.length === 1 ? "task" : "tasks"}`,
          count: overdueTasks.length,
          sample: overdueTasks.slice(0, 3).map((t) => t.title),
          route: "/projects",
          entries: overdueTasks.slice(0, 8).map(taskEntry),
        });
      if (upcomingTasks.length > 0)
        rows.push({
          kind: "upcoming",
          label: `${upcomingTasks.length === 1 ? "task" : "tasks"} due soon`,
          count: upcomingTasks.length,
          sample: upcomingTasks.slice(0, 3).map((t) => t.title),
          route: "/projects",
          entries: upcomingTasks.slice(0, 8).map(taskEntry),
        });
    }

    // Digifab (prototype, the author sign-off pending): printers holding a finished
    // plate for the bed-clear verdict + recent failed prints. Both read
    // digifab's own endpoints (fleet serves its SWR snapshot — instant); 404
    // harmlessly when the module is off.
    const fleet = await j<{ connections: Array<{ connection_id: string; devices: Array<{ id: string; name: string; needs_attention: { reason: string } | null }> }> }>(
      `/orgs/${slug}/modules/digifab/fleet`,
      token,
    );
    if (fleet) {
      const waiting = fleet.connections.flatMap((c) => c.devices.map((d) => ({ ...d, conn: c.connection_id }))).filter((d) => d.needs_attention);
      if (waiting.length > 0)
        rows.push({
          kind: "overdue",
          label: `printer${waiting.length === 1 ? "" : "s"} waiting for a bed-clear verdict`,
          count: waiting.length,
          sample: waiting.slice(0, 3).map((d) => d.name),
          route: "/digifab",
          entries: waiting.slice(0, 8).map((d) => ({ id: `${d.conn}:${d.id}`, title: d.name, action: { connection_id: d.conn, device_id: d.id } })),
        });
    }
    const failed = await j<{ items: Array<{ file_ref: string; updated_at: string }> }>(
      `/orgs/${slug}/modules/digifab/jobs?status=failed&limit=25`,
      token,
    );
    if (failed) {
      const recent = failed.items.filter((f) => Date.parse(f.updated_at) > now - 7 * 86_400_000);
      if (recent.length > 0)
        rows.push({
          kind: "overdue",
          label: `failed print${recent.length === 1 ? "" : "s"} this week`,
          count: recent.length,
          sample: recent.slice(0, 3).map((f) => f.file_ref),
          route: "/digifab",
        });
    }

    // Severity order: overdue → low stock → pending scans → upcoming.
    const rank = { overdue: 0, due_today: 1, low_stock: 2, photo_wanted: 3, pending_scans: 4, upcoming: 5 } as const;
    rows.sort((a, b) => rank[a.kind] - rank[b.kind] || b.count - a.count);
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});
