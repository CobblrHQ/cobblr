// POST /orgs/:slug/ravelry/import — pull the authed user's Ravelry stash +
// projects into this workspace's Yarn bundle (feedback a713b84c).
//
//   stash entry  → inventory:part in the `yarn` instance
//   project      → projects:project in the `designs` instance (if present)
//
// Idempotent: every imported Ravelry object is recorded in `ravelry_imports`
// (org + kind + ravelry_id → tenant entity id), so a re-run UPDATES the same
// row instead of duplicating. Maps from the paginated LIST payloads (fast, no
// N+1) — per-item detail enrichment (full fibre/length breakdown, photos) is a
// documented fast-follow in docs/design-decisions/ravelry-importer.md.

import { Router } from "express";
import type { Request } from "express";
import { sql, type Generated, type Kysely } from "kysely";
import { requireAuth } from "../auth/middleware.js";
import { withTenant } from "../middleware/tenant.js";
import { meta } from "../db/meta.js";
import { platform } from "@cobblr/platform-contract";
import { getInstance } from "../platform/instances.js";
import { stashAll, projectsAll, type RavelryStashEntry, type RavelryProject } from "../platform/ravelry.js";
import { loadRavelryConnection } from "./ravelry.js";

export const ravelryImportRouter = Router({ mergeParams: true });

// ─────────────────── the two tenant tables we write ───────────────────
// The api package's TenantDB only declares platform_local/migrations; the
// module tables live in the per-org DB. Declare the narrow slice we touch and
// cast req.tenant.db to it (the canonical create paths do the same).
interface InvPartRow {
  id: Generated<string>;
  instance: string;
  name: string;
  manufacturer: string | null;
  cost: string | null;
  qty: string;
  unit: string;
  notes: string | null;
  metadata: Record<string, unknown>;
}
interface ProjRow {
  id: Generated<string>;
  instance: string;
  name: string;
  status: string;
  description: string | null;
  start_date: Date | null;
  completion_date: Date | null;
  metadata: Record<string, unknown>;
}
interface ImportTenantDB {
  inventory_parts: InvPartRow;
  projects_projects: ProjRow;
}

function uid(req: Request): string {
  return (req as unknown as { session?: { id: string } }).session!.id;
}
function tdb(req: Request): Kysely<ImportTenantDB> {
  return (req as unknown as { tenant: { db: Kysely<ImportTenantDB> } }).tenant.db;
}
function orgId(req: Request): string {
  return (req as unknown as { tenant: { org: { id: string } } }).tenant.org.id;
}

// ─────────────────────────── field helpers ───────────────────────────
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = v.match(/[\d.]+/);
    if (m) return Number(m[0]);
  }
  return null;
};
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const YD_TO_M = 0.9144;

/** Ravelry yarn-weight name → the Yarn bundle's `weight_class` choice. */
function mapWeight(name: string | null): string | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (/cobweb|thread|lace/.test(n)) return "0 – Lace";
  if (/fingering|sock|baby/.test(n)) return "1 – Fingering";
  if (/sport/.test(n)) return "2 – Sport";
  if (/\bdk\b|double knit/.test(n)) return "3 – DK";
  if (/aran/.test(n)) return "4 – Aran";
  if (/worsted|afghan/.test(n)) return "4 – Worsted";
  if (/super bulky|super chunky|roving|jumbo/.test(n)) return "6 – Super Bulky";
  if (/bulky|chunky|craft|rug/.test(n)) return "5 – Bulky";
  return null;
}

