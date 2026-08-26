// The photo a design pulls out of its own pattern PDF.
//
// Attaching a pattern used to leave a "pull photo from PDF" link for the user
// to find. Now the pull runs by itself the moment the pattern lands (an event
// handler, so the upload never waits on it), attaches the best PHOTOGRAPH the
// floor in photo-picker.ts passes, and keeps every extracted image as a
// candidate with a thumbnail so the panel can offer the alternatives without
// re-reading the PDF. Below the floor nothing is attached - the strip is
// still there to choose from by hand.
//
// Everything crosses the module boundary through platform().files (read,
// write, attach, detach, list): projects never touches core-files' tables and
// never needs a bearer to act, which is what lets it run from an event.
//
// Design decision record: docs/design-decisions/pattern-photo-auto-pull.md.

import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import type { ProjectsDB } from "../db.js";
import { extractPatternImages, type ExtractedImage } from "./pdf-images.js";
import { pickPhoto } from "./photo-picker.js";

const SOURCE = { source_module: "projects", source_type: "project" } as const;
/** Strip tiles are small; the full-size image is re-extracted on "use". */
const THUMB_PX = 160;
/** More than this and the strip stops being a choice; the extractor already
 *  orders largest-first, so what is dropped is the smallest decoration. */
const MAX_CANDIDATES = 24;

export interface PatternPhotoCandidate {
  index: number;
  page: number;
  width: number;
  height: number;
  /** Passed the floor: a photograph, not a diagram. */
  photo: boolean;
}

export interface PatternPhotoState {
  /** none: no pattern on the design. pending: a pull is running (or was just
   *  started by this read). ready: the row below describes the result. */
  status: "none" | "pending" | "ready";
  pattern_file_id: string | null;
  extracted: number;
  /** The index the floor picked, or null when no image passed it. */
  hero_index: number | null;
  /** The candidate currently attached as the design's photo, if the pull
   *  (auto or by hand) attached one. */
  used_index: number | null;
  photo_file_id: string | null;
  error: string | null;
  candidates: PatternPhotoCandidate[];
}

const NONE: PatternPhotoState = {
  status: "none",
  pattern_file_id: null,
  extracted: 0,
  hero_index: null,
  used_index: null,
  photo_file_id: null,
  error: null,
  candidates: [],
};

/** One run per (workspace, design, pattern) at a time. The upload event and a
 *  page open racing each other share the same promise rather than extracting
 *  twice and attaching twice. */
const inFlight = new Map<string, Promise<PatternPhotoState>>();
const keyOf = (orgId: string, designId: string, fileId: string) => `${orgId}:${designId}:${fileId}`;

async function tenant(orgId: string): Promise<Kysely<ProjectsDB>> {
  return (await platform().tenants.getDb(orgId)) as Kysely<ProjectsDB>;
}

/** The design's most recently attached pattern PDF, or null. */
export async function latestPatternFileId(orgId: string, designId: string): Promise<string | null> {
  const rows = await platform().files.listAttachments(orgId, { ...SOURCE, source_id: designId });
  if (!rows) return null;
  const patterns = rows.filter((r) => r.role === "pattern");
  return patterns[patterns.length - 1]?.fileId ?? null;
}

async function hasPhoto(orgId: string, designId: string): Promise<boolean> {
  const rows = await platform().files.listAttachments(orgId, { ...SOURCE, source_id: designId });
  return (rows ?? []).some((r) => r.role === "photo");
}

async function loadState(
  db: Kysely<ProjectsDB>,
  designId: string,
  fileId: string,
): Promise<PatternPhotoState | null> {
  const row = await db
    .selectFrom("projects_pattern_photos")
    .selectAll()
    .where("design_id", "=", designId)
    .where("pattern_file_id", "=", fileId)
    .executeTakeFirst();
  if (!row) return null;
  const cands = await db
    .selectFrom("projects_pattern_photo_candidates")
    .select(["idx", "page", "width", "height", "photo"])
    .where("design_id", "=", designId)
    .where("pattern_file_id", "=", fileId)
    .orderBy("idx", "asc")
    .execute();
  return {
    status: "ready",
    pattern_file_id: fileId,
    extracted: row.extracted,
    hero_index: row.hero_index,
    used_index: row.used_index,
    photo_file_id: row.photo_file_id,
    error: row.error,
    candidates: cands.map((c) => ({ index: c.idx, page: c.page, width: c.width, height: c.height, photo: c.photo })),
  };
}

/**
 * What the panel renders. A design with a pattern and no recorded pull starts
 * one here - that is how designs that had a pattern BEFORE the pull became
 * automatic catch up, on first open instead of by a sweep.
 */
