// Re-running a scan: the AI re-run, photo options and ranking, the glance question, the catalog image, undo and revisions.
// Split from api/inbox.ts by route group (#7385); inbox.ts mounts the groups in order.
import { Router } from "express";
import { appendScanHistory, preRerunSnapshot, recordRevision, restoreRevision } from "../../services/scan-history.js";
import { COULDNT_SAVE_WORDS } from "@cobblr/platform-contract/scan-pictures";
import { rememberPickedImage } from "../../services/picked-images.js";
import { type Request } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { platform } from "@cobblr/platform-contract";
import { bearer, sessionUser, tenantContext, tenantDb } from "../../db.js";
import { asyncHandler, badBody, requireRole } from "../util.js";
import { downloadCatalogImage, enrichBarcodeItem, isJunkName } from "../../services/enrich.js";
import { addedPhotoIntent } from "../../services/crosscheck-policy.js";
import { crossCheckScanPhoto, enrichPhotoItem, refreshCatalogImageByName } from "../../services/enrich-photo.js";
import { mergeMeta, standingHints } from "../../services/metadata.js";
import { hintWithoutCount, parseHintFacts } from "../../services/hint-facts.js";
import { identifyTypedIdentifier } from "../../services/identify-identifier.js";
import { type CatalogSource, type CatalogStep, popStep, seedHistory } from "../../services/catalog-history.js";
import { selectTopCandidates, isFreshCategory } from "../../services/ddg-images.js";
import { pictureOptions } from "../../services/picture-options.js";
import { rankPhotoWithAi, isRankFailure, rankFailureSentence } from "../../services/rank-photo.js";
import { looksOfRow, picturesThatAgree } from "../../services/picture-agrees.js";
import { deriveRankContext, IMAGE_BUDGET, readPhotoRankEnabled, writePhotoRankEnabled } from "../../services/auto-rank.js";
import { looksLikeReceiptPhoto, routeScannedReceiptPhoto } from "../../services/receipt-photo.js";
import { reportBarcodeCorrection, unitLotsOf } from "../../services/barcode-corrections.js";
import { claimGlanceAnswer, readContextFor, readGlanceEnabled, writeGlanceEnabled } from "../../services/glance.js";
import { normalizeBarcode, barcodeFromHint } from "../../services/barcode-correction.js";
import { cropRegion, cropRefusalWords } from "../../services/image-ops.js";
import { FIELD_PROVENANCE_KEY, fieldProvenanceOf } from "@cobblr/platform-contract/acquisition-source";
import { applyRejectName } from "../../services/user-name.js";
import { displayName, rejectedNamesOf, USER_NAME_KEY } from "@cobblr/platform-contract/display-identity";
import { optionalField, optionalText, optionalUuid } from "@cobblr/platform-contract/optional-fields";
import { INTERNAL_API, OrigCatalog, catalogMetaSet, matchItem, served } from "./shared.js";

export const rerunRouter = Router({ mergeParams: true });

// ─────────────────────── POST /inbox/:id/rerun-ai ─────────────────

const RerunBody = z.object({
  /** The user's research hint ("model number is X", "it's the 5mm one") —
   *  persisted into suggested_metadata.user_hint, which rides
   *  lookup_metadata into the matchmaker prompt as the authoritative
   *  correction. */
  hint: optionalField(z.string().trim().max(500)),
  /** "This is wrong" — re-resolve across ALL sources + the web, treat the result
   *  as authoritative (distrust the flagged answer), and write the correction
   *  back to BIdb. */
  wrong: z.boolean().optional(),
  /** "Right product, but needs detail" — keep the identity, but web-identify
   *  across the board and accept a fuller name/spec/brand for the same item. */
  enrich: z.boolean().optional(),
  /** The user photographed the product to (re)identify it — attach this photo and
   *  force the VISION path even when a (wrong) barcode is already on the item. The
   *  phone's "Not it — photograph it": a junk/non-product barcode that no source
   *  can fix gets identified from the package instead. */
  image_file_id: optionalUuid(),
  /** The CORRECTED barcode - typed into the barcode editor, or read off the
   *  label after the camera/vision got a digit wrong. Replaces `barcode_text`
   *  and the lookup re-runs on the corrected code. Spaces/dashes tolerated;
   *  rejected unless it normalizes to a real barcode length. */
  barcode: optionalField(z.string().trim().max(40)),
  /** REPLAY: re-run the pipeline without spending a token. Every AI stage is
   *  served from the cache, and a stage with no cached reply is SKIPPED (it
   *  degrades exactly as it would with no provider — the matchmaker falls back to
   *  its keyword heuristic) rather than calling out.
   *
   *  This exists to exercise a change to our own deterministic code — the reply
   *  parsers, pack-size, the split derivation, keyword routing, decoder role-fill,
   *  field mapping — against real items, instantly and for free. It CANNOT test a
   *  prompt change: the cache is keyed on the input (the image), not the prompt,
   *  so a cached reply answers whatever prompt was live when it was bought. */
  no_ai: z.boolean().optional(),
});

