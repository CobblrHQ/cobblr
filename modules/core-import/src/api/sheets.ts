// Bring your spreadsheet: read an uploaded workbook or a Google Sheets link
// and say what it holds, before anything is written.
//
//   POST /sheets/understand  { file_b64, filename } | { url }  — never writes
//   POST /sheets/plan        the same, plus { overrides }       — never writes:
//                            where each sheet goes, what each column becomes,
//                            and what would happen to every row
//   POST /sheets/import      the same body: carries the plan out, as one run
//   GET  /sheets/imports     the recent runs
//   GET  /sheets/imports/:id one run: progress, what happened, what undo did
//   POST /sheets/imports/:id/undo { force? }  take the run back
//
// A link is fetched through the workspace's egress policy: it is an address a
// person typed, so it gets the same guard as a webhook or a sync connector.

import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { FieldTypeSchema, platform } from "@cobblr/platform-contract";
import { requireRole } from "./util.js";
import type { ImportDb } from "../db.js";
import { ImportRefused, Ledger, prepareRun, SHEET_IMPORT_QUEUE, undoRun } from "../services/sheet-import.js";
import { locationPaths } from "../services/sheet-plan.js";
import { fetchSheetsLink, formatOf, readWorkbook, SheetReadError, MAX_FILE_BYTES } from "../services/sheet-read.js";
import { understandWorkbook, type UnderstoodSheet } from "../services/sheet-understand.js";
import { planSheet, scoreTargets, chooseTarget, type Destination, type SheetOverrides, type SheetPlan } from "../services/sheet-plan.js";
import { existingRecords, newCollectionTarget, workspacePicture } from "../services/sheet-workspace.js";
import { nameColumnsWithAi } from "../services/sheet-ai-names.js";

export const sheetsRouter = Router({ mergeParams: true });

const INTERNAL_API = `http://127.0.0.1:${process.env.API_PORT || 4000}`;

/** Rows shown back with the understanding; the whole sheet is re-read for
 *  the dry run and the import, never carried between requests. */
const PREVIEW_ROWS = 25;

const Source = z.union([
  z.object({
    file_b64: z.string().min(1).max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4),
    filename: z.string().min(1).max(255),
    locale: z.string().max(35).optional(),
  }),
  z.object({ url: z.string().url().max(2048), locale: z.string().max(35).optional() }),
]);
const Body = Source;

const DestinationSchema: z.ZodType<Destination> = z.union([
  z.object({ to: z.enum(["name", "quantity", "location", "category", "tags", "photo", "disposition", "skip"]) }), // VOCAB-ENUMERATION OK: the destinations sheet-plan declares
  z.object({ to: z.literal("field"), field: z.string().min(1).max(80), label: z.string().max(160), native: z.boolean() }),
  z.object({
    to: z.literal("new-field"),
    field: z.string().regex(/^[a-z][a-z0-9_]*$/).max(64),
    label: z.string().min(1).max(160),
    // A spreadsheet column makes a plain field; a formula, a link to a record
    // or a person is not something a column of values can be.
    type: FieldTypeSchema.exclude(["computed", "relation", "member", "richtext"]),
    choices: z.array(z.string().max(200)).max(500).optional(),
    unit: z.string().max(20).nullable().optional(),
    field_role: z.string().max(40).nullable().optional(),
  }),
]) as z.ZodType<Destination>;

const OverridesSchema = z
  .record(
    z.string().max(200),
    z.object({
      include: z.boolean().optional(),
      target: z.string().max(200).optional(),
      columns: z.record(z.string().regex(/^\d+$/), DestinationSchema).optional(),
      skip_rows: z.array(z.number().int().positive()).max(20_000).optional(),
      collection_label: z.string().max(80).optional(),
      only_owned: z.boolean().optional(),
      keep_identical_apart: z.boolean().optional(),
    }),
  )
  .optional();