export async function readPatternPhotoState(orgId: string, designId: string): Promise<PatternPhotoState> {
  const fileId = await latestPatternFileId(orgId, designId);
  if (!fileId) return NONE;
  const state = await loadState(await tenant(orgId), designId, fileId);
  if (state) return state;
  const key = keyOf(orgId, designId, fileId);
  if (!inFlight.has(key)) {
    void runPatternPhoto(orgId, designId, fileId).catch((err) => {
      console.error(`[projects] pattern-photo heal failed for design ${designId}:`, err);
    });
  }
  return { ...NONE, status: "pending", pattern_file_id: fileId };
}

/** A candidate's strip thumbnail (JPEG bytes), or null. */
export async function patternPhotoThumb(orgId: string, designId: string, index: number): Promise<Buffer | null> {
  const fileId = await latestPatternFileId(orgId, designId);
  if (!fileId) return null;
  const row = await (await tenant(orgId))
    .selectFrom("projects_pattern_photo_candidates")
    .select("thumb")
    .where("design_id", "=", designId)
    .where("pattern_file_id", "=", fileId)
    .where("idx", "=", index)
    .executeTakeFirst();
  return row ? Buffer.from(row.thumb) : null;
}

/**
 * Extract, score, attach the hero (only if the design has no photo yet), and
 * record the candidates. Idempotent per (design, pattern): a second call
 * returns the recorded result unless `force` asks for a fresh read.
 */
