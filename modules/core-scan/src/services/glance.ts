// The first look, and the question it lets the camera ask.
//
// A photo with no barcode used to be silent for the whole considered read -
// tens of seconds on a good model - and then a name appeared. The person had
// walked on. What was asked for (2026-09-04): "a 1 second or less ability to
// ask the user right in the camera scan card - we think it's this, is that
// correct? yes or no - and from there the full prompt can elaborate."
//
// So: with the workspace's switch ON, a photo-only scan gets a GLANCE first -
// the `identify-glance` capability, a deliberately smaller question with a
// smaller answer ({name, category, confidence}) so a small model returns it in
// a second or two. It is written onto the row as a HYPOTHESIS, never as the
// name, and the card puts it to the person as a question. Their answer decides
// what the considered read does:
//
//   yes      -> the name is settled; the full read ELABORATES (brand, category,
//               fields, serial) with `confirmed_name`, and the card shows the
//               name at once rather than after the read
//   no       -> the full read runs with the guess as a hard NEGATIVE
//               (`rejected_names`), plus whatever they typed
//   silence  -> after the window, the full read runs exactly as it always has
//
// The question never blocks the camera: it sits on the capture drawer and on
// the inbox card, and an unanswered one simply expires into today's behaviour.
//
// Ownership of the row. Whoever CLAIMS the answer runs the read: the answer
// endpoint claims "yes"/"no", the detached handler claims "timeout" when the
// window closes. The claim is one conditional UPDATE against the live row
// (`glance_answer IS NULL`), so two writers cannot both run the read, and a
// server restart mid-window costs nothing worse than the old behaviour: the
// answer endpoint sees an expired window and runs the read itself.
//
// The glance keys are NOT identify-owned: a considered read that lands must
// not erase the person's answer, and a re-run must not re-ask a question they
// already answered (the same reasoning as keep_grouped).

import type { Kysely } from "kysely";
import { sql } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { CoreScanDB } from "../db.js";
import { mergeMeta } from "./metadata.js";

/** How long the camera waits for an answer before the considered read runs
 *  on its own. Long enough to read a card and tap; short enough that silence
 *  costs nothing over today. Inside the drawer's own "identifying…" window. */
export const GLANCE_WINDOW_MS = 20_000;

/** Below this the guess is not worth asking about: the card would be asking
 *  "is it a thing?" and the person would be right to ignore it. */
export const GLANCE_MIN_CONFIDENCE = 0.35;

export interface Glance {
  name: string;
  category: string | null;
  confidence: number;
  /** ISO time it was written, so a stale one can expire. */
  at: string;
  /** When the answer window closes, ISO. The answer endpoint uses it to tell
   *  "the handler is still waiting" from "the handler is gone". */
  window_until: string;
}

export type GlanceAnswer = "yes" | "no" | "timeout";

/** The workspace opt-in. OFF unless a row says otherwise: the singleton is not
 *  seeded, so a workspace that never opts in has no row and spends nothing. */
export async function readGlanceEnabled(db: Kysely<CoreScanDB>): Promise<boolean> {
  const row = await db
    .selectFrom("core_scan_glance_config")
    .select("enabled")
    .where("id", "=", true)
    .executeTakeFirst()
    .catch(() => undefined);
  return row?.enabled === true;
}

export async function writeGlanceEnabled(db: Kysely<CoreScanDB>, enabled: boolean): Promise<void> {
  await db
    .insertInto("core_scan_glance_config")
    .values({ id: true, enabled, updated_at: new Date() })
    .onConflict((oc) => oc.column("id").doUpdateSet({ enabled, updated_at: new Date() }))
    .execute();
}

/**
 * Whether this row gets a first look at all. Pure, so the rule is testable:
 * the switch is on, it is a photo with no barcode (a barcode already HAS a
 * confirmed entry to show, plain and simple), nothing has identified it yet,
 * and it has not already been glanced.
 */
export function shouldGlance(opts: {
  enabled: boolean;
  barcodeText: string | null;
  imageFileId: string | null;
  aiSuggestedAt: Date | null;
  meta: Record<string, unknown> | null | undefined;
}): boolean {
  if (!opts.enabled) return false;
  if (opts.barcodeText || !opts.imageFileId || opts.aiSuggestedAt) return false;
  return !(opts.meta ?? {}).glance;
}

/** The model's reply, tolerantly parsed. Null when there is nothing worth
 *  asking about - an empty name, a confidence under the floor, or no JSON. */
export function parseGlance(raw: string, now = new Date()): Glance | null {
  const text = (raw ?? "").trim();
  const jsonStr = text.startsWith("{") ? text : (text.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!jsonStr) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return null;
  }
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  const conf = typeof obj.confidence === "number" && Number.isFinite(obj.confidence) ? obj.confidence : 0;
  if (!name || conf < GLANCE_MIN_CONFIDENCE) return null;
  const category = typeof obj.category === "string" && obj.category.trim() ? obj.category.trim() : null;
  return {
    name,
    category,
    confidence: Math.min(1, Math.max(0, conf)),
    at: now.toISOString(),
    window_until: new Date(now.getTime() + GLANCE_WINDOW_MS).toISOString(),
  };
}