const PlanBody = z.intersection(Source, z.object({ overrides: OverridesSchema }));

function bearerOf(req: Request): string {
  const a = req.headers.authorization;
  return typeof a === "string" && a.startsWith("Bearer ") ? a.slice(7) : "";
}

function slugOf(req: Request): string {
  return String((req.params as { slug?: string }).slug ?? "");
}

function roleOf(req: Request): string {
  return (req as unknown as { tenant?: { role?: string } }).tenant?.role ?? "";
}

function tenantDbOf(req: Request): ImportDb {
  const t = (req as unknown as { tenant?: { db: unknown } }).tenant;
  if (!t) throw new Error("core-import route called without tenant context");
  return t.db as ImportDb;
}

function userIdOf(req: Request): string | null {
  return (req as unknown as { session?: { id?: string } }).session?.id ?? null;
}

function orgIdOf(req: Request): string {
  return (req as unknown as { tenant?: { org: { id: string } } }).tenant?.org.id ?? "";
}

export interface SheetsUnderstanding {
  source: "file" | "link";
  filename: string;
  sheets: Array<Omit<UnderstoodSheet, "rows"> & { row_count: number; preview: UnderstoodSheet["rows"] }>;
}

async function readUpload(
  input: z.infer<typeof Source>,
  orgId: string,
  acceptLanguage: string | undefined,
): Promise<{ source: "file" | "link"; filename: string; sheets: UnderstoodSheet[] }> {
  let buf: Uint8Array;
  let filename: string;
  let source: "file" | "link";
  if ("url" in input) {
    ({ buf, filename } = await fetchSheetsLink(input.url, (url) => platform().egress.guardedFetch(orgId, url)));
    source = "link";
  } else {
    buf = new Uint8Array(Buffer.from(input.file_b64, "base64"));
    filename = input.filename;
    source = "file";
  }
  const locale = input.locale ?? acceptLanguage?.split(",")[0]?.trim();
  return { source, filename, sheets: understandWorkbook(readWorkbook(buf, filename), { locale }) };
}

export async function understandUpload(
  input: z.infer<typeof Source>,
  orgId: string,
  acceptLanguage: string | undefined,
): Promise<SheetsUnderstanding> {
  const { source, filename, sheets } = await readUpload(input, orgId, acceptLanguage);
  return {
    source,
    filename,
    sheets: sheets.map(({ rows, ...s }) => ({ ...s, row_count: rows.length, preview: rows.slice(0, PREVIEW_ROWS) })),
  };
}

/** Rows shown back with a plan: the first ones, then every row that would
 *  change something already there or has a problem, up to the cap. The counts
 *  always cover the whole sheet. */
const PLAN_ROWS = 50;
const PLAN_ATTENTION_ROWS = 300;

/** A plan as the route returns it: `records` holds the rows shown, and
 *  `row_count` how many rows of the sheet they are. */
export type ShownPlan = SheetPlan & {
  row_count: number;
  records_shown: "all" | "some";
};

export interface SheetsPlan {
  source: "file" | "link";
  filename: string;
  your_role: string;
  sheets: ShownPlan[];
}

interface PlanCtx {
  orgId: string;
  userId?: string | null;
  slug: string;
  token: string;
  role: string;
  acceptLanguage: string | undefined;
}

/** Every sheet's whole plan, and the workspace it was made against: what the
 *  dry run shows and what an import carries out come from this one call. */