export function runPatternPhoto(
  orgId: string,
  designId: string,
  patternFileId: string,
  opts: { force?: boolean } = {},
): Promise<PatternPhotoState> {
  const key = keyOf(orgId, designId, patternFileId);
  const running = inFlight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      return await runOnce(orgId, designId, patternFileId, opts.force === true);
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

async function runOnce(orgId: string, designId: string, fileId: string, force: boolean): Promise<PatternPhotoState> {
  const db = await tenant(orgId);
  if (!force) {
    const existing = await loadState(db, designId, fileId);
    if (existing) return existing;
  }

  const bytes = await platform().files.read(orgId, fileId, "original");
  if (!bytes) return record(db, designId, fileId, { images: [], scored: [], hero: null, error: "pattern file not found" });

  let images: ExtractedImage[];
  try {
    images = await extractPatternImages(bytes.bytes);
  } catch {
    return record(db, designId, fileId, { images: [], scored: [], hero: null, error: "could not read images from that PDF" });
  }
  const { hero, scored } = await pickPhoto(images);

  let attached: { fileId: string; attachmentId: string; index: number } | null = null;
  // "No photo yet" is the guard: a photo the user uploaded by hand is theirs,
  // and the auto pull never puts a second one beside it.
  if (hero && !(await hasPhoto(orgId, designId))) {
    const written = await platform().files.write(orgId, hero.image.png, {
      filename: photoFilename(bytes.filename, null),
      mimeType: "image/png",
    });
    if (written) {
      const att = await platform().files.attach(orgId, {
        fileId: written.fileId,
        ...SOURCE,
        source_id: designId,
        role: "photo",
      });
      if (att) attached = { fileId: written.fileId, attachmentId: att.attachmentId, index: hero.index };
    }
  }

  return record(db, designId, fileId, {
    images,
    scored,
    hero: hero?.index ?? null,
    error: null,
    attached,
  });
}

/**
 * The user tapped a tile. Re-extract (the full-size PNG is not stored), write
 * that image, swap it in for whatever the pull attached before. A photo the
 * user uploaded by hand is left alone.
 */
export async function usePatternPhoto(
  orgId: string,
  designId: string,
  index: number,
): Promise<{ ok: true; file: { id: string; width: number; height: number; bytes: number } } | { ok: false; reason: string }> {
  const fileId = await latestPatternFileId(orgId, designId);
  if (!fileId) return { ok: false, reason: "No pattern PDF is attached to this design." };
  const db = await tenant(orgId);
  const bytes = await platform().files.read(orgId, fileId, "original");
  if (!bytes) return { ok: false, reason: "The pattern file could not be read." };
  let images: ExtractedImage[];
  try {
    images = await extractPatternImages(bytes.bytes);
  } catch {
    return { ok: false, reason: "Could not read images from that PDF." };
  }
  const image = images[index];
  if (!image) return { ok: false, reason: "That image is no longer in the pattern." };

  const written = await platform().files.write(orgId, image.png, {
    filename: photoFilename(bytes.filename, index),
    mimeType: "image/png",
  });
  if (!written) return { ok: false, reason: "The image could not be saved." };

  const row = await db
    .selectFrom("projects_pattern_photos")
    .select(["attachment_id"])
    .where("design_id", "=", designId)
    .where("pattern_file_id", "=", fileId)
    .executeTakeFirst();
  if (row?.attachment_id) await platform().files.detach(orgId, row.attachment_id);

  const att = await platform().files.attach(orgId, {
    fileId: written.fileId,
    ...SOURCE,
    source_id: designId,
    role: "photo",
  });
  if (!att) return { ok: false, reason: "The image could not be attached." };

  await db
    .insertInto("projects_pattern_photos")
    .values({
      design_id: designId,
      pattern_file_id: fileId,
      extracted: images.length,
      hero_index: null,
      used_index: index,
      photo_file_id: written.fileId,
      attachment_id: att.attachmentId,
      error: null,
    })
    .onConflict((oc) =>
      oc.columns(["design_id", "pattern_file_id"]).doUpdateSet({
        used_index: index,
        photo_file_id: written.fileId,
        attachment_id: att.attachmentId,
        updated_at: new Date(),
      }),
    )
    .execute();

  return { ok: true, file: { id: written.fileId, width: image.width, height: image.height, bytes: image.bytes } };
}

/** The upload event: a pattern landed on a design, pull its photo. Runs on
 *  the bus's own next-tick, so the attach that raised it has already been
 *  answered. */
export function registerPatternPhotoSubscriber(): void {
  platform().events.on("core-files.attachment.created", "projects.pattern-photo.auto-pull", async (raw: unknown) => {
    const p = raw as {
      orgId?: string;
      fileId?: string;
      source_module?: string;
      source_type?: string;
      source_id?: string;
      role?: string | null;
    };
    if (p.source_module !== SOURCE.source_module || p.source_type !== SOURCE.source_type) return;
    if (p.role !== "pattern" || !p.orgId || !p.fileId || !p.source_id) return;
    await runPatternPhoto(p.orgId, p.source_id, p.fileId);
  });
}

function photoFilename(patternFilename: string, index: number | null): string {
  const base = (patternFilename || "pattern").replace(/\.pdf$/i, "");
  return index === null ? `${base}-photo.png` : `${base}-photo-${index + 1}.png`;
}

async function record(
  db: Kysely<ProjectsDB>,
  designId: string,
  fileId: string,
  r: {
    images: ExtractedImage[];
    scored: Awaited<ReturnType<typeof pickPhoto>>["scored"];
    hero: number | null;
    error: string | null;
    attached?: { fileId: string; attachmentId: string; index: number } | null;
  },
): Promise<PatternPhotoState> {
  const kept = r.scored.slice(0, MAX_CANDIDATES);
  const thumbs = await Promise.all(kept.map((s) => thumbnail(s.image.png)));
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("projects_pattern_photos")
      .values({
        design_id: designId,
        pattern_file_id: fileId,
        extracted: r.images.length,
        hero_index: r.hero,
        used_index: r.attached?.index ?? null,
        photo_file_id: r.attached?.fileId ?? null,
        attachment_id: r.attached?.attachmentId ?? null,
        error: r.error,
      })
      .onConflict((oc) =>
        oc.columns(["design_id", "pattern_file_id"]).doUpdateSet((eb) => ({
          extracted: r.images.length,
          hero_index: r.hero,
          // A forced re-read keeps whatever is attached; only a fresh attach
          // moves these.
          used_index: r.attached ? r.attached.index : eb.ref("projects_pattern_photos.used_index"),
          photo_file_id: r.attached ? r.attached.fileId : eb.ref("projects_pattern_photos.photo_file_id"),
          attachment_id: r.attached ? r.attached.attachmentId : eb.ref("projects_pattern_photos.attachment_id"),
          error: r.error,
          updated_at: new Date(),
        })),
      )
      .execute();
    await trx
      .deleteFrom("projects_pattern_photo_candidates")
      .where("design_id", "=", designId)
      .where("pattern_file_id", "=", fileId)
      .execute();
    if (kept.length > 0) {
      await trx
        .insertInto("projects_pattern_photo_candidates")
        .values(
          kept.map((s, i) => ({
            design_id: designId,
            pattern_file_id: fileId,
            idx: s.index,
            page: s.image.page,
            width: s.image.width,
            height: s.image.height,
            photo: s.photo,
            metrics: s.metrics as unknown as Record<string, unknown>,
            thumb: thumbs[i]!,
          })),
        )
        .execute();
    }
  });
  const state = await loadState(db, designId, fileId);
  return state ?? { ...NONE, status: "ready", pattern_file_id: fileId, extracted: r.images.length, error: r.error };
}

async function thumbnail(png: Buffer): Promise<Buffer> {
  const sharpMod = (await import("sharp")) as unknown as {
    default: (input: Buffer) => {
      resize(w: number, h: number, o: { fit: "inside"; withoutEnlargement: boolean }): {
        jpeg(o: { quality: number }): { toBuffer(): Promise<Buffer> };
      };
    };
  };
  return sharpMod.default(png).resize(THUMB_PX, THUMB_PX, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
}