/** Map a Ravelry stash entry → a yarn inventory part (name + metadata). */
function mapStash(e: RavelryStashEntry): {
  name: string;
  manufacturer: string | null;
  qty: string;
  notes: string | null;
  metadata: Record<string, unknown>;
} {
  const yarn = obj(e.yarn);
  const company = obj(yarn.yarn_company);
  const pack0 = obj((Array.isArray(e.packs) ? e.packs[0] : undefined) as unknown);

  const name =
    str(e.name) ?? str(e.yarn_name) ?? str(yarn.name) ?? str(e.colorway) ?? "Yarn";
  const manufacturer = str(e.yarn_company_name) ?? str(company.name) ?? null;

  // Length per skein in metres — prefer an explicit metres figure, else yards.
  const meters =
    num(pack0.meters_per_skein) ?? num(e.meters_per_skein) ?? num(yarn.meters_per_skein);
  const yards =
    num(pack0.yards_per_skein) ?? num(e.yards_per_skein) ?? num(yarn.yardage);
  const lengthPerSkein =
    meters ?? (yards != null ? Math.round(yards * YD_TO_M) : null);

  // Skeins: explicit pack count → quantity text → default 1.
  const skeins = num(pack0.skeins) ?? num(e.quantity_description) ?? 1;

  const weightName =
    str(obj(e.yarn_weight).name) ?? str(obj(yarn.yarn_weight).name) ?? str(e.yarn_weight);
  // First fibre, if the payload carries the breakdown.
  const fibers = Array.isArray(yarn.yarn_fibers) ? (yarn.yarn_fibers as unknown[]) : [];
  const fiber = fibers.length ? str(obj(obj(fibers[0]).fiber_type).name) : null;

  const metadata: Record<string, unknown> = {};
  const colorway = str(e.colorway);
  if (colorway) metadata.colorway = colorway;
  if (fiber) metadata.fiber = fiber;
  const weight = mapWeight(weightName);
  if (weight) metadata.weight_class = weight;
  if (lengthPerSkein != null) metadata.length_per_skein = lengthPerSkein;
  const dyeLot = str(e.dye_lot);
  if (dyeLot) metadata.dye_lot = dyeLot;
  const colorHex = str(e.color_family_id ? null : obj(e.colorways).color) ?? str(e.color);
  if (colorHex) metadata.color = colorHex.startsWith("#") ? colorHex : `#${colorHex}`;

  return {
    name: name.slice(0, 200),
    manufacturer: manufacturer?.slice(0, 120) ?? null,
    qty: String(skeins > 0 ? skeins : 1),
    notes: str(e.notes) ?? str(e.notes_html),
    metadata,
  };
}

/** Ravelry project status → projects status enum. */
function mapStatus(p: RavelryProject): string {
  const s = (str(p.status_name) ?? "").toLowerCase();
  if (str(p.completed) || /finish|complete/.test(s)) return "done";
  if (/hibernat/.test(s)) return "blocked";
  if (/frog/.test(s)) return "abandoned";
  if (/progress/.test(s)) return "active";
  return "active";
}

