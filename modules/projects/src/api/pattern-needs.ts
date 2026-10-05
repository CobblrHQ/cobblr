// What a pattern needs, read from its PDF and kept on the pattern.
//
// The order is the house rule, heuristics first and AI last: the pattern's
// own text is read by pattern-materials.ts, and the AI is asked only when that
// finds no yarn and no tool at all (a pattern that describes its materials in
// prose this cannot read). A real Red Heart pattern read by the AI alone came
// back with both lengths swapped and no weight, fibre or brand; read from its
// own text it has all of them, and the one thing the text leaves open (solid
// or print) is left open instead of guessed.
//
// When it runs:
//   - a pattern PDF lands on a pattern (an upload, or Import patterns): its
//     text is read at once. No AI here, so a zip of a hundred PDFs is a
//     hundred text reads, not a hundred AI calls;
//   - somebody opens a pattern whose text named nothing: the AI is asked once;
//   - "Read the pattern again": both, replacing every row nobody edited.
//
// Storage is projects_pattern_needs (one row per yarn, hook or needle) and
// projects_pattern_reads (one row per pattern file read). Crossing into other
// modules goes through platform().files and platform().ai only.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { PatternNeedKind, PatternNeedSource, ProjectsDB } from "../db.js";
import { latestPatternFileId } from "./pattern-photo.js";
import { NOTIONS, readPatternMaterials, weightFromWords, type NotionNeed, type PatternMaterials, type ToolNeed, type YarnNeed } from "./pattern-materials.js";
import { storePatternText } from "./pattern-text.js";

export interface PatternNeed {
  id: string;
  kind: PatternNeedKind;
  position: number;
  label: string | null;
  brand: string | null;
  product: string | null;
  color: string | null;
  color_code: string | null;
  weight: string | null;
  fiber: string | null;
  quantity: number | null;
  quantity_unit: string | null;
  unit_length_m: number | null;
  length_m: number | null;
  length_choices: { label: string; unit_length_m: number }[] | null;
  size_mm: number | null;
  size_label: string | null;
  source: PatternNeedSource;
  pattern_file_id: string | null;
  edited: boolean;
  part_id: string | null;
  list_item_id: string | null;
  settled_at: string | null;
  settle_note: string | null;
}

export interface PatternRead {
  /** none: no pattern PDF. pending: a read is running. ready: needs below.
   *  empty: read, and the pattern named nothing this or the AI could use.
   *  failed: the PDF could not be read at all. */
  status: "none" | "pending" | "ready" | "empty" | "failed";
  method: "pattern" | "ai" | null;
  reason: string | null;
  pattern_file_id: string | null;
}

export interface PatternNeedsState {
  read: PatternRead;
  items: PatternNeed[];
}

const num = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));

async function tenant(orgId: string): Promise<Kysely<ProjectsDB>> {
  return (await platform().tenants.getDb(orgId)) as Kysely<ProjectsDB>;
}

export async function listNeeds(db: Kysely<ProjectsDB>, projectId: string): Promise<PatternNeed[]> {
  const rows = await db
    .selectFrom("projects_pattern_needs")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("position", "asc")
    .orderBy("created_at", "asc")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    position: r.position,
    label: r.label,
    brand: r.brand,
    product: r.product,
    color: r.color,
    color_code: r.color_code,
    weight: r.weight,
    fiber: r.fiber,
    quantity: num(r.quantity),
    quantity_unit: r.quantity_unit,
    unit_length_m: num(r.unit_length_m),
    length_m: num(r.length_m),
    length_choices: r.length_choices ?? null,
    size_mm: num(r.size_mm),
    size_label: r.size_label,
    source: r.source,
    pattern_file_id: r.pattern_file_id,
    edited: r.edited,
    part_id: r.part_id,
    list_item_id: r.list_item_id,
    settled_at: r.settled_at ? new Date(r.settled_at).toISOString() : null,
    settle_note: r.settle_note,
  }));
}

/** The PDF's text, or a reason it has none. */
export async function patternText(orgId: string, fileId: string): Promise<{ text: string } | { error: string }> {
  const bytes = await platform().files.read(orgId, fileId, "original");
  if (!bytes) return { error: "The pattern file could not be found." };
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(bytes.bytes) });
    const text = (await parser.getText()).text ?? "";
    if (!text.trim()) return { error: "The PDF has no text to read (a scan of printed pages?). Add what it needs by hand." };
    return { text };
  } catch {
    return { error: "That PDF could not be read." };
  }
}