// AI-TOOL: change_scan_item
rerunRouter.post(
  "/inbox/:id/rerun-ai",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    const rerun = RerunBody.safeParse(req.body ?? {}).data;
    // THE HINT IS A STANDING FACT ABOUT THE ITEM, not a parameter of one press.
    // A typed hint wins; otherwise the item's existing one keeps applying (and is
    // recovered from history if it predates user_hint becoming durable). Without
    // this a re-run silently dropped the correction and re-answered with the very
    // thing the user had already corrected (reported 2026-07-30: "the hint is in the
    // history, I should not have to provide it again").
    const typedHint = rerun?.hint?.trim() || null;
    const priorHints = standingHints(row.suggested_metadata as Record<string, unknown>);
    const effectiveHint = typedHint ?? (priorHints.length ? priorHints[priorHints.length - 1]! : null);
    // The whole sequence the identify is shown: everything they have told us,
    // with what they typed THIS time appended as the most recent. Later
    // corrections override earlier ones on conflict; unrelated ones all apply.
    const effectiveHints = typedHint
      ? [...priorHints.filter((h) => h.toLowerCase() !== typedHint.toLowerCase()), typedHint]
      : priorHints;
    // A model is shown what a hint says WITHOUT its count: the count is the
    // person's own fact, set below, and a model asked to weigh it answered
    // "unconfirmed" and left one (#4552). The stored hint stays whole.
    const modelHint = hintWithoutCount(effectiveHint);
    const modelHints = effectiveHints.map(hintWithoutCount).filter((h): h is string => !!h);

    // Record the triage action in the item's history (covers the photo branch's
    // early return too) so the source panel can show "you asked for more detail".
    // A hint whose count or part number is the whole of what it says is read
    // here and asks no model (below): its history line says so, and is never
    // settled as an AI that did not answer.
    const earlyFacts = parseHintFacts(effectiveHint);
    const readsHintOnly =
      !rerun?.no_ai &&
      !rerun?.image_file_id &&
      !(normalizeBarcode(rerun?.barcode) ?? barcodeFromHint(effectiveHint, row.barcode_text)) &&
      // VOCAB-ENUMERATION OK: the hint parser's kind (a part number), not a field role
      (earlyFacts.identifierKind === "identifier" || (!!typedHint && parseHintFacts(typedHint).quantity != null && !parseHintFacts(typedHint).identifier && !parseHintFacts(typedHint).rest));
    // ── the barcode is a FACT the user can correct ─────────────────────────
    // Two doors, one landing spot: the explicit `barcode` field (the editor),
    // or a hint that carries one ("correct barcode X" - which used to ride into
    // the prompts as prose while barcode_text stayed wrong, so every re-run
    // faithfully re-resolved the misread code). Either way the code itself is
    // replaced and the lookup below re-runs against it.
    if (rerun?.barcode !== undefined && normalizeBarcode(rerun.barcode) === null) {
      res.status(400).json({
        error: {
          code: "invalid_barcode",
          message: "That doesn't look like a barcode - expected 8, 12, 13 or 14 digits.",
        },
      });
      return;
    }
    // Say WHICH kind of run this was — "Re-ran the lookup" hid whether tokens
    // were spent, a hint was folded in, or it was a free replay.
    const runAction = readsHintOnly
      ? "hint"
      : rerun?.wrong
        ? "wrong"
        : rerun?.enrich
          ? "enrich"
          : rerun?.no_ai
            ? "replay"
            : effectiveHint
              ? "rerun-hint"
              : "rerun";
    // Every path below can replace what the row shows, the inline barcode one
    // included (it once kept nothing, so a cumin re-looked-up as a skirt had
    // no way back, #6100). The row as it stands is recorded first; the
    // History entry, the toast's Undo and "Previously: … · Revert" all
    // restore from it.
    const revision = await recordRevision(db, id, runAction);
    const preRerun = { ...preRerunSnapshot(row, rerun?.no_ai ? "replay" : "rerun"), revision: revision.id };
    await db
      .updateTable("core_scan_inbox_items")
      .set({ suggested_metadata: mergeMeta({ pre_rerun: preRerun }) as never })
      .where("id", "=", id)
      .execute();
    await appendScanHistory(db, id, {
      action: runAction,
      revision,
      // The hint the run actually USED — so a re-run that carried a standing hint
      // says so, instead of reading as a plain re-run that ignored it.
      note: effectiveHint,
    });
    const correctedBarcode =
      normalizeBarcode(rerun?.barcode) ?? barcodeFromHint(effectiveHint, row.barcode_text);
    if (correctedBarcode && correctedBarcode !== row.barcode_text) {
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          barcode_text: correctedBarcode,
          // A user-typed code is authoritative - clear the "ai-photo" distrust an
          // OCR'd one carries, and keep the old code for the paper trail.
          suggested_metadata: mergeMeta({
            barcode_source: "user",
            barcode_corrected: { from: row.barcode_text, at: new Date().toISOString() },
          }) as never,
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
      await appendScanHistory(db, id, { action: "barcode", revision, note: correctedBarcode });
      row.barcode_text = correctedBarcode;
    }

    // The user photographed the product to re-identify it (phone "Not it —
    // photograph it"). Attach the new photo and force the vision path below, even
    // if a (wrong) barcode is sitting on the item — vision off the package beats a
    // junk/non-product code no source can fix.
    const attachedPhoto = rerun?.image_file_id;
    if (attachedPhoto) {
      await db
        .updateTable("core_scan_inbox_items")
        .set({ image_file_id: attachedPhoto, updated_at: new Date() })
        .where("id", "=", id)
        .execute();
      row.image_file_id = attachedPhoto;
    }

    // ── the hint's own facts, read before any model ───────────────────────
    // "8x S-12415" is eight of the S-12415. The count is the person's own
    // word, so it is set and stamped theirs; only what they typed THIS time
    // counts, so a later re-run never puts back a count they changed since.
    // The part number is looked up the way a typed one is (web, for the
    // identifier itself), never handed to the vision model as prose (#4552).
    // A standing hint's count applies too, until a person sets one: the first
    // press of "8x s-12415" may have run before the count was read by shape
    // (the model declined it), and a later re-run carries no typed text. Once
    // the count is the person's (the hint, the stepper) a re-run leaves it.
    const typedCount = typedHint
      ? parseHintFacts(typedHint).quantity
      : fieldProvenanceOf(row.suggested_metadata).quantity?.by === "person"
        ? null
        : parseHintFacts(effectiveHint).quantity;
    if (typedCount != null) {
      const stamps = { ...fieldProvenanceOf(row.suggested_metadata), quantity: { by: "person" as const, from: "hint", at: new Date().toISOString() } };
      await db
        .updateTable("core_scan_inbox_items")
        .set({ quantity: typedCount, suggested_metadata: mergeMeta({ [FIELD_PROVENANCE_KEY]: stamps }) as never, updated_at: new Date() })
        .where("id", "=", id)
        .execute();
      row.quantity = typedCount;
      row.suggested_metadata = { ...((row.suggested_metadata ?? {}) as Record<string, unknown>), [FIELD_PROVENANCE_KEY]: stamps } as typeof row.suggested_metadata;
    }
    const hintFacts = parseHintFacts(effectiveHint);
    // VOCAB-ENUMERATION OK: "identifier" here is the hint parser's kind (a part number, not a catalog code), not a field role
    if (hintFacts.identifier && hintFacts.identifierKind === "identifier" && !correctedBarcode && !attachedPhoto && !rerun?.no_ai) {
      const code = hintFacts.identifier;
      // The person said what it is: the identifier is theirs, whatever name
      // the web then finds for it.
      const vouched = { ...fieldProvenanceOf(row.suggested_metadata), identifier: { by: "person" as const, from: "hint", at: new Date().toISOString() } };
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          suggested_metadata: sql`(coalesce(suggested_metadata, '{}'::jsonb) - 'matched_at' - 'finalized_at' - 'match_failed')
            || ${JSON.stringify({
              [FIELD_PROVENANCE_KEY]: vouched,
              pipeline_started_at: new Date().toISOString(),
              pipeline_kind: "rerun",
              ...(effectiveHint ? { user_hint: effectiveHint } : {}),
              // What was on screen before, for "Previously: … · Revert".
              pre_rerun: preRerun,
            })}::jsonb` as never,
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
      const uidHint = sessionUser(req).id;
      const baseUrlHint = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      const lookup = (async () => {
        const workDb = (await platform().tenants.getDb(ctx.org.id)) as unknown as typeof db;
        const outcome = await identifyTypedIdentifier({ db: workDb, orgId: ctx.org.id, itemId: id, code, userId: uidHint, fromHint: true });
        const after = await workDb
          .selectFrom("core_scan_inbox_items")
          .select(["suggested_name", "suggested_metadata", "suggested_manufacturer", "catalog_image_url"])
          .where("id", "=", id)
          .executeTakeFirst();
        // The picture follows the new identity: the web's own picture of the
        // part when it had one, otherwise a search for the name and the
        // identifier together, never the old name with words added to it.
        const webPicture = outcome === "named" && !!after?.catalog_image_url && after.catalog_image_url !== row.catalog_image_url;
        if (after && !webPicture) {
          const name = displayName(after) ?? "";
          const query = name.toLowerCase().includes(code.toLowerCase()) ? name : `${name} ${code}`.trim();
          await refreshCatalogImageByName(ctx.org.id, id, query, after.suggested_manufacturer).catch((e: Error) =>
            console.error("[core-scan] hint picture search failed:", e.message),
          );
        }
        void platform().events.emit("core-scan.scan.enriched", { orgId: ctx.org.id, itemId: id });
        await matchItem({ orgId: ctx.org.id, userId: uidHint, orgSlug: ctx.org.slug, token, baseUrl: baseUrlHint, itemId: id, force: true }).catch((e: Error) =>
          console.error("[core-scan] hint re-run match threw:", e.message),
        );
        await workDb
          .updateTable("core_scan_inbox_items")
          .set({
            ai_suggested_at: new Date(),
            suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ finalized_at: new Date().toISOString() })}::jsonb` as never,
            updated_at: new Date(),
          })
          .where("id", "=", id)
          .execute();
      })();
      // DETACHED: the hint lookup; the row shows it is still being read and updates when this lands
      lookup.catch((err) => console.error("[core-scan] hint lookup failed:", (err as Error)?.message ?? err));
      res.json(await served(req, row));
      return;
    }
    // A hint that only says how many ("8x") has nothing left to ask a model.
    if (typedHint && typedCount != null && !parseHintFacts(typedHint).identifier && !parseHintFacts(typedHint).rest && !correctedBarcode && !attachedPhoto) {
      res.json(await served(req, row));
      return;
    }

    // A RECEIPT beats a barcode, and it has to be decided before this branch.
    //
    // Photographing a receipt makes the vision pass read the UPCs printed on its
    // line items — that is the "photograph it, recover the barcode" feature
    // working exactly as designed on the wrong kind of paper. The number sticks
    // to the row, and from then on every re-run takes the barcode LOOKUP path
    // below, which never reaches the receipt route: a Walmart receipt kept
    // coming back as "Walmart Receipt - 16in Cheese Pizza" no matter how many
    // times it was re-run (reported 2026-08-19).
    //
    // A number printed on a receipt identifies a line ON the document, never the
    // document. So when the row's own stored identity says receipt, the receipt
    // route wins. It costs no model call: `photo_observations` and `category`
    // are already on the row, and they are the two fields the rule reads — which
    // also means a row filed wrongly BEFORE any of this shipped is repaired by
    // pressing re-run, rather than needing to be deleted and rephotographed.
    const storedMeta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
    if (
      row.image_file_id &&
      looksLikeReceiptPhoto({
        observations: typeof storedMeta.photo_observations === "string" ? storedMeta.photo_observations : "",
        category: typeof storedMeta.category === "string" ? storedMeta.category : null,
        name: displayName(row),
      })
    ) {
      const routed = await routeScannedReceiptPhoto({
        orgId: ctx.org.id,
        itemId: id,
        fileId: row.image_file_id,
        userId: sessionUser(req).id,
      });
      if (routed.routed) {
        res.json({ ok: true, receipt: true, items: routed.items });
        return;
      }
      // Could not read its lines after all — fall through to the ordinary
      // re-run rather than leaving the row half-processed.
    }

    if ((!row.barcode_text || attachedPhoto) && !correctedBarcode) {
      // Photo-only path → re-run the vision identify. The vision+match pass runs
      // tens of seconds over the edge relay, so we DON'T hold the request for it
      // (holding past ~100s 524s behind the hosted Cloudflare tunnel). Instead we
      // kick the work off detached and return immediately; the web shows a local
      // "AI reading…" state on this card and the inbox poll surfaces the result.
      // The detached work runs on its OWN freshly-acquired tenant db (the request
      // pool is gone once we respond) — enrichPhotoItem re-acquires after its
      // vision call and matchItem re-acquires its own, so neither touches a reaped
      // pool.
      if (!row.image_file_id) {
        // No barcode, no photo — but maybe a NAME (a receipt/note line). Re-run the
        // NAME-based lookup (web image search + re-match) instead of refusing, so a
        // receipt line isn't stuck imageless AND un-rerunnable (reported 2026-07-24: the
        // ↺ button is enabled for name-only items, but the server still rejected).
        // Detached like the photo path; the run ends by stamping finalized_at.
        if (!displayName(row)) {
          res.status(400).json({ error: { code: "no_input", message: "item has no barcode, photo, or name to look up" } });
          return;
        }
        const nameQuery = [displayName(row), modelHint].filter(Boolean).join(" ").trim();
        const nameBrand = row.suggested_manufacturer;
        await db
          .updateTable("core_scan_inbox_items")
          .set({
            suggested_metadata: sql`(coalesce(suggested_metadata, '{}'::jsonb) - 'matched_at' - 'finalized_at' - 'match_failed')
              || ${JSON.stringify({
                pipeline_started_at: new Date().toISOString(),
                pipeline_kind: "rerun",
                ...(effectiveHint ? { user_hint: effectiveHint } : {}),
              })}::jsonb` as never,
            updated_at: new Date(),
          })
          .where("id", "=", id)
          .execute();
        const uidName = sessionUser(req).id;
        const baseUrlName = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
        // DETACHED: a catalog picture for the name; the row keeps its picture until then
        void (async () => {
          try {
            await refreshCatalogImageByName(ctx.org.id, id, nameQuery, nameBrand);
          } catch (e) {
            console.error("[core-scan] name re-run image threw:", (e as Error).message);
          }
          try {
            await matchItem({ orgId: ctx.org.id, userId: uidName, orgSlug: ctx.org.slug, token, baseUrl: baseUrlName, itemId: id, force: true });
          } catch (e) {
            console.error("[core-scan] name re-run match threw:", (e as Error).message);
          }
          // End the run so the card's spinner stops (stamp the completion signal +
          // finalized_at, which isRerunInFlight checks) on a freshly-acquired pool.
          try {
            const wdb = (await platform().tenants.getDb(ctx.org.id)) as unknown as typeof db;
            await wdb
              .updateTable("core_scan_inbox_items")
              .set({
                ai_suggested_at: new Date(),
                suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) || ${JSON.stringify({ finalized_at: new Date().toISOString() })}::jsonb` as never,
                updated_at: new Date(),
              })
              .where("id", "=", id)
              .execute();
          } catch {
            /* non-fatal bookkeeping */
          }
        })().catch((err) => console.error("[core-scan] name rerun work failed:", (err as Error)?.message ?? err));
        res.json(await served(req, row));
        return;
      }
      const imageFileId = row.image_file_id;
      const baseUrl = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      const photoHint = modelHint ?? undefined;
      // Mark the pipeline RUNNING before we return, and clear the terminal
      // markers the last run left behind. Without this the card kept the previous
      // run's `matched_at`/`finalized_at` (and its candidate list), so the UI's
      // "AI is reading…" predicate stayed false and the spinner stopped the moment
      // the name landed — while the matchmaker was still in flight. It looked
      // done, and then it changed, which reads as a bug rather than as progress.
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          suggested_metadata: sql`(coalesce(suggested_metadata, '{}'::jsonb) - 'matched_at' - 'finalized_at' - 'match_failed')
            || ${JSON.stringify({
              pipeline_started_at: new Date().toISOString(),
              // The UI labels the WHOLE in-flight cycle from this ("Replaying
              // (no AI)…" vs "AI reading…") — the mutation returns immediately,
              // so a client-side flag alone reverts to AI language mid-run.
              pipeline_kind: rerun?.no_ai ? "replay" : "rerun",
              // SNAPSHOT the answer we're about to overwrite. A re-run is a
              // gamble: vision can read a dark photo of a Hercules tool tote as a
              // "Portable Bluetooth Speaker" and clobber the good name that was
              // already there (reported 2026-07-17). The run writes suggested_* in
              // place and `history` only records {at, action}, so the row could
              // not say what it used to be — the old name survived only by luck,
              // in the raw AI call log. One run deep is the useful depth: the
              // thing you want back is what was on screen before you tapped.
              pre_rerun: preRerun,
              // The hint has to ride into the matchmaker too — the barcode path
              // stamps it below, but the photo path returns before that, which
              // silently dropped the correction entirely.
              ...(photoHint ? { user_hint: photoHint } : {}),
            })}::jsonb` as never,
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
      // "This is wrong" on a photo: the user-picked catalog image was anchoring
      // the identity (the re-read kept seeing the picked product). Drop its lock
      // + refs so the re-identify — and the user's hint — aren't fighting a stale
      // image. A plain hint/enrich keeps the picked image (it's still the item).
      // Drop the ONE key DB-side: rebuilding the object from the request's stale
      // in-memory `row` would roll back whatever the write above (or a concurrent
      // pass) just committed.
      if (rerun?.wrong) {
        await db
          .updateTable("core_scan_inbox_items")
          .set({
            catalog_image_file_id: null,
            catalog_image_url: null,
            suggested_metadata: sql`coalesce(suggested_metadata, '{}'::jsonb) - 'catalog_image_user_set'` as never,
            updated_at: new Date(),
          })
          .where("id", "=", id)
          .execute();
        // "This is wrong" is a person turning the shown name down: stamped the
        // same way "Not right" stamps it, so this re-run, a replay or a later
        // lookup can never put it back (#3724). Only the name stamp and the
        // person's own name are touched, DB-side.
        const shownMeta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
        const rejectedMeta = applyRejectName(shownMeta, displayName({ suggested_name: row.suggested_name, suggested_metadata: shownMeta }));
        if (rejectedMeta !== shownMeta) {
          await db
            .updateTable("core_scan_inbox_items")
            .set({
              suggested_metadata: mergeMeta({ [FIELD_PROVENANCE_KEY]: rejectedMeta[FIELD_PROVENANCE_KEY] }, [USER_NAME_KEY, FIELD_PROVENANCE_KEY]) as never,
              updated_at: new Date(),
            })
            .where("id", "=", id)
            .execute();
        }
      }
      const rejectedNames = rejectedNamesOf(
        rerun?.wrong
          ? applyRejectName((row.suggested_metadata ?? {}) as Record<string, unknown>, displayName({ suggested_name: row.suggested_name, suggested_metadata: row.suggested_metadata }))
          : row.suggested_metadata,
      );
      // Capture the caller now — the detached work runs after the request, so
      // route the AI through their personal connection (the 'own' path).
      const uid = sessionUser(req).id;
      const replay = !!rerun?.no_ai;
      // DETACHED: the re-read the person asked for; the row shows it is being read and updates when this lands
      void (async () => {
        const workDb = (await platform().tenants.getDb(ctx.org.id)) as unknown as typeof db;
        // A REPLAY DOES NOT RE-IDENTIFY. The identity — name, manufacturer, sku,
        // category, observations — is already stored on this row, so there is
        // nothing to ask for and nothing to pay. It used to call identify
        // cache-only and hope for a hit, which was backwards: the answer was
        // already owned, and on a miss (the normal case, since the cache key is
        // pinned to provider + model) the row degraded. What a replay re-runs is
        // everything DOWNSTREAM of identity, which is `matchItem` below.
        //
        // It must still stamp ai_suggested_at — that is the client's completion
        // signal, and without it the REPLAYING badge spins to its 95s timeout on
        // a run that finished in a second.
        if (replay) {
          await workDb
            .updateTable("core_scan_inbox_items")
            .set({ ai_suggested_at: new Date(), updated_at: new Date() })
            .where("id", "=", id)
            .execute();
        } else {
          const outcome = await enrichPhotoItem({
            db: workDb,
            orgId: ctx.org.id,
            itemId: id,
            imageFileId,
            userId: uid,
            force: true,
            visitorIp: req.ip ?? null,
            hint: photoHint,
            hints: modelHints,
            // Names the person turned down are off the table for this read.
            ...(rejectedNames.length ? { rejectedNames } : {}),
          });
          // A re-run is exactly when someone looks at a row that was filed as a
          // thing, sees it is a receipt, and presses the button. It has to reach
          // the receipt parser like a fresh scan does, or the only way out of a
          // wrongly-filed receipt is to delete it and photograph it again.
          if (outcome === "is-receipt") {
            const routed = await routeScannedReceiptPhoto({
              orgId: ctx.org.id,
              itemId: id,
              fileId: imageFileId,
              userId: uid,
            });
            if (routed.routed) {
              res.json({ ok: true, receipt: true, items: routed.items });
              return;
            }
            // Could not read it after all: fall through, so the row keeps the
            // ordinary re-run behaviour rather than being left half-done.
          }
          // Identity actually (re)landed → let the wires react. A queued
          // identify raises the event when its answer lands (hosted-identify-job.ts).
          if (outcome !== "identify-queued") void platform().events.emit("core-scan.scan.enriched", { orgId: ctx.org.id, itemId: id });
        }
        await matchItem({
          orgId: ctx.org.id,
          userId: sessionUser(req)?.id ?? null,
          orgSlug: ctx.org.slug,
          token,
          baseUrl,
          itemId: id,
          force: true,
          replay,
        });
      })().catch((err) => {
        console.error("[core-scan] photo rerun-ai work failed:", (err as Error)?.message ?? err);
      });
      res.json(await served(req, row));
      return;
    }

    // "Replay" on a BARCODE item must keep the button's promise: no model call,
    // no tokens. This branch used to ignore no_ai entirely — it cache-deleted,
    // force-re-asked the catalogs (whose tails call vision/web AI), and ran the
    // matchmaker live, so a "free replay" burned real tokens and lit every AI
    // spinner. Under replay: identity stays as stored, and only the ROUTING
    // re-runs below — the row's own candidates back through the CURRENT
    // refinement, no cache read and no degrade path.
    const replayBarcode = !!rerun?.no_ai;
    const baseUrl =
      (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    if (!replayBarcode) {
    // Bypass the cache by clearing the cache row for this UPC.
    try {
      await db
        .deleteFrom("core_scan_barcode_cache")
        .where("upc", "=", row.barcode_text)
        .execute();
    } catch {
      /* non-fatal */
    }

    await enrichBarcodeItem({
      db,
      orgId: ctx.org.id,
      itemId: id,
      orgSlug: ctx.org.slug,
      bearer: token,
      baseUrl,
      // Non-null here: this branch runs only when the row HAD a barcode, or a
      // corrected one was just written onto it above.
      upc: row.barcode_text ?? correctedBarcode!,
      // Rerun means RE-ASK: skip the tenant AND shared caches (deleting
      // only the tenant row left the shared cache answering with the
      // stale result — the box resolver was never consulted again).
      force: true,
      // "This is wrong" → web-identify + write the correction back to BIdb;
      // "needs detail" → keep identity, fill it in. Either way fold in the note.
      wrong: rerun?.wrong,
      enrich: rerun?.enrich,
      hint: modelHint ?? undefined,
      hints: modelHints,
    });

    // Stamp the user's hint AFTER enrichment, so the matchmaker sees it as
    // user_hint. (It has to come after because the enrich passes CLEAR the
    // identify-owned keys, and user_hint is one of them — an identify that
    // re-reads the item is entitled to drop the correction it just consumed.)
    // A merge, not a read-and-rewrite: the enrich above spawns DETACHED work
    // (crossCheckScanPhoto, refreshCatalogImageByName, enrichThinHit), any of
    // which can land between a SELECT here and its UPDATE.
    const hint = effectiveHint ?? undefined;
    if (hint) {
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          suggested_metadata: mergeMeta({ user_hint: hint }) as never,
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
    }
    }

    // Rerun = re-ask everything: the match runs INLINE so the response
    // already carries the re-ranked candidates + reconciliation notes
    // (the web's spinner spans this await — honest end-to-end).
    await matchItem({
      orgId: ctx.org.id, userId: sessionUser(req)?.id ?? null,
      orgSlug: ctx.org.slug,
      token,
      baseUrl,
      itemId: id,
      force: true,
      replay: replayBarcode,
    });

    const fresh = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    res.json(await served(req, fresh));
  }),
);

