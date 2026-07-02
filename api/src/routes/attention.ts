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

interface AttentionRow {
  kind: "low_stock" | "overdue" | "upcoming" | "pending_scans";
  label: string;
  count: number;
  /** Up to 3 item names, for the row's detail line. */
  sample: string[];
  route: string;
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

    // Severity order: overdue → low stock → pending scans → upcoming.
    const rank = { overdue: 0, low_stock: 1, pending_scans: 2, upcoming: 3 } as const;
    rows.sort((a, b) => rank[a.kind] - rank[b.kind] || b.count - a.count);
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});