async function buildPlans(input: z.infer<typeof PlanBody>, ctx: PlanCtx) {
  const { source, filename, sheets } = await readUpload(input, ctx.orgId, ctx.acceptLanguage);
  // Heuristics first: only a sheet with no header row, and only the columns
  // its values could not name, are shown to a model (a few rows, one call).
  for (const sheet of sheets) {
    if (!sheet.headerless) continue;
    await nameColumnsWithAi(sheet, async (prompt) => {
      const r = await platform().ai.invoke({
        orgId: ctx.orgId,
        capability: "chat",
        input: { messages: [{ role: "user", content: prompt }] },
        source: { kind: "core-import:sheet-columns", id: filename },
        userId: ctx.userId ?? null,
      });
      return r.text ?? null;
    });
  }
  const picture = await workspacePicture(ctx.orgId, ctx.token ? { base: INTERNAL_API, slug: ctx.slug, token: ctx.token } : null);
  const plans: SheetPlan[] = [];
  for (const sheet of sheets) {
    const raw = input.overrides?.[sheet.name];
    const overrides: SheetOverrides = {
      ...(raw?.include !== undefined ? { include: raw.include } : {}),
      ...(raw?.target ? { target: raw.target } : {}),
      ...(raw?.columns ? { columns: Object.fromEntries(Object.entries(raw.columns).map(([k, v]) => [Number(k), v])) } : {}),
      ...(raw?.skip_rows ? { skip_rows: raw.skip_rows } : {}),
      ...(raw?.collection_label ? { collection_label: raw.collection_label } : {}),
      ...(raw?.only_owned ? { only_owned: true } : {}),
      ...(raw?.keep_identical_apart ? { keep_identical_apart: true } : {}),
    };
    const fresh = newCollectionTarget(sheet.name, picture.targets);
    const targets = fresh ? [...picture.targets, fresh] : picture.targets;
    const scores = scoreTargets(sheet, filename, targets);
    const chosen = (overrides.target ? scores.find((s) => s.target.id === overrides.target) : undefined) ?? chooseTarget(scores);
    const existing = chosen.target.status === "existing" ? await existingRecords(ctx.orgId, chosen.target.kind, { userId: ctx.userId ?? undefined, role: ctx.role ?? undefined }) : [];
    plans.push(planSheet({ sheet, filename, targets, locations: picture.locations, existing, overrides, scores }));
  }
  return { source, filename, plans, picture };
}

export async function planUpload(input: z.infer<typeof PlanBody>, ctx: PlanCtx): Promise<SheetsPlan> {
  const { source, filename, plans } = await buildPlans(input, ctx);
  return {
    source,
    filename,
    your_role: ctx.role,
    sheets: plans.map((plan) => {
      const firsts = plan.records.slice(0, PLAN_ROWS);
      const attention = plan.records.slice(PLAN_ROWS).filter((r) => r.action === "update" || r.problems.length).slice(0, PLAN_ATTENTION_ROWS);
      const shown = [...firsts, ...attention];
      // Rows of the sheet, so a record standing for four identical rows is four.
      const rowCount = plan.records.reduce((n, r) => n + (r.rows?.length ?? 1), 0);
      return { ...plan, row_count: rowCount, records: shown, records_shown: shown.length === plan.records.length ? "all" : "some" };
    }),
  };
}

// AI-REACH: exempt reads a file a person uploads in the import sheet; an assistant holds no file to send
sheetsRouter.post("/sheets/understand", (req, res, next) => {
  void (async () => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_body", message: "expected { file_b64, filename } or { url }", details: parsed.error.issues } });
      return;
    }
    if ("filename" in parsed.data && !formatOf(parsed.data.filename)) {
      res.status(400).json({ error: { code: "unsupported", message: "That file isn't a spreadsheet. Use .xlsx, .xls, .ods, .csv or .tsv." } });
      return;
    }
    try {
      res.json(await understandUpload(parsed.data, orgIdOf(req), req.headers["accept-language"]));
    } catch (err) {
      if (err instanceof SheetReadError) {
        res.status(err.code === "too-big" ? 413 : 400).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  })().catch(next);
});