// ─────────────────── GET /inbox/:id/photo-options ───────────────────
// Alternative catalog photos: a DDG image search on the item's resolved
// name (the "OTHER PHOTO OPTIONS" strip). Read-only; picking one
// goes through POST /inbox/:id/catalog-image.

rerunRouter.get(
  "/inbox/:id/photo-options",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select([
        "suggested_name",
        "suggested_manufacturer",
        "barcode_text",
        "suggested_candidates",
        "suggested_metadata",
        "image_file_id",
      ])
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    if (!row) {
      res.json({ items: [] });
      return;
    }
    // THE derivation — the same one the ✨ Pick best button and the always-on
    // wire use (deriveRankContext). This endpoint used to carry its own copy,
    // which is how the strip and the ranker could disagree about the very same
    // row. The colour it resolves now includes the user's research hint, so
    // hinting "color: blue" actually reaches the search phrase.
    const rank = await deriveRankContext(tenantContext(req).org.id, row, {
      queryOverride: typeof req.query.q === "string" ? req.query.q : null,
      withReference: false, // the strip never sends images to a model
    });
    if (!rank.query) {
      res.json({ items: [] });
      return;
    }
    // The same ladder the catalog tile climbs (services/picture-options.ts):
    // ranked by catalog quality, the library first for a fresh thing and
    // beside the engine otherwise, and the engine's refusal reported so the
    // card can say "not answering" rather than "nothing found".
    const { items, throttled } = await pictureOptions({
      query: rank.query,
      name: rank.name,
      brand: rank.brand,
      color: rank.color,
      fresh: isFreshCategory(rank.category),
    });
    res.json({ items, query: rank.query, color: rank.color, throttled });
  }),
);

