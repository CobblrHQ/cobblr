import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import type { DigifabDB } from "./db.js";
import {
  EmbroideryFormat,
  HoopSchema,
  hoopRefusal,
  missingThreads,
  summariseEmbroidery,
  type EmbroiderySummary,
} from "./embroidery-design.js";
import { embroideryWork } from "./embroidery-pool.js";
import {
  threadSpool,
  spoolMetres,
  groupedThreadUse,
  stockContext,
  type ThreadSpool,
} from "./embroidery-stock.js";
import { ReviewRequired } from "./drivers/job-review.js";
import { stationTokenHash } from "./laser-station.js";
import { recordJobOutcome } from "./jobs-core.js";
export const EmbroideryMachine = z.object({
  label: z.string().trim().min(1).max(100),
  hoops: z
    .array(HoopSchema)
    .min(1)
    .max(20)
    .refine(
      (h) => new Set(h.map((v) => v.name)).size === h.length,
      "Give every hoop a different name.",
    ),
  formats: z.array(EmbroideryFormat).min(1).max(5),
  stitches_per_minute: z.number().finite().positive().max(3000).default(600),
  filename_prefix: z
    .string()
    .regex(/^[A-Z0-9]{1,3}$/)
    .default("EMB"),
  asset_ref: z
    .object({ kind: z.string().max(120), id: z.string().uuid() })
    .nullable()
    .default(null),
});
export type EmbroideryMachine = z.infer<typeof EmbroideryMachine>;
export const ImportEmbroidery = z.object({
  file_id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
});
export const PrepareEmbroidery = z.object({
  machine_id: z.string().uuid(),
  design_id: z.string().uuid(),
  hoop: z.string().min(1).max(100),
  format: EmbroideryFormat,
  threads: z.record(z.string().uuid()),
});
export interface EmbroideryPlan {
  checklist: string[];
  machine: EmbroideryMachine;
  hoop: z.infer<typeof HoopSchema>;
  format: EmbroideryFormat;
  filename: string;
  file_id: string;
  content_hash: string;
  summary: EmbroiderySummary;
  threads: Record<string, ThreadSpool>;
}
export const EmbroideryChecks = z.object({
  file_copied: z.literal(true),
  file_confirmed: z.literal(true),
  hoop_mounted: z.literal(true),
  colours_loaded: z.literal(true),
  origin_clear: z.literal(true),
});
export const EmbroideryReport = z.object({
  verdict: z.enum(["good", "scrap"]),
  finished: z.boolean(),
  idle_confirmed: z.literal(true),
  needle_up_confirmed: z.literal(true),
  usage: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        metres: z.number().finite().nonnegative().max(100000).multipleOf(0.001),
      }),
    )
    .min(1)
    .max(1000),
});
export type EmbroideryReport = z.infer<typeof EmbroideryReport>;
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export async function requireEmbroideryStation(
  db: Kysely<DigifabDB>,
  machineId: string,
  token: unknown,
) {
  if (typeof token !== "string" || token.length < 32 || token.length > 128)
    throw new ReviewRequired(
      "Authorize this screen at the embroidery station first.",
    );
  const station = await db
    .selectFrom("digifab_stations")
    .select("id")
    .where("connection_id", "=", machineId)
    .where("remote_device_id", "=", "embroidery")
    .where("token_hash", "=", stationTokenHash(token))
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (!station)
    throw new ReviewRequired(
      "This screen is not authorized for this embroidery machine.",
    );
}
export async function saveEmbroideryMachine(
  db: Kysely<DigifabDB>,
  orgId: string,
  asked: unknown,
  id?: string,
) {
  const config = EmbroideryMachine.parse(asked);
  if (config.asset_ref) {
    const asset = await platform().entities.lookup(
      orgId,
      config.asset_ref.kind,
      config.asset_ref.id,
    );
    if (
      !asset ||
      asset.retired ||
      !["assets:asset", "machines:machine"].includes(
        (await platform().entities.resolveKind(orgId, asset.kind)).base,
      )
    )
      throw new ReviewRequired(
        "Choose a maintained machine asset in this workspace.",
      );
  }
  if (!id)
    return db
      .insertInto("digifab_embroidery_machines")
      .values({ config })
      .returningAll()
      .executeTakeFirstOrThrow();
  return db.transaction().execute(async (trx) => {
    await trx
      .selectFrom("digifab_embroidery_machines")
      .select("id")
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (
      await trx
        .selectFrom("digifab_embroidery_runs")
        .select("job_id")
        .where("machine_id", "=", id)
        .where("consumed_at", "is", null)
        .executeTakeFirst()
    )
      throw new ReviewRequired(
        "Record this machine's pending outcome before changing its settings.",
      );
    return trx
      .updateTable("digifab_embroidery_machines")
      .set({ config, updated_at: new Date() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}
export async function importEmbroidery(
  db: Kysely<DigifabDB>,
  orgId: string,
  asked: unknown,
) {
  const b = ImportEmbroidery.parse(asked),
    file = await platform().files.read(orgId, b.file_id);
  if (!file)
    throw new ReviewRequired(
      "Upload an embroidery file in this workspace first.",
    );
  const format = EmbroideryFormat.safeParse(
    file.filename.split(".").at(-1)?.toLowerCase(),
  );
  if (!format.success)
    throw new ReviewRequired(
      "Choose a PES, DST, EXP, JEF or VP3 embroidery file.",
    );
  const parsed = await embroideryWork({
    operation: "decode",
    bytes: file.bytes,
    format: format.data,
  });
  return db
    .insertInto("digifab_embroidery_designs")
    .values({
      name: b.name,
      file_id: b.file_id,
      source_hash: hash(file.bytes),
      design: parsed.design,
      summary: parsed.summary,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
export async function prepareEmbroidery(
  db: Kysely<DigifabDB>,
  orgId: string,
  asked: unknown,
) {
  const b = PrepareEmbroidery.parse(asked),
    machine = await db
      .selectFrom("digifab_embroidery_machines")
      .selectAll()
      .where("id", "=", b.machine_id)
      .executeTakeFirst(),
    source = await db
      .selectFrom("digifab_embroidery_designs")
      .selectAll()
      .where("id", "=", b.design_id)
      .executeTakeFirst();
  if (!machine || !source)
    throw new ReviewRequired("Choose a saved embroidery machine and design.");
  const hoop = machine.config.hoops.find((h) => h.name === b.hoop);
  if (!hoop || !machine.config.formats.includes(b.format))
    throw new ReviewRequired(
      "Choose this machine's saved hoop and file format.",
    );
  const before = summariseEmbroidery(
      source.design,
      machine.config.stitches_per_minute,
    ),
    reason = hoopRefusal(before, hoop);
  if (reason) throw new ReviewRequired(reason);
  const missing = missingThreads(before.stops, b.threads);
  if (missing.length)
    throw new ReviewRequired(
      `You are missing threads for ${missing.length} colour stops: ${missing.map((i) => i + 1).join(", ")}.`,
    );
  if (Object.keys(b.threads).length !== before.stops.length)
    throw new ReviewRequired(
      "Map exactly the design's colour stops to thread spools.",
    );
  const file = await platform().files.read(orgId, source.file_id);
  if (!file || hash(file.bytes) !== source.source_hash)
    throw new ReviewRequired("The original design changed. Import it again.");
  const threads: Record<string, ThreadSpool> = {};
  for (const stop of before.stops) {
    const spool = await threadSpool(orgId, b.threads[String(stop.index)]!);
    if (!spool.color)
      throw new ReviewRequired(
        "Save a colour or brand chart code on every selected thread spool.",
      );
    threads[String(stop.index)] = spool;
  }
  for (const { spool, metres } of groupedThreadUse(
    threads,
    before.stops.map((s) => ({ index: s.index, metres: s.estimated_m })),
  ))
    if (spoolMetres(spool) < metres)
      throw new ReviewRequired(
        `The estimated thread use exceeds ${spool.name}'s remaining metres.`,
      );
  const output = await embroideryWork({
    operation: "encode",
    design: source.design,
    format: b.format,
    colours: Object.fromEntries(
      Object.entries(threads).map(([k, t]) => [k, t.color!]),
    ),
  });
  const summary = summariseEmbroidery(
      output.design,
      machine.config.stitches_per_minute,
    ),
    convertedRefusal = hoopRefusal(summary, hoop);
  if (convertedRefusal) throw new ReviewRequired(convertedRefusal);
  for (const { spool, metres } of groupedThreadUse(
    threads,
    summary.stops.map((s) => ({ index: s.index, metres: s.estimated_m })),
  ))
    if (spoolMetres(spool) < metres)
      throw new ReviewRequired(
        `The converted design needs more thread than ${spool.name} has left.`,
      );
  if (summary.stops.length !== before.stops.length)
    throw new ReviewRequired(
      "This format changed the colour-stop sequence. Choose the original format.",
    );
  const jobId = randomUUID(),
    filename = `${machine.config.filename_prefix}${jobId.replaceAll("-", "").slice(0, 5).toUpperCase()}.${b.format}`,
    stored = await platform().files.write(orgId, output.bytes, {
      filename,
      mimeType: "application/octet-stream",
    });
  if (!stored)
    throw new ReviewRequired("The embroidery output could not be saved.");
  const plan: EmbroideryPlan = {
    checklist: [
      `Copy ${filename} to a USB stick supported by the machine and safely eject it.`,
      `At the machine, select ${filename} and confirm its preview and stitch count.`,
      `Mount the ${hoop.name} hoop and check the usable sewing area.`,
      "Load the selected thread colours in the listed order. Screen colours are approximate.",
      "Check the origin and clear the needle path. Start the physical machine using its own controls.",
    ],
    machine: machine.config,
    hoop,
    format: b.format,
    filename,
    file_id: stored.fileId,
    content_hash: hash(output.bytes),
    summary,
    threads,
  };
  return db.transaction().execute(async (trx) => {
    const fresh = await trx
      .selectFrom("digifab_embroidery_machines")
      .selectAll()
      .where("id", "=", machine.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (!isDeepStrictEqual(fresh.config, machine.config))
      throw new ReviewRequired(
        "The machine settings changed. Prepare this design again.",
      );
    if (
      await trx
        .selectFrom("digifab_embroidery_runs")
        .select("job_id")
        .where("machine_id", "=", machine.id)
        .where("consumed_at", "is", null)
        .executeTakeFirst()
    )
      throw new ReviewRequired(
        "Record or discard this machine's pending run first.",
      );
    await trx
      .insertInto("digifab_jobs")
      .values({
        id: jobId,
        connection_id: null,
        target_device: machine.id,
        file_id: stored.fileId,
        file_ref: filename,
        max_attempts: 1,
        embroidery_run: true,
      })
      .execute();
    // check-then-insert: the machine row lock serializes pending-run creation and its uniqueness check.
    return trx
      .insertInto("digifab_embroidery_runs")
      .values({
        job_id: jobId,
        machine_id: machine.id,
        design_id: source.id,
        plan,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}
export async function startEmbroidery(
  db: Kysely<DigifabDB>,
  orgId: string,
  id: string,
  asked: unknown,
) {
  const b = EmbroideryChecks.extend({
    station_token: z.string().min(32).max(128),
  }).parse(asked);
  return db.transaction().execute(async (trx) => {
    const run = await trx
      .selectFrom("digifab_embroidery_runs")
      .selectAll()
      .where("job_id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!run || run.consumed_at || run.report)
      throw new ReviewRequired(
        "Choose a prepared run with no recorded outcome.",
      );
    await requireEmbroideryStation(trx, run.machine_id, b.station_token);
    if (run.started_at) return { ok: true, started_at: run.started_at };
    const machine = await trx
        .selectFrom("digifab_embroidery_machines")
        .selectAll()
        .where("id", "=", run.machine_id)
        .forUpdate()
        .executeTakeFirstOrThrow(),
      job = await trx
        .selectFrom("digifab_jobs")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirstOrThrow();
    if (
      !isDeepStrictEqual(machine.config, run.plan.machine) ||
      !job.embroidery_run ||
      job.file_id !== run.plan.file_id ||
      job.status !== "queued"
    )
      throw new ReviewRequired(
        "The prepared run changed. Discard it and prepare a new run.",
      );
    const file = await platform().files.read(orgId, run.plan.file_id);
    if (!file || hash(file.bytes) !== run.plan.content_hash)
      throw new ReviewRequired("The exported file changed. Prepare a new run.");
    const reason = hoopRefusal(run.plan.summary, run.plan.hoop);
    if (reason) throw new ReviewRequired(reason);
    for (const { spool, metres } of groupedThreadUse(
      run.plan.threads,
      run.plan.summary.stops.map((s) => ({
        index: s.index,
        metres: s.estimated_m,
      })),
    )) {
      const current = await threadSpool(orgId, spool.id);
      if (
        current.revision !== spool.revision ||
        !isDeepStrictEqual(current.config, spool.config) ||
        current.color !== spool.color ||
        spoolMetres(current) < metres
      )
        throw new ReviewRequired(
          "A selected thread changed or has too little remaining. Prepare this run again.",
        );
      await trx
        .insertInto("digifab_embroidery_thread_claims")
        .values({ part_id: spool.id, job_id: id })
        .onConflict((c) => c.column("part_id").doNothing())
        .execute();
      const claim = await trx
        .selectFrom("digifab_embroidery_thread_claims")
        .select("job_id")
        .where("part_id", "=", spool.id)
        .executeTakeFirstOrThrow();
      if (claim.job_id !== id)
        throw new ReviewRequired(
          "This thread is reserved by another embroidery run. Record its outcome first.",
        );
    }
    const now = new Date();
    await trx
      .updateTable("digifab_embroidery_runs")
      .set({ started_at: now })
      .where("job_id", "=", id)
      .execute();
    await trx
      .updateTable("digifab_jobs")
      .set({ status: "printing", sent_at: now, updated_at: now })
      .where("id", "=", id)
      .execute();
    return {
      ok: true,
      started_at: now,
      message:
        "Run tracking started. Start the physical machine after its own checks.",
    };
  });
}
export function validateEmbroideryReport(
  plan: EmbroideryPlan,
  started: boolean,
  interrupted: boolean,
  asked: unknown,
): EmbroideryReport {
  const report = EmbroideryReport.parse(asked);
  report.usage.sort((a, b) => a.index - b.index);
  if (
    report.usage.length !== plan.summary.stops.length ||
    report.usage.some((s, i) => s.index !== i)
  )
    throw new ReviewRequired(
      "Measure metres for every colour stop exactly once.",
    );
  if (
    !started &&
    (report.verdict !== "scrap" ||
      report.finished ||
      report.usage.some((s) => s.metres !== 0))
  )
    throw new ReviewRequired(
      "Discard an unstarted run as scrap with zero used metres.",
    );
  if (
    report.verdict === "good" &&
    (!report.finished || interrupted || report.usage.some((s) => s.metres <= 0))
  )
    throw new ReviewRequired(
      "A good run must be finished and account for thread in every colour stop.",
    );
  return report;
}
export async function interruptEmbroidery(db: Kysely<DigifabDB>, id: string) {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("digifab_embroidery_runs")
      .selectAll()
      .where("job_id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.consumed_at || row.report)
      throw new ReviewRequired("This run's outcome is already recorded.");
    if (!row.started_at)
      throw new ReviewRequired(
        "Discard an unstarted run with a zero-use scrap outcome.",
      );
    await trx
      .updateTable("digifab_embroidery_runs")
      .set({ interrupted: true })
      .where("job_id", "=", id)
      .execute();
    return {
      ok: true,
      message:
        "Interruption recorded. Use the physical machine's Stop control, then measure the used thread.",
    };
  });
}
export async function recordEmbroideryUse(
  db: Kysely<DigifabDB>,
  orgId: string,
  id: string,
  userId: string,
  asked: unknown,
) {
  const token = z
    .object({ station_token: z.string().min(32).max(128) })
    .parse(asked).station_token;
  const saved = await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("digifab_embroidery_runs")
      .selectAll()
      .where("job_id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!row) throw new ReviewRequired("Choose the original embroidery run.");
    await requireEmbroideryStation(trx, row.machine_id, token);
    const report = validateEmbroideryReport(
      row.plan,
      !!row.started_at,
      row.interrupted,
      asked,
    );
    if (row.report && !isDeepStrictEqual(row.report, report))
      throw new ReviewRequired(
        "This outcome is frozen. Retry the original verdict and measured metres.",
      );
    if (!row.report)
      await trx
        .updateTable("digifab_embroidery_runs")
        .set({ report })
        .where("job_id", "=", id)
        .execute();
    return { ...row, report };
  });
  if (saved.consumed_at) return { ok: true };
  for (const { spool, metres } of groupedThreadUse(
    saved.plan.threads,
    saved.report.usage,
  )) {
    if (metres === 0) continue;
    const current = await threadSpool(orgId, spool.id);
    if (
      current.kind !== spool.kind ||
      !isDeepStrictEqual(current.config, spool.config)
    )
      throw new ReviewRequired(
        "Keep the original spool's stock unit and density until this outcome is saved.",
      );
    const answer = await platform().actions.invoke(
      "inventory:consume-stock",
      stockContext(
        orgId,
        userId,
        {
          source: `embroidery:${id}:${spool.id}`,
          verdict: saved.report.verdict,
          amount: metres,
          unit: "m",
          waste: 0,
        },
        { kind: spool.kind, id: spool.id },
      ),
    );
    const result = normaliseActionResult(answer, "inventory:consume-stock");
    if (!result.ok)
      throw new ReviewRequired(
        "Thread use could not be saved. Keep this run open and retry the same measured metres.",
      );
  }
  await db
    .updateTable("digifab_embroidery_runs")
    .set({ stock_recorded_at: new Date() })
    .where("job_id", "=", id)
    .execute();
  await db
    .updateTable("digifab_jobs")
    .set({
      status:
        saved.report.finished && !saved.interrupted ? "completed" : "cancelled",
      updated_at: new Date(),
    })
    .where("id", "=", id)
    .execute();
  await recordJobOutcome(db, orgId, id, saved.report.verdict, "bed-clear", {
    good: saved.report.verdict === "good" ? 1 : 0,
    scrap: saved.report.verdict === "scrap" ? 1 : 0,
  });
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("digifab_embroidery_runs")
      .set({ consumed_at: new Date() })
      .where("job_id", "=", id)
      .execute();
    await trx
      .deleteFrom("digifab_embroidery_thread_claims")
      .where("job_id", "=", id)
      .execute();
  });
  return { ok: true };
}