// AI-REACH: exempt previews an import of a file a person uploads in the import sheet; an assistant holds no file to send
sheetsRouter.post("/sheets/plan", (req, res, next) => {
  void (async () => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PlanBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_body", message: "expected { file_b64, filename } or { url }, with optional overrides", details: parsed.error.issues } });
      return;
    }
    if ("filename" in parsed.data && !formatOf(parsed.data.filename)) {
      res.status(400).json({ error: { code: "unsupported", message: "That file isn't a spreadsheet. Use .xlsx, .xls, .ods, .csv or .tsv." } });
      return;
    }
    try {
      res.json(
        await planUpload(parsed.data, {
          orgId: orgIdOf(req),
          userId: userIdOf(req),
          slug: slugOf(req),
          token: bearerOf(req),
          role: roleOf(req),
          acceptLanguage: req.headers["accept-language"],
        }),
      );
    } catch (err) {
      if (err instanceof SheetReadError) {
        res.status(err.code === "too-big" ? 413 : 400).json({ error: { code: err.code, message: err.message } });
        return;
      }
      throw err;
    }
  })().catch(next);
});

function ctxOf(req: Request): PlanCtx {
  return { orgId: orgIdOf(req), userId: userIdOf(req), slug: slugOf(req), token: bearerOf(req), role: roleOf(req), acceptLanguage: req.headers["accept-language"] };
}

function sheetReadError(res: import("express").Response, err: unknown): boolean {
  if (!(err instanceof SheetReadError)) return false;
  res.status(err.code === "too-big" ? 413 : 400).json({ error: { code: err.code, message: err.message } });
  return true;
}

// AI-REACH: exempt imports a file a person uploads in the import sheet; an assistant holds no file to send
sheetsRouter.post("/sheets/import", (req, res, next) => {
  void (async () => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = PlanBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "bad_body", message: "expected { file_b64, filename } or { url }, with optional overrides", details: parsed.error.issues } });
      return;
    }
    const ctx = ctxOf(req);
    let built: Awaited<ReturnType<typeof buildPlans>>;
    try {
      built = await buildPlans(parsed.data, ctx);
    } catch (err) {
      if (sheetReadError(res, err)) return;
      throw err;
    }
    const included = built.plans.filter((p) => p.include && p.records.length > 0);
    if (!included.length) {
      res.status(400).json({ error: { code: "nothing_to_import", message: "No sheet is set to come in. Turn one on, or check it has rows." } });
      return;
    }
    // Installing, adding fields or making a collection shape the workspace:
    // the admin tier's call, the same as doing each of them by hand.
    const shaping = included.flatMap((p) => p.needs_admin.map((n) => `${p.sheet}: ${n}`));
    if (shaping.length && !["owner", "admin"].includes(ctx.role)) {
      res.status(403).json({
        error: { code: "needs_admin", message: `This import ${shaping.join("; ")}. Ask an owner or admin, or send the sheet to a collection that has the fields already.`, details: { needs: shaping } },
      });
      return;
    }
    const db = tenantDbOf(req);
    const total = included.reduce((n, p) => n + p.records.filter((r) => r.action !== "unchanged").length, 0);
    const run = await db
      .insertInto("core_import_runs")
      .values({
        created_by_user_id: userIdOf(req),
        filename: built.filename,
        status: "preparing",
        progress_total: total,
        summary: JSON.stringify({ sheets: included.map((p) => ({ sheet: p.sheet, label: p.target.label, kind: p.target.kind, planned: p.counts })) }) as never,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const ledger = new Ledger(db, run.id);
    try {
      const work = await prepareRun(
        ledger,
        { base: INTERNAL_API, slug: ctx.slug, token: ctx.token },
        included,
        built.picture.locations,
        locationPaths(built.picture.locations),
      );
      await db
        .updateTable("core_import_runs")
        // jsonb-replace-ok: the run's own plan, written once as it starts
        .set({ status: "queued", work: JSON.stringify(work) as never })
        .where("id", "=", run.id)
        .execute();
      await platform().queue.enqueue({ orgId: ctx.orgId, queue: SHEET_IMPORT_QUEUE, payload: { runId: run.id } });
      res.status(202).json({ run_id: run.id, total });
    } catch (err) {
      const message = err instanceof ImportRefused ? err.message : `The import stopped: ${(err as Error).message}`;
      await db.updateTable("core_import_runs").set({ status: "failed", error: message, finished_at: new Date() }).where("id", "=", run.id).execute();
      // What got made before it stopped is in the run's steps, so Undo takes it back.
      res.status(409).json({ error: { code: err instanceof ImportRefused ? err.code : "import_failed", message }, run_id: run.id });
    }
  })().catch(next);
});