// ────────────── GET/PUT /photo-rank-config (the always-on opt-in) ──────────────
// The workspace switch for ranking catalog photos automatically on every
// enriched scan, instead of only when someone presses ✨ Pick best (AI). OFF
// unless turned on: no row means off, so a workspace that never opts in never
// spends a vision call (and needs no backfill). Reading is member-level (the
// scan UI shows the state); flipping it commits the workspace to per-scan AI
// spend, so it is owner/admin.

// AI-REACH: exempt — a workspace SPEND setting. Letting the assistant flip a
// switch that starts paying per scan is the wrong hand on that lever; a human
// owner/admin turns it on in the scan UI.
rerunRouter.get(
  "/photo-rank-config",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    res.json({ enabled: await readPhotoRankEnabled(tenantDb(req)) });
  }),
);

const PhotoRankConfigBody = z.object({ enabled: z.boolean() });

// AI-REACH: exempt — see the GET above (a workspace spend setting, human-only).
rerunRouter.put(
  "/photo-rank-config",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = PhotoRankConfigBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    await writePhotoRankEnabled(tenantDb(req), parsed.data.enabled);
    res.json({ enabled: parsed.data.enabled });
  }),
);

// The workspace switch for the FIRST LOOK: a fast, cheap read on every photo
// scan that lets the camera ask "we think it's X, is that right?" while the
// full read runs. OFF unless turned on: no row means off, so a workspace that
// never opts in never spends the extra call. Reading is member-level; flipping
// it commits the workspace to per-photo AI spend, so it is owner/admin.