/** What a stored glance means for the considered read that follows. Pure. */
export function readContextFor(meta: Record<string, unknown> | null | undefined): {
  confirmedName?: string;
  rejectedNames?: string[];
  hint?: string;
} {
  const m = meta ?? {};
  const g = m.glance as Glance | undefined;
  const answer = m.glance_answer as GlanceAnswer | undefined;
  const hint = typeof m.glance_hint === "string" && m.glance_hint.trim() ? m.glance_hint.trim() : undefined;
  if (!g || !answer) return {};
  if (answer === "yes") return { confirmedName: g.name };
  if (answer === "no") return { rejectedNames: [g.name], ...(hint ? { hint } : {}) };
  return {};
}

/** Ask for the first look and write it onto the row. Best-effort: no provider,
 *  a bad reply or a thin guess all mean "no question", never an error the
 *  scan can see. Returns the glance when one was written. */
export async function glanceItem(opts: {
  db: Kysely<CoreScanDB>;
  orgId: string;
  itemId: string;
  imageFileId: string;
  userId?: string | null;
  knownCategories: string[];
}): Promise<Glance | null> {
  // THE THUMB, not the medium the considered read uses. A first look asks one
  // question - what is this, roughly - and 256px answers it; the payload drops
  // about thirteen-fold (79KB -> 6KB on a filament spool), and the upload is the
  // part of a small model's round trip that scales with the picture.
  //
  // The risk is a photo whose answer lives in fine print: a book spine, a value
  // printed on a resistor, a model number on a label. That risk is ALREADY
  // bounded, and by the design rather than by luck - a glance below the
  // confidence floor is never asked about (parseGlance returns null), so a thumb
  // the model cannot read degrades to NO QUESTION, which is exactly today's
  // behaviour, rather than to a confident wrong one. The considered read still
  // gets the medium either way.
  //
  // NOT YET MEASURED: how much time this actually saves. The A/B (2026-09-04)
  // ran out of the free tier's 500 requests/day mid-run, and the single thumb
  // call that completed was contaminated by rate-limit backoff. The one thing it
  // did show is that 256px still identified the spool correctly.
  const file =
    (await platform().files.read(opts.orgId, opts.imageFileId, "thumb")) ??
    (await platform().files.read(opts.orgId, opts.imageFileId, "medium")) ??
    (await platform().files.read(opts.orgId, opts.imageFileId, "original"));
  if (!file) return null;
  let glance: Glance | null = null;
  try {
    const r = await platform().ai.invoke({
      orgId: opts.orgId,
      userId: opts.userId ?? undefined,
      capability: "identify-glance",
      input: {
        image_b64: Buffer.from(file.bytes).toString("base64"),
        image_media_type: file.mimeType,
        ...(opts.knownCategories.length ? { known_categories: opts.knownCategories } : {}),
      },
      source: { kind: "core-scan:glance", id: opts.itemId },
    });
    const res = r.result as { text?: string; content?: string };
    glance = parseGlance(res.text ?? res.content ?? "");
  } catch (err) {
    console.log(`[core-scan] glance skipped: ${(err as Error)?.message ?? err}`);
    return null;
  }
  if (!glance) return null;
  const db = (await platform().tenants.getDb(opts.orgId)) as unknown as Kysely<CoreScanDB>;
  await db
    .updateTable("core_scan_inbox_items")
    .set({ suggested_metadata: mergeMeta({ glance }) as never, updated_at: new Date() })
    .where("id", "=", opts.itemId)
    .execute();
  return glance;
}

/**
 * Claim the answer for a row: exactly one writer wins. Returns true when THIS
 * call set it, false when somebody already had. The read runs only on true.
 */
export async function claimGlanceAnswer(
  db: Kysely<CoreScanDB>,
  itemId: string,
  answer: GlanceAnswer,
  hint?: string | null,
): Promise<boolean> {
  const set: Record<string, unknown> = { glance_answer: answer };
  if (hint && hint.trim()) set.glance_hint = hint.trim();
  const rows = await db
    .updateTable("core_scan_inbox_items")
    .set({ suggested_metadata: mergeMeta(set) as never, updated_at: new Date() })
    .where("id", "=", itemId)
    .where(sql`suggested_metadata->>'glance_answer'`, "is", null)
    .where(sql`suggested_metadata->'glance'`, "is not", null)
    .returning("id")
    .execute();
  return rows.length === 1;
}

/** The handler's wait for a person, as a promise, so it reads as one line. */
export function answerWindow(ms = GLANCE_WINDOW_MS): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
