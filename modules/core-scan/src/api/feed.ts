// GET /api/v1/orgs/:slug/modules/core-scan/feed
//
// The last few CAPTURES, for a screen that is not the scanner.
//
// A scanner does not always have a screen. A ring scanner worn on a finger and
// hosted by an edge bridge has nowhere to say what it just read, and holding up
// a phone to check defeats the point of wearing it. This is what a watch, a
// bench display or a second monitor reads.
//
// WHY THIS IS A READ AND NOT A TABLE. The first cut of this (#1679, written
// 2026-08-06) added `core_scan_feed`: a second table a producer POSTed to, with
// the resolution flattened onto the row. Both halves aged badly in the six
// weeks it sat conflicted.
//
//   · Every scan now enters through ONE door (services/intake.ts, #3049), which
//     is the only insert into the inbox. A second write path for "a scan
//     happened" is the exact drift that door exists to prevent, and a bridge
//     posting to both would file nothing from the one that was not the inbox.
//   · A flattened outcome goes stale. The identify and the match run detached,
//     seconds later, so a row written "unknown" at capture stays "unknown" on
//     the display forever while the card beside it says Voron 2.4 kit. Reading
//     the row live cannot go stale, because there is nothing to keep in sync.
//   · The `source` column (which scanner) had no producer: Mode B hardware is
//     still pending (docs/design-decisions/scan-drives-screen.md §Phasing), so
//     it would have shipped as a column nothing can set.
//
// So the feed is a projection of the scan inbox, and every door that admits a
// row is on the display for free.
//
// WHAT IT SHOWS. What somebody CAPTURED here: a barcode, a photo (a
// photographed receipt is one), a link, a typed identifier or phrase. Named
// positively off the shape the intake door stamps on every row it admits
// (`intake_shape`), so the rows a capture DERIVED are out by construction
// rather than by a list somebody has to remember to extend: a receipt's twelve
// lines are one capture on the display, not twelve, and a split's children do
// not repeat their parent.
//
// An import is out too, by its provenance stamp: a file somebody loaded is not
// a thing anybody scanned, and 200 rows of it would turn the one surface whose
// value is "what just happened" into a second inbox. The residual edge is a
// row imported with no `source_id` at all, which carries no provenance to
// recognise it by; it can appear once, and it is the only way in.
import { Router } from "express";
import { z } from "zod";
import { sql } from "kysely";
import { tenantDb } from "../db.js";
import { asyncHandler, badBody, requireRole } from "./util.js";
import { servedAll } from "./inbox.js";
import { SINCE_CURSOR_START, latestSinceCursor, sinceCursorSql } from "@cobblr/platform-contract/keyset-cursor";

export const feedRouter = Router({ mergeParams: true });

/** How many a display can catch up on in one read. A watch that slept through
 *  ten scans wants to know it missed them, not to replay a shift. */
const MAX = 50;

const FeedQuery = z.object({
  /** The last activity stamp the display saw. It gets what is newer, and a
   *  count of what did not fit, so "nothing happened" and "I missed three"
   *  are different answers rather than the same empty list. */
  after: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(MAX).optional(),
});

/** Two different questions, answered by two different columns.
 *
 *  WHAT CHANGED since the display last looked is `greatest(created_at,
 *  updated_at)`: the identify and the match land seconds after the capture and
 *  a second beep on the same code BUMPS its row rather than inserting one
 *  (inbox.ts, the re-scan branch), so a cursor on creation alone would leave a
 *  sleeping display showing "Identifying…" forever.
 *
 *  WHAT ORDER to show them in is `created_at`, when the person actually
 *  scanned it. Ordering by activity read well until a pass finished late: the
 *  jar you scanned two items ago got its name and jumped over the bolt in your
 *  hand, so the screen said "this is what you just scanned" about the wrong
 *  thing. A display that is confidently wrong is worse than one that is a
 *  moment behind. (An api test holds it: "the later scan leads".) */
const ACTIVITY = sql<Date>`greatest(created_at, updated_at)`;

/** The cursor, at the database's precision (keyset-cursor.ts: a since-cursor
 *  never passes through a Date, #4916). */
const ACTIVITY_CURSOR = sql<string>`${sql.raw(sinceCursorSql("greatest(created_at, updated_at)"))}`;

feedRouter.get(
  "/feed",
  asyncHandler(async (req, res) => {
    // A bench display may well be signed in as a guest.
    if (!requireRole(req, res, "owner", "admin", "member", "guest")) return;
    const parsed = FeedQuery.safeParse(req.query);
    if (!parsed.success) return badBody(res, parsed.error);
    const { after, limit = 10 } = parsed.data;
    const db = tenantDb(req);

    // ONE definition of what the display shows, used by the page and by the
    // count behind it: two hand-written copies is how `missed` comes to lie.
    const CAPTURED = sql<boolean>`status <> 'discarded'
      and suggested_metadata -> 'import_provenance' is null
      and coalesce(suggested_metadata ->> 'intake_shape', '') in ('barcode', 'url', 'photo', 'identifier', 'phrase')`;
    const since = after ? sql<boolean>`${ACTIVITY} > ${after}::timestamptz` : sql<boolean>`true`;

    const rows = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .select(ACTIVITY_CURSOR.as("activity_at"))
      .where(CAPTURED)
      .where(since)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();

    // Only when a cursor was given: without one there is no "missed", there is
    // just a list. A second query on purpose - a count over the page would
    // count the page, not what is behind it.
    let missed = 0;
    if (after) {
      const total = await db
        .selectFrom("core_scan_inbox_items")
        .select(({ fn }) => fn.countAll<string>().as("n"))
        .where(CAPTURED)
        .where(since)
        .executeTakeFirst();
      missed = Math.max(0, Number(total?.n ?? 0) - rows.length);
    }

    // The high-water mark of the PAGE, not of its first row: the page is
    // ordered by capture time, so the newest activity can belong to any row on
    // it, and a cursor taken from the first would re-deliver the others for
    // ever.
    const high = latestSinceCursor(rows.map((r) => r.activity_at));
    const served = rows.map(({ activity_at: _activity, ...r }) => r);
    return res.json({
      scans: await servedAll(req, served),
      // Stated rather than inferred: a display must never have to read the
      // cursor out of an empty list.
      cursor: high ?? after ?? SINCE_CURSOR_START,
      missed,
    });
  }),
);