// AI-REACH: exempt — a workspace SPEND setting, human-only (see photo-rank-config).
rerunRouter.get(
  "/glance-config",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    res.json({ enabled: await readGlanceEnabled(tenantDb(req)) });
  }),
);

const GlanceConfigBody = z.object({ enabled: z.boolean() });

// AI-REACH: exempt — see the GET above.
rerunRouter.put(
  "/glance-config",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin")) return;
    const parsed = GlanceConfigBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    await writeGlanceEnabled(tenantDb(req), parsed.data.enabled);
    res.json({ enabled: parsed.data.enabled });
  }),
);

// ─────────────────── POST /inbox/:id/glance-answer ─────────────────
// The person answered the first look. "yes" settles the name at once and runs
// the full read as an ELABORATION of it; "no" runs the full read with the
// guess as a hard negative plus whatever they typed. Whoever claims the answer
// runs the read - this endpoint, or the detached handler on timeout - so a
// tap and a timeout can never both spend a read (services/glance.ts).
//
// On a BARCODE card the guess is the catalog entry itself: "yes" is recorded
// and nothing re-runs; "no" is the existing wrong-flag path, which re-resolves
// across every source and writes the correction back to the barcode database.
const GlanceAnswerBody = z.object({
  answer: z.enum(["yes", "no"]),
  hint: optionalField(z.string().trim().max(500)),
});

// AI-REACH: exempt — a yes/no a person taps with the item in their hand, about a photo only they can see; the assistant reaches the inbox through list_scan_inbox and corrects a name through rerun-ai
rerunRouter.post(
  "/inbox/:id/glance-answer",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
    const parsed = GlanceAnswerBody.safeParse(req.body ?? {});
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    const meta = (row.suggested_metadata ?? {}) as Record<string, unknown>;
    const { answer, hint } = parsed.data;
    if (!(row.barcode_text && answer === "no")) {
      const action = answer === "yes" ? "confirm-guess" : "reject-guess";
      await appendScanHistory(db, id, { action, revision: await recordRevision(db, id, action), note: hint ?? null });
    }

    // A barcode card: the guess IS the catalog entry. "No" is the existing
    // wrong-flag path (POST rerun-ai {wrong:true}), which the client calls
    // directly so there is exactly one code path that re-resolves and reports
    // a correction; this endpoint only knows how to say so.
    if (row.barcode_text) {
      if (answer === "no") {
        res.status(400).json({
          error: { code: "use_rerun_wrong", message: "A barcode's guess is corrected through rerun-ai with wrong: true." },
        });
        return;
      }
      await db
        .updateTable("core_scan_inbox_items")
        .set({ suggested_metadata: mergeMeta({ guess_confirmed: true }) as never, updated_at: new Date() })
        .where("id", "=", id)
        .execute();
      const fresh = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      res.json(await served(req, fresh));
      return;
    }

    const glance = meta.glance as { name: string; category: string | null } | undefined;
    if (!glance) {
      res.status(409).json({ error: { code: "no_glance", message: "This item has no first look to answer." } });
      return;
    }
    if (!(await claimGlanceAnswer(db, id, answer, hint ?? null))) {
      // Already answered, or the window closed and the read is running.
      const fresh = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      res.json(await served(req, fresh));
      return;
    }
    if (answer === "yes") {
      // The name is settled NOW - the card should not wait on the elaboration
      // to show what the person just agreed to.
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          suggested_name: glance.name,
          ...(glance.category ? { suggested_metadata: mergeMeta({ category: glance.category }) as never } : {}),
          updated_at: new Date(),
        })
        .where("id", "=", id)
        .execute();
    }
    const readCtx = readContextFor({ ...meta, glance_answer: answer, ...(hint ? { glance_hint: hint } : {}) });
    // Detached, like the wire's own read: the response is the row with the
    // answer on it, and the elaboration lands when it lands.
    // DETACHED: the elaboration of a glance; the answer is on the row already
    void (async () => {
      try {
        const outcome = await enrichPhotoItem({
          db: (await platform().tenants.getDb(ctx.org.id)) as unknown as ReturnType<typeof tenantDb>,
          orgId: ctx.org.id,
          itemId: id,
          imageFileId: row.image_file_id!,
          userId: sessionUser(req)?.id ?? null,
          force: true,
          ...readCtx,
        });
        if (outcome !== "is-receipt" && outcome !== "identify-queued") void platform().events.emit("core-scan.scan.enriched", { orgId: ctx.org.id, itemId: id });
      } catch (err) {
        console.error("[core-scan] read after first-look answer failed:", (err as Error).message);
      }
    })();
    const fresh = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    res.json(await served(req, fresh));
  }),
);

// ─────────────────── POST /inbox/:id/rank-photo-ai ───────────────────
// The "✨ Pick best (AI)" upgrade over the heuristic strip: a vision model looks
// at the SAME candidate pool and picks the cleanest CATALOG shot — product
// alone, correct colour, no people — the two things a title can't reveal. The
// heuristic ranking is still the floor and the order; this only re-picks among
// the top few by the pixels. Read-only: it returns the chosen URL + reason; the
// client applies it through POST /inbox/:id/catalog-image (one apply surface).
// The strip SENDS the candidates it is displaying (plus any applied search
// term), and the model ranks exactly those — so the pick is always one of the
// tiles the user is looking at, the ✨ badge always lands on a visible tile, and
// no second DDG search (nondeterministic, rate-limited) can hand the AI a
// different pool than the one on screen. Server-search remains the fallback for
// a caller that sends none. Each URL is SSRF-guarded at fetch time
// (fetchImageBase64), the same trust level as POST /catalog-image's url.
const RankPhotoBody = z.object({
  q: optionalText(200),
  candidates: z
    .array(
      z.object({
        url: z.string().url().max(2000),
        thumb: optionalText(2000),
        title: optionalText(300),
        source: z.string().max(200).optional(), // none-refused-ok: a column that cannot hold null
        width: optionalField(z.number().int().positive()),
        height: optionalField(z.number().int().positive()),
      }),
    )
    .max(24)
    .optional(),
});

// AI-REACH: exempt — UI-only triage helper (the ✨ Pick best button). It itself
// calls core-ai to rank photos, so exposing it to Cobb would be circular; and
// choosing a DISPLAY photo is a human aesthetic call, not an assistant task
// (Cobb already identifies items via identify-image).
rerunRouter.post(
  "/inbox/:id/rank-photo-ai",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id ?? "";
    const parsedBody = RankPhotoBody.safeParse(req.body ?? {});
    if (!parsedBody.success) return badBody(res, parsedBody.error);
    const db = tenantDb(req);
    const orgId = tenantContext(req).org.id;
    const userId = sessionUser(req)?.id ?? null;
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select(["suggested_name", "suggested_manufacturer", "suggested_candidates", "suggested_metadata", "image_file_id"])
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }

    // ONE derivation for every rank surface (the button here + the always-on
    // wire): the image query, the declared colour, the identify's category, and
    // the user's photo as a colour reference. See services/auto-rank.ts.
    const rank = await deriveRankContext(orgId, row, { queryOverride: parsedBody.data.q ?? null });
    if (!rank.query) {
      res.json({ chosen_url: null, reason: "This item needs a name before photos can be ranked." });
      return;
    }
    const q = rank.query;
    const color = rank.color;

    // Rank the pool the user is LOOKING at when the client sent it; fall back to
    // a fresh search only when it didn't (an API caller, an empty strip).
    const sent = (parsedBody.data.candidates ?? []).map((c) => ({
      url: c.url,
      thumb: c.thumb ?? "",
      title: c.title ?? "",
      source: c.source ?? "",
      width: c.width ?? undefined,
      height: c.height ?? undefined,
    }));
    const pool =
      sent.length > 0
        ? sent
        : (await pictureOptions({ query: q, name: rank.name, brand: rank.brand, color, fresh: isFreshCategory(rank.category), limit: 24 })).items;
    // Hand the AI the best-of-the-good: dedupe + hard-drop net-negatives (when
    // enough good ones remain), so it selects the best of N good candidates
    // rather than rescuing junk. The heuristic filters as far as titles/domains
    // allow; the AI does the pixel calls.
    // The AI chooses only among pictures that do not contradict the item's own
    // colour or material (picture-agrees.ts): a person can still pick any of
    // them by hand, but "Pick best" never hands back one the words rule out.
    const agreeing = picturesThatAgree(looksOfRow(row, rank.name ?? row.suggested_name), pool);
    if (pool.length > 0 && agreeing.length === 0) {
      res.json({ chosen_url: null, reason: "Every picture here shows a different colour or material from this item. Search again, or choose one yourself." });
      return;
    }
    const candidates = selectTopCandidates(agreeing, row.suggested_manufacturer, q, IMAGE_BUDGET, color);
    if (candidates.length === 0) {
      res.json({ chosen_url: null, reason: "No photo options were found to rank." });
      return;
    }

    const result = await rankPhotoWithAi({
      orgId,
      userId,
      itemId: id,
      itemName: rank.name ?? q,
      brand: rank.brand,
      knownColor: color,
      category: rank.category,
      referenceB64: rank.referenceB64,
      referenceMediaType: rank.referenceMediaType,
      candidates,
    });
    // Each failure means something DIFFERENT the user can act on, so say which.
    // The old single catch-all ("no vision provider is configured, or the
    // candidates couldn't be read") told someone whose provider was fine to go
    // check their provider (reported 2026-07-30).
    if (isRankFailure(result)) {
      res.json({ chosen_url: null, reason: rankFailureSentence(result), error: result.error, ...(result.aiReason ? { ai_reason: result.aiReason } : {}) });
      return;
    }
    res.json({
      chosen_url: result.chosenUrl,
      reason: result.reason,
      color_seen: result.colorSeen,
      ranked_over: result.rankedOver,
    });
  }),
);