sheetsRouter.get("/sheets/imports", (req, res, next) => {
  void (async () => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const rows = await tenantDbOf(req)
      .selectFrom("core_import_runs")
      .select(["id", "created_at", "filename", "status", "progress_done", "progress_total", "summary", "error", "finished_at", "undone_at", "undo_report"])
      .orderBy("created_at", "desc")
      // list-cap-ok: the recent imports, the ones a person checks or undoes; not an archive
      .limit(25)
      .execute();
    res.json({ items: rows });
  })().catch(next);
});

sheetsRouter.get("/sheets/imports/:id", (req, res, next) => {
  void (async () => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = String(req.params.id ?? "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(404).json({ error: { code: "not_found", message: "No such import." } });
      return;
    }
    const db = tenantDbOf(req);
    const run = await db
      .selectFrom("core_import_runs")
      .select(["id", "created_at", "filename", "status", "progress_done", "progress_total", "summary", "error", "finished_at", "undone_at", "undo_report"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!run) {
      res.status(404).json({ error: { code: "not_found", message: "No such import." } });
      return;
    }
    const steps = await db
      .selectFrom("core_import_run_steps")
      .select(["kind", (eb) => eb.fn.countAll<string>().as("n"), (eb) => eb.fn.count<string>("undone_at").as("undone")])
      .where("run_id", "=", id)
      .groupBy("kind")
      .execute();
    res.json({ ...run, steps: Object.fromEntries(steps.map((s) => [s.kind, { made: Number(s.n), undone: Number(s.undone) }])) });
  })().catch(next);
});

const UndoBody = z.object({ force: z.boolean().optional() });

// AI-REACH: exempt the undo of an import a person ran from the import sheet; its own surface offers it
sheetsRouter.post("/sheets/imports/:id/undo", (req, res, next) => {
  void (async () => {
    // Taking an import back deletes records, which is the admin tier's call.
    if (!requireRole(req, res, "owner", "admin")) return;
    const id = String(req.params.id ?? "");
    const body = UndoBody.safeParse(req.body ?? {});
    if (!body.success || !/^[0-9a-f-]{36}$/i.test(id)) {
      res.status(400).json({ error: { code: "bad_body", message: "expected { force? }" } });
      return;
    }
    const db = tenantDbOf(req);
    const run = await db.selectFrom("core_import_runs").select(["id", "status"]).where("id", "=", id).executeTakeFirst();
    if (!run) {
      res.status(404).json({ error: { code: "not_found", message: "No such import." } });
      return;
    }
    if (run.status === "undone") {
      res.status(409).json({ error: { code: "already_undone", message: "This import has already been undone." } });
      return;
    }
    // Claimed in one statement, so two presses of Undo cannot both run it.
    const claimed = await db
      .updateTable("core_import_runs")
      .set({ status: "undoing" })
      .where("id", "=", id)
      .where("status", "in", ["done", "failed", "partly-undone"])
      .returning("id")
      .executeTakeFirst();
    if (!claimed) {
      res.status(409).json({ error: { code: "busy", message: "This import is still running, or being undone. Try again once it has finished." } });
      return;
    }
    const ctx = ctxOf(req);
    const report = await undoRun(ctx.orgId, db, { base: INTERNAL_API, slug: ctx.slug, token: ctx.token }, id, body.data.force ?? false);
    res.json(report);
  })().catch(next);
});