const AI_SYSTEM =
  "You read a crochet or knitting pattern and list ONLY the materials it calls for. " +
  "Reply with ONLY a JSON object, no prose:\n" +
  '{"yarns":[{"label":<the pattern\'s name for it, e.g. "MC", "Color A", or null>,' +
  '"brand":<string|null>,"product":<the yarn line, e.g. "Super Saver", or null>,' +
  '"color":<string|null>,"color_code":<string|null>,' +
  '"weight":<the weight the pattern states, e.g. "worsted", "DK", "medium 4", or null>,' +
  '"fiber":<string|null>,"quantity":<number of balls/skeins/hanks, or null>,' +
  '"quantity_unit":<"ball"|"skein"|"hank"|null>,"unit_length_m":<metres in ONE ball, or null>,' +
  '"length_m":<total metres of this yarn, or null>}],' +
  '"tools":[{"kind":"hook"|"needle","size_mm":<number>,"size_label":<e.g. "US H-8", or null>}],' +
  '"notions":[{"name":<one of ' + NOTIONS.map((n) => JSON.stringify(n.name)).join(", ") + '>,"quantity":<number|null>,"size_mm":<number|null>}]}\n' +
  "Copy only what the text states. One entry per yarn or colour. Do not work out a length the " +
  "pattern does not give; when it gives different lengths per kind of colour (solid, print) and " +
  "does not say which a colour is, use null. Convert yards to metres (x 0.9144). " +
  "Use empty arrays when the pattern lists no yarn or no tools.";

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function pos(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The AI's reading, in the same shape as the text reader's. */
export async function aiReadMaterials(
  orgId: string,
  projectId: string,
  text: string,
  userId?: string | null,
): Promise<{ materials: PatternMaterials } | { error: string }> {
  let content: string;
  try {
    const r = await platform().ai.invoke({
      orgId,
      userId: userId ?? undefined,
      capability: "chat",
      input: {
        messages: [
          { role: "system", content: AI_SYSTEM },
          { role: "user", content: text.slice(0, 20_000) },
        ],
      },
      source: { kind: "projects:pattern-extract", id: projectId },
    });
    content = r.text;
  } catch (e) {
    return {
      error:
        e instanceof Error && /provider|capability|budget/i.test(e.message)
          ? "The pattern's text names no materials this could read, and no AI is set up for this workspace to read it (Configuration → AI). Add what it needs by hand."
          : "The AI could not be reached to read this pattern. Try again later, or add what it needs by hand.",
    };
  }
  let obj: Record<string, unknown> | null = null;
  try {
    const m = content.match(/\{[\s\S]*\}/);
    obj = m ? (JSON.parse(m[0]) as Record<string, unknown>) : null;
  } catch {
    obj = null;
  }
  if (!obj) return { error: "The AI's reading of this pattern could not be understood. Add what it needs by hand." };
  const yarns: YarnNeed[] = (Array.isArray(obj.yarns) ? obj.yarns : []).map((raw) => {
    const y = (raw ?? {}) as Record<string, unknown>;
    const quantity = pos(y.quantity);
    const unit = pos(y.unit_length_m);
    const weightRaw = str(y.weight);
    return {
      label: str(y.label),
      brand: str(y.brand),
      product: str(y.product),
      color: str(y.color),
      color_code: str(y.color_code),
      weight: weightRaw ? (weightFromWords(weightRaw) ?? weightRaw) : null,
      fiber: str(y.fiber) ? str(y.fiber)!.replace(/^\w/, (c) => c.toUpperCase()) : null,
      quantity,
      quantity_unit: str(y.quantity_unit),
      unit_length_m: unit,
      length_m: pos(y.length_m) ?? (quantity != null && unit != null ? Math.round(quantity * unit) : null),
      length_choices: null,
    };
  });
  const tools: ToolNeed[] = (Array.isArray(obj.tools) ? obj.tools : [])
    .map((raw) => {
      const t = (raw ?? {}) as Record<string, unknown>;
      const size = pos(t.size_mm);
      if (size == null) return null;
      return { kind: t.kind === "needle" ? "needle" : "hook", size_mm: size, size_label: str(t.size_label) } as ToolNeed;
    })
    .filter((t): t is ToolNeed => t !== null);
  const names = new Set<string>(NOTIONS.map((n) => n.name));
  const notions: NotionNeed[] = (Array.isArray(obj.notions) ? obj.notions : [])
    .map((raw) => {
      const n = (raw ?? {}) as Record<string, unknown>;
      const name = str(n.name);
      return name && names.has(name) ? { name, quantity: pos(n.quantity), size_mm: pos(n.size_mm) } : null;
    })
    .filter((n): n is NotionNeed => n !== null);
  return { materials: { yarns, tools, notions } };
}

/** Replace what the pattern's last reading wrote (never a row somebody edited
 *  or added by hand) with this reading. */
async function writeNeeds(
  db: Kysely<ProjectsDB>,
  projectId: string,
  fileId: string | null,
  source: "pattern" | "ai",
  m: PatternMaterials,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom("projects_pattern_needs")
      .where("project_id", "=", projectId)
      .where("source", "in", ["pattern", "ai"])
      .where("edited", "=", false)
      // A yarn picked, listed or finished holds balls and a history; a re-read
      // never takes that away.
      .where("part_id", "is", null)
      .where("list_item_id", "is", null)
      .where("settled_at", "is", null)
      .execute();
    const kept = await trx
      .selectFrom("projects_pattern_needs")
      .select((eb) => eb.fn.max("position").as("p"))
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    let position = Number(kept?.p ?? -1) + 1;
    const rows = [
      ...m.yarns.map((y) => ({
        project_id: projectId,
        kind: "yarn" as const,
        position: position++,
        label: y.label,
        brand: y.brand,
        product: y.product,
        color: y.color,
        color_code: y.color_code,
        weight: y.weight,
        fiber: y.fiber,
        quantity: y.quantity,
        quantity_unit: y.quantity_unit,
        unit_length_m: y.unit_length_m,
        length_m: y.length_m,
        length_choices: y.length_choices ? JSON.stringify(y.length_choices) : null,
        source,
        pattern_file_id: fileId,
      })),
      ...m.tools.map((t) => ({
        project_id: projectId,
        kind: t.kind,
        position: position++,
        size_mm: t.size_mm,
        size_label: t.size_label,
        source,
        pattern_file_id: fileId,
      })),
      ...m.notions.map((n) => ({
        project_id: projectId,
        kind: "notion" as const,
        position: position++,
        label: n.name,
        quantity: n.quantity,
        size_mm: n.size_mm,
        source,
        pattern_file_id: fileId,
      })),
    ];
    if (rows.length) await trx.insertInto("projects_pattern_needs").values(rows as never).execute();
  });
}