// ─────────────────── POST /inbox/:id/catalog-image ──────────────────
// Set the item's catalog image from a picked URL (photo-options strip or
// a pasted URL). Downloads into core-files so the image survives the
// external host; the URL is SSRF-guarded inside downloadCatalogImage.

// Pick a URL (photo-options strip / pasted), REVERT to the original catalog
// image, or USE the user's own scan photo as the catalog image. The first
// override stashes the original refs in suggested_metadata.orig_catalog so a
// revert can restore them (server-side → survives reload, unlike a client ref).
const CatalogImageBody = z.union([
  // `ai_pick` marks an apply that came from "✨ Pick best (AI)". The ranker is
  // read-only and applies through THIS endpoint, so without the flag its choice
  // is indistinguishable from a hand-pick — and Revert would restore the raw
  // first web result, throwing the AI's judgement away (reported 2026-08-11).
  z.object({
    url: z.string().url().max(2000),
    ai_pick: z.boolean().optional(),
    /** The search result's own THUMBNAIL, used only if `url` cannot be fetched.
     *  A picture visible in the strip is proof that SOME url for it works: the
     *  strip renders the thumbnail while the pick sends the full-size original,
     *  and plenty of sites serve the first and hotlink-block the second. Being
     *  told "that image couldn't be used" about a picture on screen is the
     *  report this answers (2026-08-14). Lower resolution, and far better than
     *  refusing the pick. */
    thumb_url: z.string().url().max(2000).optional(),
  }),
  z.object({ action: z.enum(["revert", "use_own_photo", "use_screenshot_crop"]) }),
  // "Take a nice picture" — a freshly-captured upload becomes the DISPLAY
  // (catalog) image; the identify photo is untouched (photo roles).
  z.object({ file_id: z.string().uuid() }),
  // CROP MY OWN PHOTO into the catalog image.
  //
  // The photo you took is often the most accurate picture of the thing - it is
  // literally the object, in the condition you are filing it in - but it is
  // rarely FRAMED like a catalog shot. A marketplace listing screenshot is the
  // clearest case: the product fills the top third and the rest is app chrome
  // (price, "Message seller", the description). Cropping to the product beats
  // anything a web search returns for that item, and costs no AI call and no
  // network (reported 2026-08-11: "it's right there and it's accurate, why rely
  // on something from the internet?").
  //
  // The box is FRACTIONS of the source, the same shape the split feature's
  // vision segmentation produces, so both paths share cropRegion() rather than
  // growing a second cropper.
  z.object({
    crop: z.object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().min(0.02).max(1),
      h: z.number().min(0.02).max(1),
    }),
    /** "group": cut the split child's GROUP shot again into its own picture
     *  (#3046). Absent: cut the row's own photo into its catalog picture. */
    source: z.enum(["own", "group"]).optional(),
  }),
]);