/** Map a Ravelry project → a design (projects:project). */
function mapProject(
  p: RavelryProject,
  username: string,
): {
  name: string;
  status: string;
  description: string | null;
  start_date: Date | null;
  completion_date: Date | null;
  metadata: Record<string, unknown>;
} {
  const permalink = str(p.permalink);
  const patternUrl = permalink
    ? `https://www.ravelry.com/projects/${encodeURIComponent(username)}/${permalink}`
    : null;
  const metadata: Record<string, unknown> = {};
  if (patternUrl) metadata.pattern_url = patternUrl;

  const date = (v: unknown): Date | null => {
    const s = str(v);
    if (!s) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  return {
    name: (str(p.name) ?? "Project").slice(0, 200),
    status: mapStatus(p),
    description: str(p.notes) ?? str(p.notes_html),
    start_date: date(p.started) ?? date(p.started_day),
    completion_date: date(p.completed) ?? date(p.completed_day),
    metadata,
  };
}

// Test-only re-exports for src/scripts/test-ravelry-mapping.ts — a read-only
// real-data smoke test of the field mapping (a713b84c). Not used by the route.
export { mapStash as mapStashForTest, mapProject as mapProjectForTest };

// ─────────────────────────── the import route ───────────────────────────
ravelryImportRouter.post("/ravelry/import", requireAuth, withTenant, async (req, res, next) => {
  try {
    const conn = await loadRavelryConnection(uid(req));
    if (!conn) {
      res.status(400).json({
        error: { code: "not_connected", message: "Connect your Ravelry account first (Settings → Ravelry)." },
      });
      return;
    }
    const org = orgId(req);
    const db = tdb(req);

    // The Yarn bundle provisions a "yarn" inventory instance + an optional
    // "designs" projects instance; we key off the instance NAMES it creates
    // (not module-name literals — the kernel must not hardcode those). Absent
    // the yarn instance, the bundle isn't installed here.
    const yarnInstance = await getInstance(org, "yarn");
    if (!yarnInstance) {
      res.status(400).json({
        error: { code: "no_yarn_instance", message: "Install the Yarn bundle in this workspace first." },
      });
      return;
    }
    const designsInstance = await getInstance(org, "designs");
    const importDesigns = !!designsInstance;

    const result = { stash: { created: 0, updated: 0 }, designs: { created: 0, updated: 0 }, errors: 0 };

    // ── stash → yarn ──────────────────────────────────────────────
    for await (const entry of stashAll(conn.creds, conn.username)) {
      const ravelryId = String(entry.id);
      try {
        const m = mapStash(entry);
        const existing = await meta
          .selectFrom("ravelry_imports")
          .select("entity_id")
          .where("org_id", "=", org)
          .where("kind", "=", "stash")
          .where("ravelry_id", "=", ravelryId)
          .executeTakeFirst();
        if (existing) {
          await db
            .updateTable("inventory_parts")
            .set({
              name: m.name,
              manufacturer: m.manufacturer,
              qty: m.qty,
              notes: m.notes,
              metadata: sql`${JSON.stringify(m.metadata)}::jsonb` as never,
            })
            .where("id", "=", existing.entity_id)
            .execute();
          await meta
            .updateTable("ravelry_imports")
            .set({ updated_at: new Date() })
            .where("org_id", "=", org)
            .where("kind", "=", "stash")
            .where("ravelry_id", "=", ravelryId)
            .execute();
          result.stash.updated++;
        } else {
          const ins = await db
            .insertInto("inventory_parts")
            .values({
              instance: "yarn",
              name: m.name,
              manufacturer: m.manufacturer,
              qty: m.qty,
              unit: yarnInstance.config?.qty_unit ? String(yarnInstance.config.qty_unit) : "skein",
              notes: m.notes,
              cost: null,
              metadata: sql`${JSON.stringify(m.metadata)}::jsonb` as never,
            })
            .returning(["id"])
            .executeTakeFirstOrThrow();
          await meta
            .insertInto("ravelry_imports")
            .values({ org_id: org, kind: "stash", ravelry_id: ravelryId, instance: "yarn", entity_id: ins.id })
            .execute();
          platform().events.emit("inventory.part.created", { orgId: org, partId: ins.id });
          result.stash.created++;
        }
      } catch (e) {
        console.error(`[ravelry] stash ${ravelryId} import failed:`, (e as Error).message);
        result.errors++;
      }
    }

    // ── projects → designs (only if the Designs feature is on) ─────
    if (importDesigns) {
      for await (const proj of projectsAll(conn.creds, conn.username)) {
        const ravelryId = String(proj.id);
        try {
          const m = mapProject(proj, conn.username);
          const existing = await meta
            .selectFrom("ravelry_imports")
            .select("entity_id")
            .where("org_id", "=", org)
            .where("kind", "=", "project")
            .where("ravelry_id", "=", ravelryId)
            .executeTakeFirst();
          if (existing) {
            await db
              .updateTable("projects_projects")
              .set({
                name: m.name,
                status: m.status,
                description: m.description,
                start_date: m.start_date,
                completion_date: m.completion_date,
                metadata: sql`${JSON.stringify(m.metadata)}::jsonb` as never,
              })
              .where("id", "=", existing.entity_id)
              .execute();
            await meta
              .updateTable("ravelry_imports")
              .set({ updated_at: new Date() })
              .where("org_id", "=", org)
              .where("kind", "=", "project")
              .where("ravelry_id", "=", ravelryId)
              .execute();
            result.designs.updated++;
          } else {
            const ins = await db
              .insertInto("projects_projects")
              .values({
                instance: "designs",
                name: m.name,
                status: m.status,
                description: m.description,
                start_date: m.start_date,
                completion_date: m.completion_date,
                metadata: sql`${JSON.stringify(m.metadata)}::jsonb` as never,
              })
              .returning(["id"])
              .executeTakeFirstOrThrow();
            await meta
              .insertInto("ravelry_imports")
              .values({ org_id: org, kind: "project", ravelry_id: ravelryId, instance: "designs", entity_id: ins.id })
              .execute();
            platform().events.emit("projects.project.created", { orgId: org, projectId: ins.id });
            result.designs.created++;
          }
        } catch (e) {
          console.error(`[ravelry] project ${ravelryId} import failed:`, (e as Error).message);
          result.errors++;
        }
      }
    }

    res.json({ ok: true, designs_imported: importDesigns, ...result });
  } catch (err) {
    next(err);
  }
});