async function recordRead(
  db: Kysely<ProjectsDB>,
  projectId: string,
  fileId: string,
  row: { status: "ready" | "empty" | "failed"; method: "pattern" | "ai" | null; ai_tried: boolean; reason: string | null },
): Promise<void> {
  await db
    .insertInto("projects_pattern_reads")
    .values({ project_id: projectId, pattern_file_id: fileId, ...row })
    .onConflict((oc) => oc.columns(["project_id", "pattern_file_id"]).doUpdateSet({ ...row, read_at: new Date() }))
    .execute();
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Read one pattern file into the pattern's needs. `ai` lets the AI be asked
 * when the text names nothing; without it such a pattern is recorded as not
 * yet asked, and the next open asks.
 */
export function runPatternRead(
  orgId: string,
  projectId: string,
  fileId: string,
  opts: { ai: boolean; userId?: string | null },
): Promise<void> {
  const key = `${orgId}:${projectId}:${fileId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = (async () => {
    const db = await tenant(orgId);
    const got = await patternText(orgId, fileId);
    // The words are kept for search whatever the materials reading makes of
    // them (pattern-text.ts); a PDF with none is kept as none, so the heal
    // does not read it again.
    await storePatternText(db, projectId, fileId, "error" in got ? null : got.text);
    if ("error" in got) {
      await recordRead(db, projectId, fileId, { status: "failed", method: null, ai_tried: false, reason: got.error });
      return;
    }
    const fromText = readPatternMaterials(got.text);
    if (fromText.yarns.length || fromText.tools.length || fromText.notions.length) {
      await writeNeeds(db, projectId, fileId, "pattern", fromText);
      await recordRead(db, projectId, fileId, { status: "ready", method: "pattern", ai_tried: false, reason: null });
      return;
    }
    if (!opts.ai) {
      await recordRead(db, projectId, fileId, { status: "empty", method: "pattern", ai_tried: false, reason: null });
      return;
    }
    const ai = await aiReadMaterials(orgId, projectId, got.text, opts.userId);
    if ("error" in ai) {
      await recordRead(db, projectId, fileId, { status: "empty", method: null, ai_tried: true, reason: ai.error });
      return;
    }
    if (!ai.materials.yarns.length && !ai.materials.tools.length && !ai.materials.notions.length) {
      await recordRead(db, projectId, fileId, {
        status: "empty",
        method: "ai",
        ai_tried: true,
        reason: "The pattern does not list its yarn or hooks in a way that could be read. Add what it needs by hand.",
      });
      return;
    }
    await writeNeeds(db, projectId, fileId, "ai", ai.materials);
    await recordRead(db, projectId, fileId, { status: "ready", method: "ai", ai_tried: true, reason: null });
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

/**
 * What the pattern page shows. Opening a pattern is what finishes its reading:
 * a pattern whose PDF was never read (attached before this existed) is read
 * now, and one whose text named nothing asks the AI now, once.
 */
export async function readPatternNeedsState(
  orgId: string,
  projectId: string,
  userId?: string | null,
): Promise<PatternNeedsState> {
  const db = await tenant(orgId);
  const fileId = await latestPatternFileId(orgId, projectId);
  if (!fileId) {
    const items = await listNeeds(db, projectId);
    // No PDF, but its text was read (saved from an answer, or pasted): that
    // reading is the pattern's, not a missing file.
    const read = items.find((n) => n.source === "pattern" || n.source === "ai");
    return read
      ? { read: { status: "ready", method: read.source as "pattern" | "ai", reason: null, pattern_file_id: null }, items }
      : { read: { status: "none", method: null, reason: null, pattern_file_id: null }, items };
  }
  const key = `${orgId}:${projectId}:${fileId}`;
  const row = await db
    .selectFrom("projects_pattern_reads")
    .selectAll()
    .where("project_id", "=", projectId)
    .where("pattern_file_id", "=", fileId)
    .executeTakeFirst();
  const start = () =>
    void runPatternRead(orgId, projectId, fileId, { ai: true, userId }).catch((err: unknown) => {
      console.error(`[projects] pattern read failed for ${projectId}:`, (err as Error)?.message ?? err);
    });
  // The needs are read AFTER the read's status: a read writes its needs and
  // only then records itself ready (runPatternRead), so a "ready" read here
  // always finds them. Read the other way round, a read that finished between
  // the two queries answered "ready" with an empty list (#4888's main, run
  // 36996, and run 35417 before it).
  const items = await listNeeds(db, projectId);
  if (inFlight.has(key)) return { read: { status: "pending", method: null, reason: null, pattern_file_id: fileId }, items };
  if (!row || (row.status === "empty" && !row.ai_tried)) {
    start();
    return { read: { status: "pending", method: null, reason: null, pattern_file_id: fileId }, items };
  }
  return { read: { status: row.status, method: row.method, reason: row.reason, pattern_file_id: fileId }, items };
}

/** A pattern PDF landed on a pattern: read its text now (no AI; see above). */
export function registerPatternNeedsSubscriber(): void {
  platform().events.on("core-files.attachment.created", "projects.pattern-needs.read", async (raw: unknown) => {
    const p = raw as { orgId?: string; fileId?: string; source_module?: string; source_type?: string; source_id?: string; role?: string | null };
    if (p.source_module !== "projects" || p.source_type !== "project") return;
    if (p.role !== "pattern" || !p.orgId || !p.fileId || !p.source_id) return;
    const { orgId, source_id: projectId, fileId } = p;
    setImmediate(() => {
      runPatternRead(orgId, projectId, fileId, { ai: false }).catch((err: unknown) => {
        console.error("[projects] pattern read on attach failed:", (err as Error)?.message ?? err);
      });
    });
  });
}

/** A pattern made from text (an answer saved from Ask Cobb, a pattern typed
 *  in) lists what it needs the moment it is made, from its own words and with
 *  no AI. Only text that names a yarn or a hook or needle counts: notions on
 *  their own are not a pattern, and a project whose notes list lumber and
 *  screws must not grow a "what this pattern needs" list. */
export async function readNeedsFromText(orgId: string, projectId: string, text: string): Promise<boolean> {
  const m = readPatternMaterials(text);
  if (!m.yarns.length && !m.tools.length) return false;
  await writeNeeds(await tenant(orgId), projectId, null, "pattern", m);
  return true;
}

/** Read pasted materials text into the pattern's needs (text first, then AI). */
export async function readPastedMaterials(
  orgId: string,
  projectId: string,
  text: string,
  userId?: string | null,
): Promise<{ method: "pattern" | "ai" } | { error: string }> {
  const db = await tenant(orgId);
  const fromText = readPatternMaterials(text);
  if (fromText.yarns.length || fromText.tools.length || fromText.notions.length) {
    await writeNeeds(db, projectId, null, "pattern", fromText);
    return { method: "pattern" };
  }
  const ai = await aiReadMaterials(orgId, projectId, text, userId);
  if ("error" in ai) return ai;
  await writeNeeds(db, projectId, null, "ai", ai.materials);
  return { method: "ai" };
}