// AI-REACH: exempt — downloads an image from an address into the workspace;
// a chat must not choose what the server fetches. The assistant picks a
// catalog photo through core-scan:rank-catalog-photo
rerunRouter.post(
  "/inbox/:id/catalog-image",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    const parsed = CatalogImageBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
    const db = tenantDb(req);
    const ctx = tenantContext(req);
    const token = bearer(req);
    if (!token) {
      res.status(401).json({ error: { code: "no_auth", message: "Bearer token required" } });
      return;
    }
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .select([
        "id",
        "barcode_text",
        "catalog_image_url",
        "catalog_image_file_id",
        "image_file_id",
        "suggested_metadata",
        // Half of a receipt line's identity, for remembering the picture the
        // user chose (the other half, the shop, is in the metadata).
        "suggested_name",
      ])
      .where("id", "=", id ?? "")
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    const baseMeta = (row.suggested_metadata ?? {}) as Record<string, unknown> & {
      orig_catalog?: OrigCatalog;
      catalog_history?: CatalogStep[];
      catalog_source?: CatalogSource;
    };
    // Revert is UNDO, so the images form a STACK, not a single stashed original.
    //
    // A real item goes: the blind first web result -> maybe the AI's pick -> maybe
    // one you chose yourself. Keeping only `orig_catalog` (captured once, on the
    // first override) meant one press jumped all the way to the bottom, skipping
    // the AI's judgement — which is the whole reason the ranker exists. Each apply
    // now PUSHES the image it replaces; each revert POPS one (reported 2026-08-11:
    // "it should act like undo and go back to the prior pick, so I should be able
    // to click it multiple times").
    const history = seedHistory(baseMeta.catalog_history, baseMeta.orig_catalog);
    // The keys the catalog-image override OWNS: the user-set lock, the undo stack,
    // and what the CURRENT image came from (so the next push can label it).
    // Merged, not full-replaced — this write shares suggested_metadata with a dozen
    // other passes and used to drop all of theirs.
    const catalogSet = (source: CatalogSource) => catalogMetaSet(row, source);
    const fresh = () =>
      db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", row.id).executeTakeFirstOrThrow();

    if ("action" in parsed.data && parsed.data.action === "revert") {
      // POP one step. Nothing to undo → say so rather than blanking the image,
      // which is what restoring an empty stash used to do.
      const { restore: prev, rest, atBottom } = popStep(history);
      if (!prev) {
        res.status(409).json({
          error: { code: "no_history", message: "There's no earlier catalog photo to go back to." },
        });
        return;
      }
      if (!atBottom) {
        // Still standing on a chosen image → keep the lock and the remaining
        // stack, so pressing again keeps walking back.
        await db
          .updateTable("core_scan_inbox_items")
          .set({
            catalog_image_url: prev.url,
            catalog_image_file_id: prev.file_id,
            suggested_metadata: mergeMeta({
              catalog_history: rest,
              catalog_source: prev.source ?? "web",
            }) as never,
            updated_at: new Date(),
          })
          .where("id", "=", row.id)
          .execute();
        res.json(await served(req, await fresh()));
        return;
      }
      // Back at the bottom — the auto image. That relinquishes the user's pick →
      // drop the `catalog_image_user_set` lock (so a future re-identify can
      // refresh it) along with the now-empty stack. DB-side delete, so no OTHER
      // writer's key goes with them — which is what the whole-snapshot rewrite
      // here used to do.
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          catalog_image_url: prev.url,
          catalog_image_file_id: prev.file_id,
          suggested_metadata: mergeMeta({}, [
            "orig_catalog",
            "catalog_image_user_set",
            "catalog_history",
            "catalog_source",
          ]) as never,
          updated_at: new Date(),
        })
        .where("id", "=", row.id)
        .execute();
      res.json(await served(req, await fresh()));
      return;
    }

    if ("action" in parsed.data && parsed.data.action === "use_own_photo") {
      if (!row.image_file_id) {
        res.status(400).json({ error: { code: "no_photo", message: "This item has no photo of yours to use." } });
        return;
      }
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          catalog_image_file_id: row.image_file_id,
          catalog_image_url: null,
          // The user chose this image → lock it so a later re-identify won't clobber it,
          // and push what it replaced so Revert can undo back to it.
          suggested_metadata: mergeMeta(catalogSet("yours")) as never,
          updated_at: new Date(),
        })
        .where("id", "=", row.id)
        .execute();
      res.json(await served(req, await fresh()));
      return;
    }

    // Back to the crop the enrich took out of a screenshot. It is already a
    // stored file, so this re-points at it rather than cropping again — and it
    // exists because a screenshot's crop is a picture of the ACTUAL item, which
    // stays worth returning to after a detour through the web results.
    if ("action" in parsed.data && parsed.data.action === "use_screenshot_crop") {
      const cropId = (row.suggested_metadata as { screenshot_crop_file_id?: string } | null)?.screenshot_crop_file_id;
      if (!cropId) {
        res.status(400).json({
          error: { code: "no_crop", message: "This item has no screenshot crop to use." },
        });
        return;
      }
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          catalog_image_file_id: cropId,
          catalog_image_url: null,
          suggested_metadata: mergeMeta(catalogSet("crop")) as never,
          updated_at: new Date(),
        })
        .where("id", "=", row.id)
        .execute();
      res.json(await served(req, await fresh()));
      return;
    }

    // A CROP of the user's own photo → the display/catalog image.
    // Crops the IDENTIFY photo (image_file_id), never the current catalog image,
    // so cropping twice always starts from the original rather than compounding
    // a crop of a crop. cropRegion writes a new file and leaves the source
    // untouched, so the identify photo (and anything already pointing at it)
    // is unaffected.
    if ("crop" in parsed.data) {
      // "Crop again" on a split child (#3046): the source is the GROUP shot
      // (the parent's photo) and the cut becomes the child's OWN picture, the
      // way the split first cut it; the catalog picture is untouched.
      if (parsed.data.source === "group") {
        const from = (row.suggested_metadata as { split_from?: string } | null)?.split_from;
        const parent = from
          ? await db.selectFrom("core_scan_inbox_items").select("image_file_id").where("id", "=", from).executeTakeFirst()
          : null;
        if (!parent?.image_file_id) {
          res.status(400).json({ error: { code: "no_group_photo", message: "This item was not cut from a group photo, or that photo is gone." } });
          return;
        }
        const cut = await cropRegion(ctx.org.id, parent.image_file_id, parsed.data.crop);
        if (cut.fileId === null) {
          res.status(422).json({
            error: { code: "crop_failed", message: `That photo couldn't be cropped (${cropRefusalWords(cut.reason)}). Try a different region.`, reason: cut.reason },
          });
          return;
        }
        const revision = await recordRevision(db, row.id, "crop-again");
        await db
          .updateTable("core_scan_inbox_items")
          .set({
            image_file_id: cut.fileId,
            suggested_metadata: mergeMeta({ crop: "ok", split_region: parsed.data.crop, crop_by: "person" }, ["crop_reason"]) as never,
            updated_at: new Date(),
          })
          .where("id", "=", row.id)
          .execute();
        await appendScanHistory(db, row.id, { action: "crop-again", revision, note: "cut again from the group photo" });
        res.json(await served(req, await fresh()));
        return;
      }
      if (!row.image_file_id) {
        res.status(400).json({ error: { code: "no_photo", message: "This item has no photo of yours to crop." } });
        return;
      }
      const cut = await cropRegion(ctx.org.id, row.image_file_id, parsed.data.crop);
      if (cut.fileId === null) {
        res.status(422).json({
          error: { code: "crop_failed", message: `That photo couldn't be cropped (${cropRefusalWords(cut.reason)}). Try a different region.`, reason: cut.reason },
        });
        return;
      }
      const croppedId = cut.fileId;
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          catalog_image_file_id: croppedId,
          catalog_image_url: null,
          suggested_metadata: mergeMeta(catalogSet("crop")) as never,
          updated_at: new Date(),
        })
        .where("id", "=", row.id)
        .execute();
      res.json(await served(req, await fresh()));
      return;
    }

    // A freshly-captured upload → the display/catalog image (retake-for-catalog).
    if ("file_id" in parsed.data) {
      await db
        .updateTable("core_scan_inbox_items")
        .set({
          catalog_image_file_id: parsed.data.file_id,
          catalog_image_url: null,
          // The user chose this image → lock it so a re-identify won't clobber it,
          // and push what it replaced so Revert can undo back to it.
          // The photo they said they would take has arrived, so the standing
          // "I'll photograph this" is answered. Cleared HERE rather than in the
          // client so it closes the same way from the card, the scanner queue
          // and a deep link.
          suggested_metadata: mergeMeta(catalogSet("upload"), ["photo_wanted"]) as never,
          updated_at: new Date(),
        })
        .where("id", "=", row.id)
        .execute();
      const saved = await fresh();
      // A photo somebody deliberately took is EVIDENCE, not just decoration.
      // Until now this endpoint only swapped the display picture, so the one
      // gesture people reach for when a name looks wrong ("here, look at the
      // actual thing") was the one gesture that could not affect the name
      // (reported 2026-08-14).
      //
      // The gesture is genuinely ambiguous — a right name with a poor picture
      // and a wrong name with proof attached press the same button — so it is
      // not asked to choose. The picture always becomes the display image, and
      // the check runs behind it:
      //   • no name yet  → nothing to protect; the photo names the item.
      //   • already named → flagOnly, so a disagreement is OFFERED with its
      //     one-tap fix rather than performed. A silent rename of something
      //     you were happy with is the failure that started this list.
      // A junk placeholder ("Robot Check", the bare digits) counts as unnamed:
      // offering a correction against it can only produce a flag the user must
      // tap, when the identify path would have written the name outright.
      const named =
        saved.suggested_name && !isJunkName(saved.suggested_name) ? saved.suggested_name : null;
      if (addedPhotoIntent(!!named) === "offer-correction" && named) {
        // DETACHED: a cross-check of the added photo; it can only flag the row later
        void crossCheckScanPhoto(ctx.org.id, row.id, named, {
          fileId: parsed.data.file_id,
          flagOnly: true,
        }).catch((e) => console.error("[core-scan] added-photo cross-check threw:", (e as Error).message));
      } else {
        // DETACHED: reading the added photo; the row updates when this lands
        void enrichPhotoItem({
          db,
          orgId: ctx.org.id,
          itemId: row.id,
          imageFileId: parsed.data.file_id,
          userId: sessionUser(req).id,
          visitorIp: req.ip ?? null,
        }).catch((e) =>
          console.error("[core-scan] added-photo identify threw:", (e as Error).message),
        );
      }
      res.json(await served(req, saved));
      return;
    }

    // A picked/pasted URL: DOWNLOAD FIRST, then commit. Lots of web-search image
    // URLs can't actually be used (hotlink-block/403, 404, a non-image, too big),
    // and downloadCatalogImage returns false for those. If we committed the url +
    // lock first (as this used to) and ignored that false, the item kept a broken
    // catalog_image_url and the client still got a 200 → a "Catalog photo updated"
    // toast that was a lie (reported 2026-07-24). So only mutate the row on a real
    // download; otherwise leave the previous image and 422 so the UI says so.
    const url = (parsed.data as { url: string }).url;
    const isAiPick = (parsed.data as { ai_pick?: boolean }).ai_pick === true;
    const thumbUrl = (parsed.data as { thumb_url?: string }).thumb_url;
    let stored = await downloadCatalogImage({ db, orgId: ctx.org.id, itemId: row.id }, url);
    // The full-size original is frequently hotlink-blocked while the thumbnail
    // the user is looking at is not. Take the smaller picture over none.
    if (!stored && thumbUrl && thumbUrl !== url) {
      stored = await downloadCatalogImage({ db, orgId: ctx.org.id, itemId: row.id }, thumbUrl);
    }
    if (!stored) {
      res.status(422).json({
        error: {
          code: "image_unusable",
          message: `${COULDNT_SAVE_WORDS}: the site would not give Cobblr the picture to keep. Try another.`,
        },
      });
      return;
    }
    // Download stored catalog_image_file_id already. Record the source url, lock
    // the pick, and push the image it replaced onto the undo stack. The AI's pick
    // is labelled as such so Revert's button can name what it lands on.
    await db
      .updateTable("core_scan_inbox_items")
      .set({
        catalog_image_url: url,
        suggested_metadata: mergeMeta(catalogSet(isAiPick ? "ai" : "pick")) as never,
        updated_at: new Date(),
      })
      .where("id", "=", row.id)
      .execute();
    // Picking a better catalog photo for a BARCODE item is the truth — feed it
    // back to the shared Barcode Intelligence DB as an image_url correction, so
    // the next scan of this UPC (any workspace) gets YOUR clean image, beating
    // whatever Open Food Facts / a provider had (or filling a missing image).
    if (row.barcode_text) {
      // DETACHED: a correction sent to the shared barcode database; the picture is saved without it
      void reportBarcodeCorrection({
        upc: row.barcode_text,
        field: "image_url",
        was: row.catalog_image_url,
        now: url,
        userId: sessionUser(req).id,
        lots: unitLotsOf(row.suggested_metadata),
      });
    } else if (!isAiPick) {
      // No barcode - a receipt line. The shop and the line's name are the
      // identity it does have, and a person choosing the picture is the same
      // truth the UPC path feeds back. Not an AI pick: the machine's own guess
      // must not become everyone's answer, which is the whole difference
      // between this and the search it is correcting.
      const meta = (row.suggested_metadata ?? {}) as { receipt_vendor?: string };
      // DETACHED: remembering a picked picture for next time; the pick is saved without it
      void rememberPickedImage(ctx.org.id, meta.receipt_vendor ?? null, row.suggested_name, url).catch(
        (e) => console.warn("[core-scan] picked-image remember failed:", (e as Error).message),
      );
    }
    res.json(await served(req, await fresh()));
  }),
);

