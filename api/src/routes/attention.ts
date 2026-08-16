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

export const attentionRouter = Router({ mergeParams: true });

const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;
const DUE_RE = /(renew|expir|due|refill|return|service|maintain|deadline)/i;
const WINDOW_DAYS = 30;
const INSTANCE_CAP = 15;
const ITEM_CAP = 200;

interface AttentionEntry {
  id: string;
  title: string;
  /** Kind-specific action payload: tasks carry {task}; bed-clear carries
   *  {connection_id, device_id} — enough for the client's inline actions. */
  action?: Record<string, string>;
}

interface AttentionRow {
  kind: "low_stock" | "overdue" | "upcoming" | "pending_scans" | "photo_wanted";
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
    const domain = (instances?.items ?? [])
      .filter((i) => !i.module_name.startsWith("core-"))
      .slice(0, INSTANCE_CAP);

    const now = Date.now();
    const horizon = now + WINDOW_DAYS * 86_400_000;

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

        // Low stock: real columns on inventory-family rows.
        const low = rowsOf.filter((r) => {
          const q = Number(r.qty), m = Number(r.min_qty);
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
              title: `${String(r.name ?? "item")} — ${Number(r.qty)} left (min ${Number(r.min_qty)})`,
            })),
          });
        }

        // Deadline-semantic date fields, from the tracker's own declarations.
        const dueFields = (defs?.items ?? []).filter(
          (d) => d.type === "date" && DUE_RE.test(`${d.name} ${d.display_label ?? ""}`),
        );
        if (dueFields.length === 0) return;
        const overdue: string[] = [];
        const upcoming: string[] = [];
        for (const r of rowsOf) {
          const meta = (r.metadata ?? {}) as Record<string, unknown>;
          for (const f of dueFields) {
            const raw = meta[f.name];
            if (typeof raw !== "string" || !raw) continue;
            const t = Date.parse(raw);
            if (!Number.isFinite(t)) continue;
            if (t < now) overdue.push(String(r.name ?? "item"));
            else if (t <= horizon) upcoming.push(String(r.name ?? "item"));
            break; // one signal per item is enough
          }
        }
        if (overdue.length > 0)
          rows.push({ kind: "overdue", label: `overdue in ${inst.display_name}`, count: overdue.length, sample: overdue.slice(0, 3), route });
        if (upcoming.length > 0)
          rows.push({ kind: "upcoming", label: `coming up in ${inst.display_name}`, count: upcoming.length, sample: upcoming.slice(0, 3), route });
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
      const overdueTasks = openTasks.filter((t) => Date.parse(t.due_date!) < now);
      const upcomingTasks = openTasks.filter((t) => {
        const ts = Date.parse(t.due_date!);
        return ts >= now && ts <= horizon;
      });
      const taskEntry = (t: { id?: string; title: string }) => ({ id: String(t.id ?? t.title), title: t.title, action: { task: String(t.id ?? "") } });
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
    const rank = { overdue: 0, low_stock: 1, photo_wanted: 2, pending_scans: 3, upcoming: 4 } as const;
    rows.sort((a, b) => rank[a.kind] - rank[b.kind] || b.count - a.count);
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});