// ─────────────────── POST /inbox/:id/undo-rerun ─────────────────────
// Put back the answer the last re-run overwrote. The re-run snapshots the row's
// identity into `metadata.pre_rerun` before it starts (see rerun-ai), so this is
// a straight restore of name / brand / sku / category / candidates / notes /
// catalog image. Refuses when there's no snapshot rather than inventing one.
//
// Why this exists: a re-run is a gamble the user can lose. Vision re-read a dark
// photo of a Hercules tool tote as a "Portable Bluetooth Speaker" and the good
// name was simply gone (reported 2026-07-17) — recoverable only by reading the raw
// AI call log by hand. The undo is the guardrail for that whole class: any pass
// allowed to replace a good answer must be reversible.
/** The scalar columns an undo restores from a `pre_rerun` snapshot. Exported so
 *  the restore mapping is unit-tested against the REAL code rather than a copy of
 *  it (a mirrored test drifts and stops guarding). A blank/absent value restores
 *  NULL, never the string "null". */
export function preRerunRestore(snap: Record<string, unknown>): {
  suggested_name: string | null;
  suggested_manufacturer: string | null;
  suggested_sku: string | null;
  ai_notes: string | null;
  catalog_image_url: string | null;
  catalog_image_file_id: string | null;
  suggested_candidates: unknown[];
} {
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    suggested_name: str(snap.name),
    suggested_manufacturer: str(snap.manufacturer),
    suggested_sku: str(snap.sku),
    ai_notes: str(snap.ai_notes),
    catalog_image_url: str(snap.catalog_image_url),
    catalog_image_file_id: str(snap.catalog_image_file_id),
    suggested_candidates: Array.isArray(snap.candidates) ? snap.candidates : [],
  };
}

// AI-TOOL: put_back_scan_item
rerunRouter.post(
  "/inbox/:id/undo-rerun",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = String(req.params.id);
    const db = tenantDb(req);
    const row = await db
      .selectFrom("core_scan_inbox_items")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    const snap = (row.suggested_metadata as { pre_rerun?: Record<string, unknown> } | null)?.pre_rerun;
    if (!snap) {
      res.status(422).json({
        error: {
          code: "nothing_to_undo",
          message: "This item has no previous lookup to go back to.",
        },
      });
      return;
    }
    // A run since #6100 recorded the whole row first: put that back, every
    // field the run changed, the barcode and the pictures included.
    if (typeof snap.revision === "string") {
      const back = await restoreRevision(db, id, snap.revision, "undo-rerun");
      if (back) {
        if (back.needsMatch) finishPutBackMatch(req, id);
        res.json(await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirstOrThrow());
        return;
      }
    }
    // An older snapshot (or one whose revision was pruned) holds the identity
    // only. It replaces the identity keys it owns; every other key on the row
    // (tags, hints, box state, the photo) is the USER's and survives the undo.
    // pre_rerun is dropped so undo can't be double-applied against a stale twin.
    const revision = await recordRevision(db, id, "undo-rerun");
    const cols = preRerunRestore(snap);
    const restored = await db
      .updateTable("core_scan_inbox_items")
      .set({
        ...cols,
        suggested_candidates: JSON.stringify(cols.suggested_candidates) as never,
        suggested_metadata: sql`(coalesce(suggested_metadata, '{}'::jsonb) - 'pre_rerun' - 'match_failed')
          || ${JSON.stringify({
            ...(snap.category != null ? { category: snap.category } : {}),
            ...(snap.entity_type != null ? { entity_type: snap.entity_type } : {}),
            // Restore the LOCK with the picture. An undo that hands back a
            // hand-picked catalog photo without its protected status leaves it
            // one enrichment away from being overwritten again - the picture is
            // back but the CHOICE is not.
            ...(snap.catalog_image_file_id || snap.catalog_image_url
              ? { catalog_image_user_set: true }
              : {}),
          })}::jsonb` as never,
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    await appendScanHistory(db, id, {
      action: "undo-rerun",
      revision,
      note: cols.suggested_name ? `back to "${cols.suggested_name}"` : undefined,
    });
    res.json(restored);
  }),
);

/** A row put back as it stood before its match finished is matched now, by
 *  replay: routing only, no model asked, the way Replay does it. Nothing else
 *  is left running to finish it, and a put-back must never leave a row
 *  "finishing" forever (the 390 walk of #6100). Detached: the inbox poll
 *  shows the route when it lands. */
function finishPutBackMatch(req: Request, itemId: string): void {
  const ctx = tenantContext(req);
  const token = bearer(req);
  if (!token) return;
  void matchItem({
    orgId: ctx.org.id,
    userId: sessionUser(req)?.id ?? null,
    orgSlug: ctx.org.slug,
    token,
    baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
    itemId,
    force: true,
    replay: true,
  }).catch((e: Error) => console.error("[core-scan] put-back match threw:", e.message));
}

// ─────────────── POST /inbox/:id/revisions/:rid/restore ───────────────
// "Put back" on a History entry, and Undo on the toast that announced the
// rewrite (#6100). Every rewrite records the row's fields before it starts and
// its History entry carries that revision's id; this writes them back. The
// put-back records the row as it is first, so it can be put back in turn. A
// filed row is refused: what it filed into is a record now, and Unfile is its
// way back.
// AI-TOOL: put_back_scan_item
rerunRouter.post(
  "/inbox/:id/revisions/:rid/restore",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = String(req.params.id);
    const rid = String(req.params.rid);
    const db = tenantDb(req);
    const row = await db.selectFrom("core_scan_inbox_items").select(["status"]).where("id", "=", id).executeTakeFirst();
    if (!row) {
      res.status(404).json({ error: { code: "not_found", message: "inbox item not found" } });
      return;
    }
    if (row.status !== "pending") {
      res.status(409).json({ error: { code: "filed", message: "This item is filed already. Unfile it first to put an earlier version back." } });
      return;
    }
    const back = /^[0-9a-f-]{36}$/i.test(rid) ? await restoreRevision(db, id, rid) : null;
    if (!back) {
      res.status(404).json({ error: { code: "no_such_version", message: "That earlier version of this item is no longer kept." } });
      return;
    }
    if (back.needsMatch) finishPutBackMatch(req, id);
    const fresh = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    res.json(await served(req, fresh));
  }),
);
