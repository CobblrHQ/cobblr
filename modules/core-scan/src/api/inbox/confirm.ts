// Confirm: filing a scan into a table, or onto a bin.
// Split from api/inbox.ts by route group (#7385); inbox.ts mounts the groups in order.
import { Router } from "express";
import { finishOwnSend } from "../../services/offer-intake.js";
import { mapOfferedFields, type OfferedThing } from "@cobblr/platform-contract/share-offer";
import { canonicalColourFields, type ColourFieldDef } from "../../services/colour-fields.js";
import { choicesNamedIn, identifierFromScan, type FactFieldDef } from "../../services/scan-field-facts.js";
import { locationForPlaces, stripPlaceFields } from "../../services/place-fields.js";
import { lotFieldOf, lotPatchFor, yearMadeFieldOf, yearMadePatchFor } from "../../services/lot-field.js";
import { reportPackIfFiled } from "../../services/pack-network.js";
import { shareableProductFields } from "@cobblr/platform-contract/learned-route";
import { rowLots } from "../../services/row-lots.js";
import { rememberPickedImage } from "../../services/picked-images.js";
import { TITLE_VARIANTS_KEY, titleVariantsOf } from "@cobblr/platform-contract/display-identity";
import { candidatesWithUserFields } from "../../services/user-fields.js";
import { buildCadenceEvents } from "../../cadence-events.js";
import { resolveRequirement, storageRequirementFor } from "../../services/storage-requirement.js";
import { FILING_OWED_KEY, filingOwedOf, owedAfterRefusal, resumesOn } from "../../services/filing-owed.js";
import { moveQuantity, scanTargetOf, scanTargetsRegistered, startingCount } from "../../services/scan-target.js";
import { RAN_OUT_KEY, ranOut, type RanOutOutcome } from "../../services/ran-out.js";
import { applyAxisValue, clearAxisValue, readAxisValue, type AxisTarget } from "@cobblr/platform-contract/category-axis";
import { FiledQuantity, copiedCountOf, filedQuantityOf, isOwnCopy } from "../../services/filed-quantity.js";
import { expiryDefaults } from "../../services/shelf-life.js";
import { type Request } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { claimOrderLine } from "../../services/receipt-order.js";
import { mapRoledFacts, platform, roledFactsPatch, roledNativePatch, traitAxisValue } from "@cobblr/platform-contract";
import { entityKindOf } from "@cobblr/platform-contract/entity-kind";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { createCapabilityForModule } from "@cobblr/platform-contract/create-capability";
import { BundleInstaller, tableForFiling, type FilingCandidate } from "../../services/file-through-confirm.js";
import { scanPurpose, scanPurposeReview, FILED_INTO_KEY, type FiledInto } from "@cobblr/platform-contract/scan-triage";
import { nextBinName } from "@cobblr/platform-contract/scan-tools";
import { bearer, sessionUser, tenantContext, tenantDb } from "../../db.js";
import { type LiveTable } from "../../services/resolve-offers.js";
import { resolveNativeIdentity } from "../../native-identity.js";
import { asyncHandler, badBody, requireRole } from "../util.js";
import { downloadCatalogImage } from "../../services/enrich.js";
import { committedImagePath, commitThumbPath, itemPhotos } from "../../services/committed-image.js";
import { clampEntityName } from "../../services/item-name.js";
import { mergeMeta } from "../../services/metadata.js";
import { assembleMergedMenu } from "../../services/matchmaker.js";
import { unevidencedIdentifiers } from "@cobblr/platform-contract/scan-evidence";
import { scanFilingRefusal } from "@cobblr/platform-contract/scan-recovery";
import { reportBarcodeCorrection, reportLearnedRoute, reportLabelConfirm, meaningfullyChanged, originOfValue, unitLotsOf } from "../../services/barcode-corrections.js";
import { FIELD_PROVENANCE_KEY, acquisitionSourceConflict, fieldProvenanceOf, isAcquiredFromField, purchaseEvidenceOf, type FieldProvenanceMap } from "@cobblr/platform-contract/acquisition-source";
import { filingName, isBareCodeName } from "@cobblr/platform-contract/display-identity";
import { suggestLocationForItem } from "../../services/suggest-location.js";
import { receiptFacts, type ReceiptMeta } from "../../services/receipt-facts.js";
import { receiptRecord, type ReceiptLineMeta } from "../../services/receipt-record.js";
import { apiFetch } from "@cobblr/platform-contract/self-api";
import { optionalField, optionalText, optionalUuid } from "@cobblr/platform-contract/optional-fields";
import { bindToCatalogEntry } from "../../services/catalog-match.js";
import { wordsOf } from "../../services/open-facts-allergens.js";
import { INTERNAL_API, INTO_BIN, NEW_BIN, filedIntoFor, liveTablesFor, served, storedCandidateList, tableCategoryWord } from "./shared.js";

export const confirmRouter = Router({ mergeParams: true });

// ──────────────────────── POST /inbox/:id/confirm ──────────────────

/**
 * A confirmed category value joins the table's vocabulary.
 *
 * The taxonomy is not something the kernel ships or a model invents — it is the
 * list of categories the user has actually accepted. Growing it here, at the
 * moment of confirm, is what makes the next scan REUSE "Electrical" rather than
 * coin "Electrical Parts" beside it. (`resolveCategory` already snaps near-misses
 * onto an existing value; this is what gives it something to snap to.)
 *
 * A no-op for a table with no category axis, or a value already in the list.
 */
/** The confirmed category, through the seam (#3223).
 *
 *  The taxonomy grows from what a person actually confirms, never from what a
 *  model merely proposed: a brand-new value joins the vocabulary HERE, at the
 *  moment a human accepted it, so the next scan of an electrical part finds
 *  "Electrical" already there and reuses it instead of coining a synonym.
 *
 *  This used to list the kind's field defs and PATCH `choices` itself, which
 *  meant the scan pipeline knew where a category is STORED. It does not need
 *  to: `commit` grows the vocabulary and says what to write, `applyAxisValue`
 *  writes it, and neither answer changes for a kind whose module owns its own
 *  taxonomy. `commit` never throws and returns null when it cannot store the
 *  value, which is the same answer the old field-def PATCH gave when it came
 *  back non-ok: filing the thing matters more than filing it under a name. */
async function commitCategoryAxis(
  orgId: string,
  kind: string,
  instance: string | null,
  into: AxisTarget,
  /** The candidate's own `category`: the chosen NAME, which the matchmaker
   *  sets beside the field value (resolveCategoryInto writes both). It is the
   *  authoritative carrier — a kind whose module owns its taxonomy has no
   *  field key to put a name under, so after #3223 step 3 this is the only
   *  place the draft's choice survives. Fields first all the same, because a
   *  value there is a person's typed answer and beats a proposal. */
  proposed?: string | null,
  /** The category the person or the session chose, as a NAME (the body's
   *  `category`). A kind whose module owns its taxonomy has no field for the
   *  card to write a name into, so this is how a changed category, or a
   *  batch's agreed one, reaches it. Between the slot, which holds what a
   *  form set, and the proposal, which nobody chose. */
  chosenByName?: string | null,
): Promise<void> {
  const axis = await platform().categoryAxis.for({ orgId, kind, instance });
  // What the record's slot holds goes back through `keep`, never `commit`:
  // on a kind that keeps its own categories it is an id a form picked, and
  // only the slot knows that. A pick that no longer stands is emptied, and
  // the thing files under a name instead.
  const inSlot = readAxisValue(axis, into);
  if (inSlot) {
    const kept = await platform().categoryAxis.keep({ orgId, kind, value: inSlot, instance });
    if (kept) {
      applyAxisValue(kept, into);
      return;
    }
    clearAxisValue(axis, into);
  }
  const chosen =
    (typeof chosenByName === "string" ? chosenByName.trim() : "") ||
    (typeof proposed === "string" ? proposed.trim() : "");
  if (!chosen) return;
  applyAxisValue(await platform().categoryAxis.commit({ orgId, kind, value: chosen, instance }), into);
}

export const ConfirmBody = z.object({
  /** Optional — when absent, routed from the identify's asset/part hint
   *  (suggested_metadata.entity_type): asset → assets:asset, else
   *  inventory:part. Both must be given together to override. */
  target_module: optionalField(z.string().min(1).max(80)),
  target_kind: optionalField(z.string().min(1).max(80)),
  /** Name override. Falls back to suggested_name if absent. Accepts catalog
   *  length: provider titles are marketing copy (a real dimmer's is 206 chars)
   *  and the commit CLAMPS to the entity-name limit below - rejecting the
   *  whole commit because a catalog title is long turned "Add" into
   *  "bad request body" (reported 2026-08-03). */
  name: z.string().min(1).max(2000).optional(), // none-refused-ok: a column that cannot hold null
  location_id: optionalUuid(),
  /** File it inside a thing that holds things (a Backpack) rather than a
   *  place. Stamped on the item as its container, so the commit places the
   *  new record inside it, the way a scan into an active container does. */
  container: z.object({ kind: z.string().min(1).max(120), id: z.string().min(1).max(200) }).optional(),
  /** Quantity override. Falls back to the inbox row's quantity. The same
   *  rule as the stepper's, from the same place (services/filed-quantity.ts):
   *  a count from one, never zero (#3088). */
  quantity: FiledQuantity.optional(),
  /** Module-specific extras forwarded verbatim to the create endpoint. */
  extras: z.record(z.unknown()).optional(),
  /** The category to file under, by NAME, whatever store the table keeps its
   *  categories in. Needed for a table whose module owns its taxonomy
   *  (inventory's tree): it has no custom field to carry a name, so without
   *  this a changed or batch-agreed category could not reach it. A value in
   *  the table's own category slot (a field, or a picked category_id) wins. */
  category: optionalText(200),
  /** Tags to attach to the created entity (session-theme "tag them all", or a
   *  manual pick). Union'd with any pending_tags stashed on the item. */
  tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  /** Route into a specific module INSTANCE (e.g. a food-skinned "pantry"
   *  instance of inventory) instead of the module's default instance. The
   *  workspace-level instance slug; the platform's instance router resolves
   *  it to (module, instance) and scopes the create. Absent → default. */
  instance: optionalField(z.string().regex(/^[a-z0-9][a-z0-9-]*$/).max(80)),
  /** Platform-admin only: also record this commit as a matchmaker eval case
   *  (the corrected answer is the ground truth). Best-effort; ignored for
   *  non-admins. See docs/operations/ai-prompt-eval-harness.md (P2). */
  save_eval_case: z.boolean().optional(),
  /** A catalog entry the person picked at confirm (#6888): the record is
   *  filed bound to it, the `matches` pairing Match to catalog writes. */
  catalog_entry_id: optionalField(z.string().min(1).max(300)),
  /** Optional note / hard-case label stored on the captured eval case. */
  eval_note: optionalText(200),
  /** "I just ran out of this" (#6526): filed with none on hand. It is added
   *  with one and that one is taken as used up through the quantity door, so
   *  a restock rule sees the same crossing as for anything used up, and it
   *  goes on the shopping list (services/ran-out.ts). A kind that keeps no
   *  count cannot run out and is refused. */
  ran_out: z.boolean().optional(),
});

// (The per-kind create endpoint + quantity-field name are now DECLARED by the
//  owning module via platform().entities.registerScannable and read at commit
//  time — core-scan no longer hardcodes them. Audit 2026-06-26 follow-up.)

/** Route a draft to its target kind: an explicit choice wins; otherwise match
 *  the identify's noun hint (entity_type, e.g. "asset"/"part") to a registered
 *  scannable's noun, else the registry's declared default. Registry-driven — no
 *  module names hardcoded here. (Audit burn-down.) */
function resolveTargetKind(
  explicitModule: string | undefined,
  explicitKind: string | undefined,
  entityType: unknown,
): { module: string; kind: string } {
  if (explicitModule && explicitKind) return { module: explicitModule, kind: explicitKind };
  const scannables = scanTargetsRegistered();
  const hint = typeof entityType === "string" ? entityType : undefined;
  const chosen =
    (hint ? scannables.find((s) => s.noun === hint) : undefined) ??
    scannables.find((s) => s.default) ??
    scannables[0];
  if (!chosen) return { module: "", kind: "" }; // no scannables → caller 400s
  const [module, kind] = chosen.kind.split(":");
  return { module: module!, kind: kind! };
}

// AI-TOOL: file_inbox_items
confirmRouter.post(
  "/inbox/:id/confirm",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const parsed = ConfirmBody.safeParse(req.body);
    if (!parsed.success) return badBody(res, parsed.error);
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
    // A picked catalog entry must still be there: checked before anything is
    // filed, so a stale pick refuses instead of making a record bound to
    // nothing (#6888).
    const pickedEntry = parsed.data.catalog_entry_id ?? null;
    if (pickedEntry && !(await platform().entities.lookup(ctx.org.id, "core-catalogs:entry", pickedEntry))) {
      res.status(409).json({ error: { code: "catalog_entry_gone", message: "That catalog entry is no longer in the workspace's catalogs. Pick another, or file it without one." } });
      return;
    }
    // Filed, or deleted: a combined or undone-split row's contents live in
    // another row, and filing it counted them twice (#7144).
    const filingRefused = scanFilingRefusal(row);
    if (filingRefused) {
      res.status(409).json({ error: filingRefused });
      return;
    }

    const purposeHold = scanPurposeReview({ ...row, status: "pending" });
    // A count of something you do not keep yet that comes to none is Ran out:
    // nothing arrives, so it is not refused as an arrival.
    const ranOutAsked = parsed.data.ran_out === true;
    if (scanPurpose(row) !== "arrival" && !(ranOutAsked && scanPurpose(row) === "count")) {
      res.status(409).json({ error: { code: "not_an_arrival", message: purposeHold } });
      return;
    }

    // ATOMIC CLAIM — two confirms racing (File-all vs a manual tap, or two
    // devices) both passed the read-guard above and both created the entity.
    // A compare-and-set on status makes the loser take the same 409 here.
    const into = parsed.data.container ?? null;
    const claim = await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "resolved",
        updated_at: new Date(),
        ...(into ? { target_container_kind: into.kind, target_container_id: into.id, target_location_id: null } : {}),
      })
      .where("id", "=", id)
      .where("status", "=", row.status)
      .returning(["id"])
      .executeTakeFirst();
    if (!claim) {
      res.status(409).json({
        error: { code: "already_resolved", message: "This item was already confirmed." },
      });
      return;
    }
    if (into) {
      row.target_container_kind = into.kind;
      row.target_container_id = into.id;
      row.target_location_id = null;
    }
    // Any failure or early validation bail AFTER the claim releases it (the
    // target_entity_id guard keeps a stamped success safe) — one hook covers
    // the thrown-error path and every `res.status(4xx); return` inside the
    // create flow alike, so an item can never strand resolved-without-entity.
    res.once("finish", () => {
      if (res.statusCode < 400) return;
      // DETACHED: runs after a failed answer by design, putting the row back; there is no response left to wait
      void db
        .updateTable("core_scan_inbox_items")
        .set({ status: row.status, updated_at: new Date() })
        .where("id", "=", id)
        .where("status", "=", "resolved")
        .where("target_entity_id", "is", null)
        .execute()
        .catch(() => {});
    });

    const meta = (row.suggested_metadata as Record<string, unknown> | null) ?? {};
    // Route to the right kind: explicit choice wins, else the identify's
    // asset/part hint (asset → assets:asset, else inventory:part).
    const target = resolveTargetKind(
      parsed.data.target_module ?? undefined,
      parsed.data.target_kind ?? undefined,
      (meta as { entity_type?: unknown }).entity_type,
    );
    // A collection's kind arrives whole ("groceries:item"): prefixing the
    // module again made "inventory:groceries:item", a kind nothing reads, so a
    // record filed into a container was placed where no lookup could find it.
    const kindKey = target.kind.includes(":") ? target.kind : `${target.module}:${target.kind}`;
    // The table this files into, installed first when it is an app the
    // workspace does not have yet and the row's own candidate offers it.
    // Every door files through here, so every door installs the same way
    // (services/file-through-confirm.ts, tableForFiling; #3604).
    const installer = new BundleInstaller({
      baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
      slug: ctx.org.slug,
      authHeaders: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      canInstall: roleSatisfies((req as unknown as { tenant?: { role: string } }).tenant?.role as "owner", ["owner", "admin"]),
    });
    const table = await tableForFiling(
      installer,
      candidatesWithUserFields(storedCandidateList(row.suggested_candidates), row.suggested_metadata) as FilingCandidate[],
      { module: target.module, instance: parsed.data.instance ?? null },
      await liveTablesFor(req),
    );
    if (!table.ok) {
      // A refusal a member sees carries its next step: the ask for what is
      // missing (the one blocked-action sheet offers it), or another table
      // when nothing can make this one (#3610).
      if (table.remedy) {
        const userId = sessionUser(req)?.id ?? "";
        const role = (req as unknown as { tenant?: { role: string } }).tenant?.role ?? "member";
        // Everything the filing needs, in ONE ask: a member who lacks the
        // create permission as well as the app would otherwise get the app
        // turned on, resume, and meet a second refusal and a second round
        // trip to an admin. The same gate the card reads (create-capability).
        const remedies: Array<{ kind: "capability" | "install" | "module"; key: string }> = [table.remedy];
        const cap = createCapabilityForModule(target.module);
        if (cap && !(await platform().auth.userHasCapability({ orgId: ctx.org.id, userId, role, actionId: cap }))) remedies.push({ kind: "capability", key: cap });
        let blocked = await platform().auth.describeBlock({ orgId: ctx.org.id, userId, role, remedies, doing: "Filing this" });
        // A permission for an app that is not on yet cannot be granted until
        // it is: ask for the app alone rather than an ask nobody can answer.
        if (!blocked.requestable && remedies.length > 1) {
          blocked = await platform().auth.describeBlock({ orgId: ctx.org.id, userId, role, remedies: [table.remedy], doing: "Filing this" });
        }
        res.status(403).json({ error: { code: "table_not_installed", message: blocked.sentence, blocked } });
        return;
      }
      res.status(409).json({ error: { code: "table_not_installed", message: `This item ${table.reason}.` } });
      return;
    }
    // An install on the way made a table this request's cached list does not
    // hold: read the tables again, or the filing is named by the module's
    // default ("Filed to Inventory" for a spool just filed into Filament).
    if (installer.installed.length) (req as Request & { __liveTables?: Promise<LiveTable[]> }).__liveTables = undefined;
    const instance = table.instance ?? undefined;
    // The owning module declares its scan target (create endpoint + quantity
    // field) via registerScannable. A caller may pass an INSTANCE kind
    // (target_kind "vehicles:item") instead of the module's kind; the one
    // resolver every scan route uses (services/scan-target.ts) reads the
    // module through the kernel and falls back to the module's scannable, so
    // the instance routes the create (createUrl below) without a 400. (This
    // route had its own copy of that rule since a vehicle hit "assets:vehicles:item
    // is not a scan target"; attach and the bin adjust had none.)
    const resolvedTarget = await scanTargetOf(ctx.org.id, kindKey, instance, target.module);
    let scanTarget = resolvedTarget?.scannable;
    if (!scanTarget && meta.send) {
      const resolved = await platform().entities.resolveKind(ctx.org.id, instance ? `${instance}:item` : kindKey);
      const k = (await platform().entities.listKindsForOrg(ctx.org.id)).find((k) => k.id === resolved.base);
      if (k?.endpoints?.create) scanTarget = { noun: k.display_name, createEndpoint: `${k.module_name}${k.endpoints.create}` };
    }
    if (!scanTarget) {
      res.status(400).json({
        error: {
          code: "unknown_target_kind",
          message: `${kindKey} is not a scan target. Its module marks the kind scannable via platform().entities.registerScannable.`,
        },
      });
      return;
    }
    if (ranOutAsked && (!resolvedTarget || !scanTarget.qtyField)) {
      res.status(400).json({ error: { code: "not_counted", message: `${scanTarget.noun ?? "This"} keeps no count, so it cannot run out. Add it instead.` } });
      return;
    }
    const createPath = scanTarget.createEndpoint;

    // Build the create body. Defaults from the suggestion + extras win.
    // The quantity rides on the kind's own field name (qty vs quantity) —
    // EXCEPT for an identity-UNIQUE target (a lean catalog instance, an asset):
    // a unique record is one-per-title, so a default "qty 1" on its create is
    // not a count, it's an accident — and on a lean catalog it would latch the
    // whole list to the stock face (one-record-substrate.md). For unique
    // targets the quantity only rides when it carries real information: the
    // user typed one, or the scan read a genuine multiple off the label.
    // Fungible stock keeps the default-1 (a scanned screw IS stock intake).
    // Derived from the kind's TRAITS via the org registry, never from module
    // or bundle names; a registry hiccup falls back to today's behavior.
    const effectiveKindId = instance ? `${instance}:item` : kindKey;
    let targetIsUnique = false;
    try {
      const kinds = await platform().entities.listKindsForOrg(ctx.org.id);
      const targetKind = kinds.find((k) => k.id === effectiveKindId);
      targetIsUnique =
        traitAxisValue(targetKind?.traits as Record<string, unknown> | null, "identity") ===
        "unique";
    } catch {
      /* advisory — fall through to the fungible default */
    }

    // What the receipt knew about the PURCHASE, landed on whatever this
    // workspace calls those things. Mapped by ROLE, never by field name: a
    // mapper looking for `acquired_from` works in one workspace and silently
    // does nothing in every other. A workspace that declares no roles gets an
    // empty patch, which is the current behaviour and stays correct.
    // Everything the receipt parse established, kept whether or not a field
    // claimed it (see receipt-record.ts).
    const recordedReceipt = receiptRecord(meta as ReceiptLineMeta);
    let provenancePatch: Record<string, string | number> = {};
    /** The same facts for the kind's own columns (a vehicle's Paid). */
    let provenanceNative: Record<string, string | number> = {};
    /** The role behind each key of the patch, for the provenance stamps. */
    const provenanceRoles: Record<string, string> = {};
    try {
      // The receipt's facts, keyed by MEANING (receipt-facts.ts owns that
      // translation), landed on whatever this workspace named its fields. A
      // workspace declaring no roles gets an empty patch, which is the current
      // behaviour and stays correct: nothing invented, no field created.
      const facts = receiptFacts(meta as ReceiptMeta);
      if (Object.keys(facts).length > 0) {
        const roled = await platform().entities.roledFieldsFor(ctx.org.id, effectiveKindId);
        const mapped = mapRoledFacts(facts, roled);
        provenancePatch = roledFactsPatch(mapped);
        provenanceNative = roledNativePatch(mapped);
        for (const m of mapped) if (m.key in provenancePatch || m.key in provenanceNative) provenanceRoles[m.key] = m.role;
      }
    } catch {
      /* advisory — a confirm must never fail over provenance */
    }
    // An own copy files the count it had, 0 included; anything else a scan
    // or an arrival from outside counted, never below one (filed-quantity.ts).
    const ownCopy = isOwnCopy(row.suggested_metadata);
    const scannedQty = ownCopy ? copiedCountOf(row.quantity) : filedQuantityOf(row.quantity);
    // Ran out files one, which the take below uses up: none is left.
    const qty = ranOutAsked
      ? 1
      : parsed.data.quantity ??
        (ownCopy ? scannedQty : targetIsUnique && !(scannedQty > 1) ? undefined : scannedQty);
    // The batches its boxes printed, filed as lots on the record (#5764).
    const lots =
      !ranOutAsked && resolvedTarget && scanTarget.adjustAction && scanTarget.qtyField && typeof qty === "number" && qty > 0 ? await rowLots(db, row, qty).catch(() => []) : [];
    const lotted = lots.reduce((n, l) => n + l.qty, 0);
    // `extras.metadata` (the instance's custom fields the user filled on the
    // confirm form — colorway, fibre, …) is DEEP-merged into the scan metadata
    // so it doesn't wipe the barcode/sku/source we stamp for catalog re-match.
    const { metadata: extrasMetadata, ...restExtras } = (parsed.data.extras ?? {}) as Record<string, unknown>;
    // The matchmaker already mapped this scan onto the target's own fields
    // (colorway/fibre/weight for a yarn) — a confirm into that target gets
    // them BY DEFAULT, whichever surface confirms (the seeded form, the
    // camera's one-tap chip, the bare API). Anything the user supplied
    // (extras.metadata) wins per-key.
    // The person's typed values ride the top candidate here too, so a
    // one-tap Add, the sweep, the assistant and the bare API file them
    // without the caller sending extras (services/user-fields.ts).
    const candidates = candidatesWithUserFields(
      storedCandidateList(row.suggested_candidates) as Array<{
        instance?: string | null;
        module?: string;
        fields?: Record<string, unknown>;
      }>,
      row.suggested_metadata,
    );
    const matchedCandidate = instance
      ? candidates.find((c) => c.instance === instance)
      : (candidates.find((c) => !c.instance && c.module === target.module) ?? candidates[0]);
    // Who put each purchase-source value there (acquisition-source.ts, #3008).
    // A route's guess that contradicts the purchase evidence is not written,
    // whether or not the receipt's own value can land (a closed choice list
    // may refuse it; the record under `receipt` still says what it was). The
    // guess is kept on the stamp as `replaced`, so the record shows the
    // contradiction rather than losing it. A person's answer beats both.
    const rowStamps = fieldProvenanceOf(meta);
    const evidence = purchaseEvidenceOf(meta);
    const candidateFields: Record<string, unknown> = { ...(matchedCandidate?.fields ?? {}) };
    // The person's own values are on the merged candidate already; they are
    // told apart by their stamp, and they land above the receipt's facts.
    const personValues = Object.fromEntries(Object.entries(candidateFields).filter(([k]) => rowStamps[k]?.by === "person"));
    const entityStamps: FieldProvenanceMap = { ...rowStamps };
    for (const [k, v] of Object.entries(candidateFields)) {
      const stamp = rowStamps[k];
      const isFrom = stamp?.role ? isAcquiredFromField({ name: k, field_role: stamp.role }) : isAcquiredFromField({ name: k });
      if (!isFrom || stamp?.by === "person") continue;
      const c = acquisitionSourceConflict(k, v, evidence);
      if (!c) continue;
      delete candidateFields[k];
      const role = stamp?.role ?? provenanceRoles[k];
      entityStamps[k] = { by: "evidence", from: c.from, ...(role ? { role } : {}), replaced: c.value };
    }
    for (const k of [...Object.keys(provenancePatch), ...Object.keys(provenanceNative)]) {
      if (entityStamps[k]?.by === "person") continue;
      entityStamps[k] = { by: "evidence", from: evidence.from ?? "receipt", ...(provenanceRoles[k] ? { role: provenanceRoles[k] } : {}), ...(entityStamps[k]?.replaced ? { replaced: entityStamps[k]!.replaced } : {}) };
    }
    // HOW it must be kept, which is not WHERE it is. Derived from the scan's own
    // category, the only signal with real coverage: on a 221-item scan set, 73%
    // carried a category while under 2% carried any storage prose, and Open Food
    // Facts' conservation field is sparse multilingual free text (its
    // best-populated products say things like "Ne pas mettre au réfrigérateur").
    //
    // A DEFAULT, never an override: it fills only when nothing else said, so a
    // user's own answer and the matchmaker's both win. Null when the category
    // implies nothing, so an unknown stays unknown rather than being asserted
    // shelf-stable.
    const derivedStorage = storageRequirementFor(
      (meta as { category?: unknown } | null)?.category as string | undefined,
    );
    // WHEN it stops being good, from what it is - so a grocery never asks for
    // a date. Only for a target that declares a `field_role: "expiry"` field
    // (the Groceries table does; a parts bin does not), counted from the
    // receipt date when there is one, and NULL for anything the shelf-life
    // table does not recognise, so a light bulb never gets a best-before.
    // A default like the storage requirement: the matchmaker's fields and the
    // person's own answers both win below.
    let expiryPatch: Record<string, string | number> = {};
    // A lot read off the label (label-quantity.ts) goes into whichever field
    // carries the `lot` role: a dye lot, a lot number, a batch. Evidence, so
    // it outranks the route's guess and yields to the person (lot-field.ts).
    let lotPatch: Record<string, string | number> = {};
    let lotFieldName: string | null = null;
    let yearFieldName: string | null = null;
    try {
      const roledForExpiry = await platform().entities.roledFieldsFor(ctx.org.id, effectiveKindId);
      // The year a unit was made rides with the lot: read off the same label,
      // per unit, filed by role (lot-field.ts).
      lotPatch = { ...lotPatchFor(meta, roledForExpiry), ...yearMadePatchFor(meta, roledForExpiry) };
      lotFieldName = lotFieldOf(roledForExpiry);
      yearFieldName = yearMadeFieldOf(roledForExpiry);
      const expiryField = roledForExpiry.find((f) => f.field_role === "expiry")?.name;
      if (expiryField) {
        expiryPatch =
          expiryDefaults({
            category: (meta as { category?: unknown }).category as string | undefined,
            name: row.suggested_name,
            acquiredOn: typeof (meta as { receipt_date?: unknown }).receipt_date === "string" ? ((meta as { receipt_date: string }).receipt_date) : null,
            // The day it is where the person filing this is: a grocery scanned
            // at 6pm in the Americas was dated tomorrow, and its shelf life
            // counted from tomorrow (#3351).
            today: await platform().accounts.dayFor(sessionUser(req)?.id ?? null),
            expiryField,
          }) ?? {};
      }
    } catch {
      /* advisory - a confirm must never fail over a shelf-life guess */
    }
    // The triage form posts EVERY input — an untouched one arrives as "".
    // Empty means "no answer", not "blank the suggestion": drop them so a
    // placeholder the user never typed over can't clobber the candidate.
    const typedMetadata = Object.fromEntries(
      Object.entries((extrasMetadata as Record<string, unknown> | undefined) ?? {}).filter(
        ([, v]) => v !== "" && v !== null && v !== undefined,
      ),
    );
    const at = new Date().toISOString();
    for (const k of Object.keys(lotPatch)) if (rowStamps[k]?.by !== "person") entityStamps[k] = { by: "evidence", from: "label", at };
    for (const k of Object.keys(typedMetadata)) {
      const was = matchedCandidate?.fields?.[k] ?? provenancePatch[k] ?? lotPatch[k];
      // Untouched on the form (the value the route or the receipt put there
      // came back as typed) keeps its stamp; a change is the person's.
      if (was !== undefined && String(was) === String(typedMetadata[k])) continue;
      entityStamps[k] = { by: "person", from: "confirm", at, ...(rowStamps[k]?.role ? { role: rowStamps[k]!.role } : {}) };
    }

    // A decoder-mapped value (a VIN, decoded to candidateFields.serial_number by
    // applyDecoderFill) must reach the NATIVE serial_number/model column the field
    // actually reads — not only the metadata blob candidateFields spreads into
    // below. resolveNativeIdentity falls the native keys back from meta.* to the
    // candidate value. Without it a decoded VIN landed in metadata.serial_number (a
    // key the VIN box never reads) and the native column stayed blank (reported
    // 2026-07-24). Pure + unit-tested (native-identity.test.ts).
    // An identifier is filed only when the item carries it (scan-evidence.ts,
    // identifierHasEvidence): the scanned code, a decode, what the photo
    // shows, a corroborated catalog match, or what a person typed here. A
    // value found by searching for a description of the thing names
    // whatever the search found first, and filing it as this item's ISBN or
    // serial is a fact nobody checked (#3613). It stays on the row as a
    // suggestion the card marks.
    // Top-level `extras` too: File everything sends the candidate's fields
    // there, and they reach the record as they are (#3647).
    for (const k of unevidencedIdentifiers(row, { ...restExtras, ...candidateFields, ...typedMetadata })) {
      if (entityStamps[k]?.by === "person") continue;
      delete candidateFields[k];
      delete typedMetadata[k];
      delete restExtras[k];
    }
    const { serial_number: nativeSerial, model: nativeModel } = resolveNativeIdentity(
      meta as { serial_number?: unknown; model?: unknown },
      candidateFields,
    );
    // A record named only by its code reads as a number in every list: it
    // waits in the inbox for a name instead, whichever door filed it (#3930).
    const filingAs = parsed.data.name ?? filingName(row) ?? "Untitled";
    if (isBareCodeName(filingAs, row.barcode_text)) {
      res.status(422).json({ error: { code: "needs_name", message: "Give it a name first: a barcode number is not a name." } });
      return;
    }
    const body: Record<string, unknown> = {
      // Entity names cap at 160 (the modules' own create schemas); a catalog
      // title just gets cut there - a long name must never fail the commit.
      name: clampEntityName(filingAs),
      manufacturer: row.suggested_manufacturer ?? undefined,
      // A serial/service tag (vision-read) OR a decoder-mapped value (a VIN) →
      // the destination table's NATIVE serial_number field (inventory/assets/
      // machines all declare it; an unknown target routes it to metadata
      // harmlessly). Native key like manufacturer; a user-typed value in
      // restExtras still wins below.
      ...(nativeSerial ? { serial_number: nativeSerial } : {}),
      // A decoded model (a VIN's model, from meta.model or the candidate) → the
      // destination's NATIVE model field. Same discipline as serial_number.
      ...(nativeModel ? { model: nativeModel } : {}),
      // Carry the SKU + barcode + source into metadata so a future
      // catalog-match step can find this entity.
      metadata: {
        barcode: row.barcode_text ?? undefined,
        sku: row.suggested_sku ?? undefined,
        category: (meta as { category?: string }).category ?? undefined,
        scan_source: (meta as { source?: string }).source ?? undefined,
        // Physical annotations the triage captured (scan-parity Epic D).
        pack_size: (meta as { pack_size?: number }).pack_size ?? undefined,
        // What Open Food Facts lists the food as containing, kept as the
        // words a field shows and a view filters on.
        allergens: wordsOf((meta as { allergens?: unknown }).allergens),
        traces: wordsOf((meta as { traces?: unknown }).traces),
        box_state: (meta as { box_state?: string }).box_state ?? undefined,
        // A titled work's other forms (the original, a translation, a
        // transliteration) ride to the record under the same key the row
        // keeps them, so the kernel serves the record's title in the
        // person's format the way the inbox served the row (#3061). The
        // stored name stays what the source said.
        [TITLE_VARIANTS_KEY]: titleVariantsOf(meta) ?? undefined,
        // Empty box: the scan location is the BOX's home, not the item's — say
        // so instead of silently mislocating the entity.
        ...((meta as { box_state?: string }).box_state === "empty-box" &&
        (row.scan_area || parsed.data.location_id)
          ? { box_note: `Empty box kept at: ${row.scan_area ?? "the scan location"}` }
          : {}),
        // Fields a scan-URL resolver seeded (e.g. a Polar spool's size /
        // batch_code). Generic: the kernel doesn't know the vendor — it
        // just carries whatever `fields` the resolver stamped. Matchmaker
        // candidate + user-typed values still win per-key below.
        // Everything the receipt parse established, whether or not a field
        // claimed it. provenancePatch below promotes what has a ROLE; this
        // keeps the rest, because a workspace with no acquired-on field was
        // losing the receipt's date outright and dating a perishable by the
        // day it happened to be scanned (2026-08-22).
        ...(recordedReceipt ? { receipt: recordedReceipt } : {}),
        ...((meta as { fields?: Record<string, unknown> }).fields ?? {}),
        // Ahead of candidateFields and typedMetadata so both still win.
        ...(derivedStorage ? { storage_requirement: derivedStorage } : {}),
        ...expiryPatch,
        ...candidateFields,
        // The receipt's facts over the route's guesses: evidence over an
        // inference. It sat below the candidate once, on the theory that a
        // machine-derived value should defer to the model, and the model's
        // "Facebook Marketplace" won over the receipt's "eBay" (#3008).
        ...provenancePatch,
        ...lotPatch,
        ...personValues,
        ...typedMetadata,
        // Who put each of these there, kept on the record (#3008).
        ...(Object.keys(entityStamps).length ? { [FIELD_PROVENANCE_KEY]: entityStamps } : {}),
      },
      // Units whose boxes printed a lot arrive through the record's own
      // action after the create, as those lots (row-lots.ts); the create
      // carries the rest.
      ...startingCount(scanTarget, qty, lotted),
      // Empty box → do NOT file the entity at the scan location: that's where
      // the BOX lives; the item itself is deployed elsewhere.
      // Container beats location: scanning INTO a bin/server is the more
      // specific intent, and the placement seam clears location_id for a
      // non-location container anyway — stamping one here just made the
      // create carry a home the placement below immediately retracts.
      //
      // The row's OWN stored home (the active bin stamped at scan time, or a
      // bulk "Set location") is the default when the body brings none — the
      // same server-side fallback the container path below and
      // /confirm-into-location already apply. It used to be the client's job
      // to echo it back, and any confirm caller that didn't (WhatToDoPanel)
      // silently dropped a location the user had already set.
      ...((parsed.data.location_id ?? row.target_location_id) &&
      !(row.target_container_kind && row.target_container_id) &&
      (meta as { box_state?: string }).box_state !== "empty-box"
        ? { location_id: parsed.data.location_id ?? row.target_location_id }
        : {}),
      // The receipt's facts on the kind's own columns (Paid, Purchased at,
      // Bought from), where it keeps them; what the person sent still wins.
      ...provenanceNative,
      ...restExtras,
    };

    // WHERE it goes, when nothing above said: the place the route read off
    // the item and took out of a field because it names a Location
    // ("storage: Pantry", place-fields.ts). It was recorded and then dropped,
    // so the item filed with no location and Pantry's label showed nothing.
    // Only when no location, stored home or container was chosen, and only
    // when the place names exactly one Location.
    if (
      !meta.send && body.location_id === undefined &&
      !(row.target_container_kind && row.target_container_id) &&
      (meta as { box_state?: string }).box_state !== "empty-box"
    ) {
      try {
        const listed = await platform().entities.list(ctx.org.id, "core-locations:location", { limit: 1000 });
        const locs = listed.items.map((l) => ({
          id: l.id,
          name: l.title ?? String((l.fields as Record<string, unknown> | undefined)?.name ?? ""),
          short_name: l.subtitle ?? null,
        }));
        const names = locs.flatMap((l) => (l.short_name ? [l.name, l.short_name] : [l.name]));
        const places = {
          ...(((matchedCandidate as { place_fields?: Record<string, unknown> } | undefined)?.place_fields) ?? {}),
          ...stripPlaceFields({ ...candidateFields, ...typedMetadata }, names).stripped,
        };
        const locId = Object.keys(places).length > 0 ? locationForPlaces(places, locs) : null;
        if (locId) body.location_id = locId;
      } catch {
        /* locations unavailable: the item files unplaced, as before */
      }
      // Then the spot the card shows beside the item ("Pantry - it keeps at
      // room temperature"), which File all already used and Add did not, so
      // one tap filed a grocery nowhere and Pantry's label read What's here (0)
      // (2026-09-29). Worked out here when the match has not stamped one yet,
      // by the same resolver, so a quick tap is not a different answer.
      if (body.location_id === undefined) {
        try {
          const name = (typeof body.name === "string" && body.name) || row.suggested_name || null;
          const category = (matchedCandidate as { category?: string } | undefined)?.category ?? null;
          // A row's stamped spot is used only with its reason (" — why"): a
          // place nothing stood behind is not one to file into (#4933).
          const reasoned = row.suggested_location_id && /\s[–—-]\s\S/.test(row.suggested_location_note ?? "") ? row.suggested_location_id : null;
          const spot =
            reasoned ??
            (
              await suggestLocationForItem(ctx.org.id, {
                name,
                category,
                excludeId: null,
                kind: instance ? `${instance}:item` : kindKey,
                kindIsCollection: !!instance,
                requirement: resolveRequirement(
                  candidateFields.storage_requirement ?? (typedMetadata as Record<string, unknown>).storage_requirement,
                  [
                    category,
                    (row.suggested_metadata as { category?: string } | null)?.category,
                    await tableCategoryWord(ctx.org.id, instance ? `${instance}:item` : kindKey, instance ?? null, { ...candidateFields, ...typedMetadata }),
                  ],
                  name,
                ),
              })
            )?.location_id ??
            null;
          if (spot) body.location_id = spot;
        } catch {
          /* no suggestion to be had: the item files unplaced, as before */
        }
      }
    }

    // Re-issue through the api against the SAME bearer token so
    // requireAuth + withTenant + role gating fire on the target
    // endpoint.
    const baseUrl =
      (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
    // An explicit instance routes through the platform instance dispatcher
    // (/instances/:name/items), which scopes the create to that instance of
    // the owning module. The kind still drives the qty-field mapping above —
    // an inventory instance keeps `qty`. Absent → the module's default path.
    if (meta.send) {
      const sent = meta.send as NonNullable<OfferedThing["send"]>;
      const kind = instance ? `${instance}:item` : kindKey;
      const k = (await platform().entities.listKindsForOrg(ctx.org.id)).find((k) => k.id === kind);
      const custom = await platform().entities.fieldsFor(ctx.org.id, kind);
      const fields = [...(k?.fields ?? []).filter((f) => !f.readOnly && !custom.some((c) => c.name === f.name)).map((f) => ({name: f.name, display_label: f.label || f.name.replace(/_/g, " "), type: f.type, native: true})), ...custom];
      const mapping = mapOfferedFields(sent.values, fields, sent.field_map);
      if (mapping.missing.length && meta.send_drop_unmapped !== true) {
        res.status(422).json({error: {code: "send_needs_fields", message: `${mapping.missing.join(", ")} has no field here. Add the fields or choose to drop them before filing.`}}); return;
      }
      if (sent.needs.includes("Choose a placement in this workspace") && !body.location_id && meta.send_unplaced !== true) {
        res.status(422).json({error: {code: "send_needs_placement", message: "Choose a placement or choose to arrive unplaced before filing."}}); return;
      }
      const bag = body.metadata as Record<string, unknown>;
      for (const f of fields) if (Object.hasOwn(mapping.values, f.name)) {
        if (f.native) { body[f.name] = mapping.values[f.name]; delete bag[f.name]; }
        else bag[f.name] = mapping.values[f.name];
      }
      bag.send_origin = sent.origin;
    }
    const createUrl = instance
      ? `${baseUrl}/api/v1/orgs/${ctx.org.slug}/instances/${instance}/items`
      : `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${createPath}`;
    // THE CONFIRMED CATEGORY, through the seam (#3223), BEFORE the create.
    //
    // Before the create because a kind whose module owns its taxonomy is
    // handed a record id to write on the row it is about to create, rather
    // than a patch afterwards; the seam says which, and this does not ask.
    //
    // And read off `body.metadata`, which is what is actually being written to
    // the record. The old code read `extras[name]` — the TOP level of extras —
    // while both confirm doors post a table's custom fields under
    // `extras.metadata` (the card's one-tap Add and its form, both). The axis
    // IS a custom field, so the lookup missed it every time and the vocabulary
    // this comment promises to grow has not grown from a confirm on either
    // door. Filed as its own finding; fixed here by reading where the value is.
    const fieldKind = instance ? `${instance}:item` : kindKey;
    await commitCategoryAxis(
      ctx.org.id,
      fieldKind,
      instance ?? null,
      { fields: (body.metadata as Record<string, unknown> | undefined) ?? {}, row: body },
      (matchedCandidate as { category?: unknown } | undefined)?.category as string | undefined,
      parsed.data.category,
    );

    // A colour is stored the platform's one way: a hex in any spelling a tag
    // or a catalog gave becomes "#rrggbb", a name is kept (services/colour-fields.ts).
    // Which fields are colours is the table's to say; a table that cannot be
    // read is filed as it came.
    try {
      const base = (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API;
      const defsRes = await apiFetch(`${base}/api/v1/orgs/${ctx.org.slug}/field-defs?kind=${encodeURIComponent(fieldKind)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (defsRes.ok && body.metadata && typeof body.metadata === "object") {
        const defs = ((await defsRes.json()) as { items?: Array<ColourFieldDef & FactFieldDef> }).items ?? [];
        body.metadata = canonicalColourFields(body.metadata as Record<string, unknown>, defs);

        // What the scan itself says, into the fields that are still empty: the
        // barcode into the identifier field, the name's plain facts ("1.75mm",
        // "1kg", "PLA") into choice fields (services/scan-field-facts.ts). A
        // table whose items lift to a parent type is also written the type's
        // key and copied fields, which the lift carries up, so a scanned
        // spool's type gets its UPC as well (#3990).
        const factDefs: FactFieldDef[] = [...defs];
        const parentCfg = instance
          ? ((await platform().instances.configOf(ctx.org.id, instance).catch(() => null))?.parent as
              | { instance?: string; key_fields?: unknown; copy_fields?: unknown }
              | undefined)
          : undefined;
        if (parentCfg?.instance) {
          const carried = new Set(
            [parentCfg.key_fields, parentCfg.copy_fields].flatMap((v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])),
          );
          const pRes = await apiFetch(`${base}/api/v1/orgs/${ctx.org.slug}/field-defs?kind=${encodeURIComponent(`${parentCfg.instance}:item`)}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (pRes.ok) {
            const own = new Set(defs.map((d) => d.name));
            for (const d of ((await pRes.json()) as { items?: FactFieldDef[] }).items ?? []) {
              if (carried.has(d.name) && !own.has(d.name)) factDefs.push(d);
            }
          }
        }
        const md = body.metadata as Record<string, unknown>;
        body.metadata = {
          ...identifierFromScan(row.barcode_text, factDefs, md),
          ...choicesNamedIn(String(body.name ?? filingName(row) ?? ""), factDefs, md),
          ...md,
        };
      }
    } catch {
      /* the colour is filed as it came */
    }

    // A filing that made its record and was then refused its lots (#7145)
    // resumes on that record: Confirm again adds what it owes, never makes a
    // second one. The record must still be there and of this kind.
    const owed = filingOwedOf(meta);
    const owedRecord = owed ? await platform().entities.lookup(ctx.org.id, kindKey, owed.entity_id).catch(() => null) : null;
    const resumed = resumesOn(owed, kindKey, !!owedRecord) ? owedRecord : null;
    const doCreate = () =>
      resumed
        ? Promise.resolve(new Response(JSON.stringify({ id: resumed.id, name: resumed.title }), { status: 201, headers: { "Content-Type": "application/json" } }))
        : apiFetch(createUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    let createRes = await doCreate();
    // A value the scan found for a field the kind does not have (a book's
    // read status filed as a part) goes where the confirm door already puts
    // it: inside the record's explicit `metadata`, not at the top level where
    // the write route refuses an undeclared name (#3855). The route names the
    // keys it does not own, so nothing here guesses which are native.
    if (createRes.status === 422) {
      const refused = (await createRes.clone().json().catch(() => null)) as {
        error?: { code?: string; details?: { unknown?: unknown } };
      } | null;
      const unknownKeys = refused?.error?.code === "unknown_field" && Array.isArray(refused.error.details?.unknown)
        ? (refused.error.details!.unknown as unknown[]).filter((k): k is string => typeof k === "string")
        : [];
      if (unknownKeys.length) {
        const bag = { ...((body.metadata as Record<string, unknown> | undefined) ?? {}) };
        for (const k of unknownKeys) {
          if (!(k in bag)) bag[k] = body[k];
          delete body[k];
        }
        body.metadata = bag;
        createRes = await doCreate();
      }
    }
    // Capture-first "one-tap materialize": you can scan into a flagship-bundle
    // shape before its module is enabled. If the create dead-ends on the
    // module-not-enabled gate, enable the target module (idempotent) and retry
    // once — so a scan files itself instead of erroring on a 409.
    if (createRes.status === 409) {
      const peek = await createRes.clone().text();
      if (/module_not_enabled/.test(peek)) {
        await apiFetch(`${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${target.module}/enable`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: "{}",
        }).catch(() => {});
        createRes = await doCreate();
      }
    }
    if (!createRes.ok) {
      const errText = await createRes.text();
      // Surface the TARGET's own message (e.g. "Enable Inventory in Configuration
      // → Modules"), not just the bare status, so the error is actionable.
      // And its `blocked`, whole: a refusal the target explained (a permission
      // the person can ask for, blocked-action.ts) reaches the app's
      // blocked-action sheet through here exactly as it would have directly.
      // This is the door the reporter's "ask a workspace admin" toast came
      // through, with the explanation stripped (#3073).
      let targetMsg: string | undefined;
      let blocked: unknown;
      try {
        const parsed = JSON.parse(errText) as { error?: { message?: string; blocked?: unknown } };
        targetMsg = parsed.error?.message;
        blocked = parsed.error?.blocked;
      } catch {
        /* non-JSON body */
      }
      res.status(createRes.status).json({
        error: {
          code: "create_failed",
          message: targetMsg ?? `Target create returned ${createRes.status}`,
          details: errText,
          ...(blocked ? { blocked } : {}),
        },
      });
      return;
    }
    const created = (await createRes.json()) as { id: string; name?: unknown; title?: unknown; under_type?: FiledInto["under"] & { noun?: string } };
    // A receipt line's order line already exists (born at parse). Filing is
    // what CLAIMS it: the part now stands for that line. Best-effort, like
    // every other purchases touch from here - a workspace without purchases
    // files its receipts all the same. Awaited: discarding the receipt's last
    // line deletes the order when no line is claimed, so a claim still on
    // its way let that delete take a real purchase (#5046).
    {
      const rm = (row.suggested_metadata ?? {}) as { receipt_order_id?: unknown; receipt_order_item_id?: unknown };
      const oid = typeof rm.receipt_order_id === "string" ? rm.receipt_order_id : null;
      const lid = typeof rm.receipt_order_item_id === "string" ? rm.receipt_order_item_id : null;
      const tok = bearer(req);
      if (oid && lid && tok) {
        await claimOrderLine({
          baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API,
          slug: ctx.org.slug,
          headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
          orderId: oid,
          itemId: lid,
          partId: created.id,
          subjectKind: kindKey,
        });
      }
    }

    if (lotted > 0 && resolvedTarget) {
      const tok = bearer(req);
      const arrived = await moveQuantity(ctx.org.id, resolvedTarget, { kind: kindKey, id: created.id }, lotted, {
        userId: sessionUser(req)?.id ?? null,
        reason: "received from a scan",
        restock: true,
        lots,
        source: { kind: "core-scan:inbox", id: row.id },
        door: { baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API, slug: ctx.org.slug, headers: tok ? { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" } : {} },
        current: (qty as number) - lotted,
      });
      if (!arrived.ok) {
        // Not filed: its record is made and owes these units. The row stays
        // pending with what is owed, and Confirm again finishes on the same
        // record (#7145). It used to say filed, with none of them counted.
        const owedNow = owedAfterRefusal({ kind: kindKey, entityId: created.id, title: String(created.name ?? created.title ?? "The record"), count: lotted, refused: arrived.refused ?? null });
        await db
          .updateTable("core_scan_inbox_items")
          .set({ status: row.status, suggested_metadata: mergeMeta(owedNow.stamp) as never, updated_at: new Date() })
          .where("id", "=", id)
          .execute();
        res.status(409).json({ error: owedNow.error });
        return;
      }
    }

    // Ran out (#6526): the one it was filed with is taken as used up, and it
    // goes on the shopping list; the list line is kept on the row for Undo.
    let ranOutDone: RanOutOutcome | null = null;
    if (ranOutAsked && resolvedTarget && created?.id) {
      const tok = bearer(req);
      ranOutDone = await ranOut({
        orgId: ctx.org.id,
        userId: sessionUser(req)?.id ?? null,
        target: resolvedTarget,
        entity: { kind: kindKey, id: created.id },
        current: 1,
        invented: true,
        rowId: row.id,
        door: { baseUrl: (req.headers["x-cobblr-base-url"] as string | undefined) ?? INTERNAL_API, slug: ctx.org.slug, headers: tok ? { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" } : {} },
      });
      await db
        .updateTable("core_scan_inbox_items")
        .set({ suggested_metadata: mergeMeta({ [RAN_OUT_KEY]: ranOutDone.stamp }) as never })
        .where("id", "=", row.id)
        .execute();
    }

    // Scan-into-container: if the item was scanned into a CONTAINER bin (a
    // server/asset or machine — not a location), place the created entity inside
    // it. Parallel to the location_id stamping in the create body above; the
    // container path writes a placement row after the create. Best-effort — a
    // bad container (ineligible kind / cycle) never fails the whole confirm; the
    // item is already created + filed.
    if (row.target_container_kind && row.target_container_id) {
      try {
        await platform().placement.place({
          orgId: ctx.org.id,
          containee: { kind: kindKey, id: created.id },
          container: { kind: row.target_container_kind, id: row.target_container_id },
          placedBy: sessionUser(req)?.id ?? null,
        });
      } catch (err) {
        console.warn(
          `[scan] placement into ${row.target_container_kind} failed:`,
          (err as Error).message,
        );
      }
    }

    // Session-theme / manual tags: attach each to the created entity via the
    // core-tags attach endpoint (creates the tag by name on the fly, idempotent
    // on tag+entity). pending_tags stashed by /inbox/apply-theme union with any
    // tags the confirm body carries. Best-effort — a tag failure never fails a
    // confirm.
    const stashedTags = ((row.suggested_metadata as { pending_tags?: unknown } | null)?.pending_tags);
    const tagNames = [
      ...new Set([
        ...(Array.isArray(stashedTags) ? stashedTags.map((t) => String(t)) : []),
        ...(parsed.data.tags ?? []),
      ]),
    ].filter((t) => t.trim());
    for (const tag_name of tagNames) {
      try {
        await platform().tags.attach({
          orgId: ctx.org.id,
          tagName: tag_name,
          target: { kind: entityKindOf({ module: target.module, type: target.kind }), id: created.id },
        });
      } catch (err) {
        console.error(`[core-scan] confirm tag "${tag_name}" failed:`, (err as Error)?.message ?? err);
      }
    }

    // Attach photos to the new entity as gallery images (core-files), then pick
    // the thumbnail. The user's OWN captured shots come first — this row's
    // image_file_id AND every combined-sibling's (a barcode pic + a plate pic
    // scanned as SEPARATE rows then combined; the plate lives on the absorbed
    // sibling, suggested_metadata.combined_into === this row) — then the catalog/
    // internet image. Confirm used to attach ONLY the catalog image, so a user's
    // captured photos silently vanished at commit (reported 2026-07-24).
    const siblingPhotos = await db
      .selectFrom("core_scan_inbox_items")
      .select(["image_file_id", "barcode_text"])
      .where(sql<string>`suggested_metadata ->> 'combined_into'`, "=", row.id)
      .where("image_file_id", "is not", null)
      .execute()
      .catch(() => [] as { image_file_id: string | null; barcode_text: string | null }[]);
    const userPhotos = [row.image_file_id, ...siblingPhotos.map((s) => s.image_file_id)].filter(
      (fid): fid is string => !!fid,
    );
    // A capture that READ A BARCODE pictures the barcode, not the item, so it
    // never becomes the thumbnail (see itemPhotos) — it stays in the gallery as
    // scan evidence. A row identified by barcode has its OWN capture as that
    // frame; in a combined scan the barcode pic can sit on an absorbed sibling,
    // so each row is judged by its own barcode_text.
    const barcodeFrames = [
      row.barcode_text ? row.image_file_id : null,
      ...siblingPhotos.map((s) => (s.barcode_text ? s.image_file_id : null)),
    ].filter((fid): fid is string => !!fid);
    const galleryFiles = [...userPhotos, ...(row.catalog_image_file_id ? [row.catalog_image_file_id] : [])];
    // A scan whose catalog image is still a raw URL (not downloaded yet, or
    // committed mid-enrich) has NO file to attach, so the block below used to be
    // skipped entirely and the new record was created with no picture at all.
    // That is the same bug committedImagePath() exists to prevent, fixed for
    // LOCATIONS on 2026-07-24 and never applied here: "if the scan carries ANY
    // image representation the committed part MUST get an image_path".
    // Run the block whenever there is any representation, file or URL.
    if (galleryFiles.length || row.catalog_image_url) {
      try {
        for (const fileId of galleryFiles) {
          await platform().files.attach(ctx.org.id, {
            fileId,
            source_module: target.module,
            source_type: target.kind,
            source_id: created.id,
            role: "gallery",
          });
        }
        // Thumbnail: a user's own captured photo wins over the catalog image. With
        // no user photo, the catalog image is the thumbnail UNLESS the item's
        // identity is a colour swatch (a valid hex, e.g. a yarn's colourway) — a
        // generic internet photo would then suppress the swatch the user actually
        // wants, so keep the catalog photo in the gallery only.
        const committedColor = String(
          ((body.metadata as Record<string, unknown> | undefined)?.color ?? "") as string,
        ).trim();
        const hasColorSwatch = /^#[0-9a-fA-F]{3,8}$/.test(committedColor);
        const thumb =
          itemPhotos(userPhotos, barcodeFrames)[0] ??
          (hasColorSwatch ? null : (row.catalog_image_file_id ?? null));
        // One decision, in the file that owns it. Set instantly - no network in
        // the commit path, because downloading inline made a bulk "Confirm all"
        // hang (~25s per line, reported 2026-07-25).
        const thumbPath = commitThumbPath(ctx.org.slug, {
          userPhotoFileIds: userPhotos,
          barcodeFrameFileIds: barcodeFrames,
          catalogImageFileId: row.catalog_image_file_id,
          catalogImageUrl: row.catalog_image_url,
          colorHex: committedColor,
        });
        if (thumbPath) {
          // An instance-scoped entity is invisible to the bare module route (its
          // CRUD filters to the default instance), so the patch rides the same
          // instance path the create used.
          const patchUrl = instance
            ? `${baseUrl}/api/v1/orgs/${ctx.org.slug}/instances/${instance}/items/${created.id}`
            : `${baseUrl}/api/v1/orgs/${ctx.org.slug}/modules/${createPath}/${created.id}`;
          await apiFetch(patchUrl, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ image_path: thumbPath }),
          });
          // A raw catalog URL can be hotlink-blocked and render broken, so kick
          // off the same background download locations do: once the file lands,
          // repoint the record at a stored same-origin copy. Commit stays fast.
          if (!thumb && row.catalog_image_url) {
            const url = row.catalog_image_url;
            const inboxId = row.id;
            const recordId = created.id;
            // DETACHED: storing the catalog photo locally; the record shows the catalog address until it lands
            void (async () => {
              try {
                const ok = await downloadCatalogImage({ db, orgId: ctx.org.id, itemId: inboxId }, url);
                if (!ok) return;
                const fresh = await db
                  .selectFrom("core_scan_inbox_items")
                  .select(["catalog_image_file_id"])
                  .where("id", "=", inboxId)
                  .executeTakeFirst();
                const fid = fresh?.catalog_image_file_id;
                if (!fid) return;
                await platform().files.attach(ctx.org.id, {
                  fileId: fid,
                  source_module: target.module,
                  source_type: target.kind,
                  source_id: recordId,
                  role: "gallery",
                });
                await apiFetch(patchUrl, {
                  method: "PATCH",
                  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    image_path: committedImagePath(ctx.org.slug, fid, null),
                  }),
                });
              } catch (err) {
                console.warn("[core-scan] catalog-image upgrade failed:", (err as Error).message);
              }
            })();
          }
        }
      } catch (err) {
        console.error("[core-scan] attach scan photos failed:", (err as Error).message);
      }
    }

    // Mark the inbox row resolved, recording where it went (#3620).
    const filedInto = await filedIntoFor(req, target.module, instance ?? null, effectiveKindId, {
      // The record as filed names the result, never the scan's suggestion:
      // a catalog's listing title ("... Yarn, 1 Pack Of 9 Skein") was the
      // toast's name while the record said "Super Saver" (#4011).
      name: [created.name, created.title, body.name].find((v): v is string => typeof v === "string" && v.trim() !== ""),
      noun: created.under_type?.noun ?? (matchedCandidate as { noun?: unknown } | undefined)?.noun,
      under: created.under_type ? { id: created.under_type.id, name: created.under_type.name, created: created.under_type.created, instance: created.under_type.instance } : undefined,
      // The name the card showed for this table ("Filament" for spools
      // under their types), so the result names the place the person chose.
      shownAs: matchedCandidate && (matchedCandidate.instance ?? null) === (instance ?? null) ? (matchedCandidate as { label?: unknown }).label : undefined,
    });
    const resolvedRow = await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "resolved",
        target_module: target.module,
        target_kind: target.kind,
        target_entity_id: created.id,
        suggested_metadata: sql`(coalesce(suggested_metadata, '{}'::jsonb) - ${FILING_OWED_KEY}) || ${JSON.stringify({ [FILED_INTO_KEY]: filedInto })}::jsonb` as never,
        resolved_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();

    // The picture the user settled on, kept at the moment they commit to the
    // item. The pick route already remembers a choice made THERE, but a choice
    // made before that shipped - or made on a row that was picked once and
    // filed later - would otherwise die with the row ("I concretely chose
    // these pics ... and I would like these pics to persist", 2026-09-01).
    // Confirm is the strongest possible signal: they kept the picture AND the
    // item. Only a web address travels; see picked-images.ts.
    {
      const meta = (resolvedRow.suggested_metadata ?? {}) as {
        receipt_vendor?: string;
        catalog_image_user_set?: boolean;
      };
      if (meta.catalog_image_user_set) {
        // DETACHED: remembering a picked picture for next time; this filing is complete without it
        void rememberPickedImage(
          ctx.org.id,
          meta.receipt_vendor ?? null,
          resolvedRow.suggested_name,
          resolvedRow.catalog_image_url,
        ).catch((e) => console.warn("[core-scan] picked-image remember on confirm failed:", (e as Error).message));
      }
    }

    // What the person did, kept: "scanned six things" is an intent the
    // activity log can read back later (#3254), where the target's own
    // create row says only that a part was made. Everything a replay would
    // need to make this item again, the normal way: where it went, what it
    // was filed as, and which pictures are its (file ids, so the image can
    // travel with it). Best-effort, like every other touch after the create.
    try {
      await platform().activity.log({
        orgId: ctx.org.id,
        userId: sessionUser(req)?.id ?? null,
        action: "scan_committed",
        ref: { module: "core-scan", entityType: "inbox_item", entityId: id },
        diff: {
          entity_kind: kindKey,
          entity_id: created.id,
          ...(instance ? { instance: instance } : {}),
          name: String(body.name ?? filingName(row) ?? "").trim() || null,
          ...(row.barcode_text ? { barcode: row.barcode_text } : {}),
          ...(resolvedRow.catalog_image_url ? { catalog_image_url: resolvedRow.catalog_image_url } : {}),
          photo_file_ids: userPhotos,
          ...(row.catalog_image_file_id ? { catalog_image_file_id: row.catalog_image_file_id } : {}),
        },
      });
    } catch (err) {
      console.warn("[core-scan] activity log for the commit failed:", (err as Error).message);
    }

    if (meta.send) await finishOwnSend(ctx.org.id, id, {kind: effectiveKindId, id: created.id});
    void platform().events.emit("core-scan.scan.confirmed", {
      orgId: ctx.org.id,
      itemId: id,
      targetModule: target.module,
      targetKind: target.kind,
      entityId: created.id,
    });

    // P2 eval-harness capture (platform-admin only, best-effort): the admin's
    // corrected commit IS the ground-truth answer. Record the perceived input +
    // the menu the model saw + the route/fields committed, so the matchmaker
    // golden set grows from real triage rather than hand-authoring. A capture
    // failure must never fail the commit. See docs/operations/ai-prompt-eval-harness.md.
    const sess = sessionUser(req);

    // The last part of a split pack filed: what the pack held goes to the
    // barcode network, once, when this instance is connected (pack-network.ts).
    // DETACHED: a store fact sent to the shared network; this filing is complete without it
    void reportPackIfFiled(db, row.suggested_metadata, sess?.id ?? null).catch((e: Error) => console.warn("[core-scan] pack report:", e.message));

    // A committed barcode item feeds the shared Barcode Intelligence DB. A rename
    // away from the resolver's answer is a real CORRECTION (the human's name is
    // the truth); an unchanged commit — and every other field the user filed
    // as-is — is a strong SIGNAL (a scan-commit vote that only becomes fact once
    // enough independent people agree resolver-side). Neither is the operator's
    // absolute "lock it in". This is why a plain Confirm now teaches BIdb without
    // anyone reaching for the (operator-only) green button. Fire-and-forget;
    // inert unless the resolver + a correction token are configured.
    // The lots this unit carries (read off its label, or filed by the person):
    // per unit, so none of them ever reaches the shared network.
    const unitLots = unitLotsOf(
      meta,
      ...Object.values(lotPatch),
      lotFieldName ? typedMetadata[lotFieldName] : undefined,
      yearFieldName ? typedMetadata[yearFieldName] : undefined,
    );
    if (row.barcode_text) {
      // What it is beyond its name: the shared table and its product fields,
      // for the next workspace to file with no AI (#3769).
      const bundle = (matchedCandidate as { from_bundle?: unknown; bundle_external_id?: unknown } | undefined)?.from_bundle ?? (matchedCandidate as { bundle_external_id?: unknown } | undefined)?.bundle_external_id;
      if (typeof bundle === "string" && bundle) {
        // DETACHED: what the product is, sent to the shared barcode database; this filing is complete without it
        void (async () => {
          const defs = await platform().entities.fieldsFor(ctx.org.id, effectiveKindId);
          await reportLearnedRoute({
            upc: row.barcode_text!,
            bundle,
            fields: shareableProductFields(defs, { ...candidateFields, ...typedMetadata }),
            userId: sess?.id ?? null,
            lots: unitLots,
          });
        })().catch((e: Error) => console.warn("[core-scan] learned route report:", e.message));
      }
      const committedName = String(body.name ?? filingName(row) ?? "").trim();
      const renamed = meaningfullyChanged(row.suggested_name, committedName);
      // Where each value came from (#3769): the person's if they changed it,
      // else the AI's or the catalogue's, by how the row was named.
      const rowSource = (row.suggested_metadata as { source?: unknown } | null)?.source;
      if (committedName) {
        // DETACHED: a correction sent to the shared barcode database; this filing is complete without it
        void reportBarcodeCorrection({
          upc: row.barcode_text,
          field: "title",
          was: row.suggested_name,
          now: committedName,
          userId: sess.id,
          lots: unitLots,
          origin: originOfValue(rowSource, renamed),
          // Renamed → a correction; filed as-is → a confirm vote.
          ...(renamed ? {} : { commitSignal: true }),
        });
      }
      // Same fork as the title: the brand the user COMMITTED is the signal. An
      // edited brand is a CORRECTION (the resolver's was wrong); filed as-is is a
      // vote. Voting row.suggested_manufacturer unconditionally endorsed the very
      // value the user just fixed — the wrong-signal class this block exists to
      // avoid.
      const committedBrand = String(
        (restExtras as { manufacturer?: unknown }).manufacturer ?? row.suggested_manufacturer ?? "",
      ).trim();
      const brandChanged = meaningfullyChanged(row.suggested_manufacturer, committedBrand);
      if (committedBrand) {
        // DETACHED: a correction sent to the shared barcode database; this filing is complete without it
        void reportBarcodeCorrection({
          upc: row.barcode_text,
          field: "brand",
          was: row.suggested_manufacturer,
          now: committedBrand,
          userId: sess.id,
          lots: unitLots,
          origin: originOfValue(rowSource, brandChanged),
          ...(brandChanged ? {} : { commitSignal: true }),
        });
      }
      const committedCategory = (meta as { category?: unknown }).category;
      if (typeof committedCategory === "string" && committedCategory.trim()) {
        // DETACHED: a correction sent to the shared barcode database; this filing is complete without it
        void reportBarcodeCorrection({
          upc: row.barcode_text,
          field: "category",
          was: committedCategory,
          now: committedCategory,
          userId: sess.id,
          lots: unitLots,
          origin: originOfValue(rowSource, false),
          commitSignal: true,
        });
      }
      if (row.catalog_image_url) {
        // DETACHED: a correction sent to the shared barcode database; this filing is complete without it
        void reportBarcodeCorrection({
          upc: row.barcode_text,
          field: "image_url",
          was: row.catalog_image_url,
          now: row.catalog_image_url,
          userId: sess.id,
          lots: unitLots,
          origin: originOfValue(rowSource, false),
          commitSignal: true,
        });
      }
    }

    // A product with no barcode is reported by its label's product words
    // (#3769): only the words also in what the person filed ever leave, with
    // the name, brand and category they settled on. Fire-and-forget.
    const labelWords = (meta as { label_words?: unknown }).label_words;
    if (!row.barcode_text && Array.isArray(labelWords) && labelWords.length >= 3) {
      const filedName = String(body.name ?? filingName(row) ?? "").trim();
      const filedBrand = String((restExtras as { manufacturer?: unknown }).manufacturer ?? row.suggested_manufacturer ?? "").trim() || null;
      const filedCategory = typeof (meta as { category?: unknown }).category === "string" ? String((meta as { category?: unknown }).category) : null;
      const filedColor = typeof (meta as { color?: unknown }).color === "string" ? String((meta as { color?: unknown }).color) : null;
      if (filedName) {
        // DETACHED: teaching the shared label reader; this filing is complete without it
        void reportLabelConfirm({
          labelWords: labelWords.filter((w): w is string => typeof w === "string"),
          name: filedName,
          brand: filedBrand,
          category: filedCategory,
          color: filedColor,
          origin: originOfValue((row.suggested_metadata as { source?: unknown } | null)?.source ?? "vision", meaningfullyChanged(row.suggested_name, filedName)),
          userId: sess.id,
          lots: unitLots,
        });
      }
    }

    if (parsed.data.save_eval_case && sess.is_platform_admin) {
      try {
        const menu = await assembleMergedMenu(baseUrl, ctx.org.slug, token, ctx.org.id);
        await db
          .insertInto("core_scan_eval_cases")
          .values({
            inbox_item_id: id,
            surface: "matchmaker",
            perceived_input: JSON.stringify({
              name: row.suggested_name ?? "",
              manufacturer: row.suggested_manufacturer,
              category: (meta as { category?: string }).category ?? null,
              description: (meta as { description?: string }).description ?? null,
              entityType: (meta as { entity_type?: "asset" | "part" }).entity_type ?? null,
              barcode: row.barcode_text,
            }) as never,
            scan_menu: JSON.stringify(menu) as never,
            candidates: JSON.stringify(row.suggested_candidates ?? []) as never,
            expected: JSON.stringify({
              route: { module: target.module, instance: instance ?? null },
              fields: (extrasMetadata as Record<string, unknown> | undefined) ?? {},
              name: body.name,
            }) as never,
            note: parsed.data.eval_note ?? null,
            created_by_user_id: sess.id,
          })
          .execute();
      } catch (err) {
        console.error("[core-scan] eval-case capture failed:", (err as Error).message);
      }
    }

    // The FIRST purchase is still a purchase. Only add-qty used to file one, so
    // the ledger began at your second buy and cold start lasted one shop longer
    // than it needed to. Announced on the bus, not called: a workspace without
    // Cadence has nobody listening and is unaffected.
    // A thing you ran out of was not bought today: the ledger hears the use
    // (the take above), never a purchase.
    if (created?.id && !ranOutAsked) {
      const firstBuy = buildCadenceEvents({
        mode: "add-qty",
        kind: effectiveKindId,
        entityId: created.id,
        // The same quantity the entity was created with: the request's if it
        // sent one, else the scan row's. `body` is the raw request and does not
        // carry it, which quietly filed every first purchase as a single unit.
        // `qty` is the exact number the entity was created with, already
        // resolved from the request or the scan row (and deliberately undefined
        // for a unique target, which is one thing). Deriving it a second time
        // let the ledger and the record disagree, which is how the fall-back
        // path filed 1 for a scan of 5.
        added: Math.max(1, Number(qty ?? 1)),
        priorQty: 0,
      });
      // Announced, not called. Whoever keeps a consumption ledger listens;
      // this module does not know or care who that is. emit() never rejects.
      for (const ev of firstBuy) {
        await platform().events.emit("core-scan.stock.observed", {
          orgId: ctx.org.id,
          userId: sessionUser(req)?.id ?? null,
          ...ev,
        });
      }
    }

    // The catalog entry picked at confirm (#6888). Checked before anything
    // was made (below the body parse), bound now the record has an id.
    if (created?.id && pickedEntry) {
      await bindToCatalogEntry({ orgId: ctx.org.id, userId: sessionUser(req)?.id ?? null, kind: effectiveKindId, id: created.id, entryId: pickedEntry });
    }

    res.json({
      item: await served(req, resolvedRow),
      created,
      installed: installer.installed,
      ...(created?.id && pickedEntry ? { catalog_entry_id: pickedEntry } : {}),
      ...(ranOutDone ? { ran_out: { took: ranOutDone.took, on_list: ranOutDone.on_list, needs_list: ranOutDone.needs_list, note: ranOutDone.list_note } } : {}),
    });
  }),
);
const IntoLocationBody = z.object({
  location_id: optionalUuid(),
  /** Make a new container location from this scan (the next free "Bin N",
   *  or `name`) and put the scan's identity on it. */
  new_bin: z.boolean().optional(),
  name: optionalField(z.string().trim().min(1).max(120)),
  parent_id: optionalUuid(),
});

// AI-REACH: exempt — pairs the bin label a person just scanned with the
// product they scanned next; only the scanner in hand knows which bin it is
confirmRouter.post(
  "/inbox/:id/confirm-into-location",
  asyncHandler(async (req, res) => {
    if (!requireRole(req, res, "owner", "admin", "member")) return;
    const id = req.params.id;
    if (!id) {
      res.status(400).json({ error: { code: "missing_id", message: "id required" } });
      return;
    }
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
    // The same rule as Confirm: a deleted scan is not put onto a bin (#7144).
    const filingRefused = scanFilingRefusal(row);
    if (filingRefused) {
      res.status(409).json({ error: filingRefused });
      return;
    }
    // The bin: a new one this scan makes (the camera's one-tap Turn into a
    // bin, #6891), an explicit body override, else the one the scan was
    // filed into.
    const body = IntoLocationBody.safeParse(req.body ?? {});
    if (!body.success) return badBody(res, body.error);
    const locationKind = "core-locations:location";
    const writer = await platform().entities.getWriter(ctx.org.id, locationKind);
    let made: { id: string; name: string } | null = null;
    if (body.data.new_bin) {
      if (!writer?.create) {
        res.status(501).json({ error: { code: "no_location_writer", message: "Locations module is not available." } });
        return;
      }
      const name = body.data.name?.trim() || nextBinName(
        (await platform().entities.listAll(ctx.org.id, locationKind, { q: "bin" })).items.map((l) => l.title),
      );
      try {
        made = { id: await writer.create(ctx.org.id, { name, kind: "container", ...(body.data.parent_id ? { parent_id: body.data.parent_id } : {}) }), name };
      } catch (err) {
        res.status(409).json({ error: { code: "duplicate_sibling", message: (err as Error).message } });
        return;
      }
    }
    const locId = made?.id ?? body.data.location_id ?? row.target_location_id;
    if (!locId) {
      res.status(400).json({
        error: {
          code: "no_active_bin",
          message: "This scan wasn't filed into a bin. Scan the bin's QR first, then the product barcode.",
        },
      });
      return;
    }

    // The bin is written through its owning module's registered entity WRITER
    // (the same sanctioned seam the sync engine uses) — module validation +
    // events fire; core-scan never touches another module's table or URL.
    if (!writer?.read) {
      res.status(501).json({
        error: { code: "no_location_writer", message: "Locations module is not available." },
      });
      return;
    }
    const loc = await writer.read(ctx.org.id, locId);
    if (!loc) {
      res.status(404).json({ error: { code: "not_found", message: "bin not found" } });
      return;
    }

    const meta = (row.suggested_metadata as Record<string, unknown> | null) ?? {};
    // The writer replaces metadata wholesale — merge over the current blob so
    // the identity never wipes what's already on the bin. container_* is the
    // structured face; barcode/sku let a future catalog re-match find it.
    const identity: Record<string, unknown> = {
      container_product: row.suggested_name ?? undefined,
      container_brand: row.suggested_manufacturer ?? undefined,
      barcode: row.barcode_text ?? undefined,
      sku: row.suggested_sku ?? undefined,
      ...(typeof (meta as { category?: unknown }).category === "string"
        ? { container_category: (meta as { category?: string }).category }
        : {}),
    };
    for (const k of Object.keys(identity)) if (identity[k] === undefined) delete identity[k];
    const currentMeta = (loc.metadata as Record<string, unknown> | null) ?? {};
    const fields: Record<string, unknown> = { metadata: { ...currentMeta, ...identity } };
    if (!loc.description && row.suggested_name) fields.description = row.suggested_name;
    if (!loc.image_path) {
      // Carry the scan's image onto the part. It USED to transfer ONLY a stored
      // file (catalog_image_file_id) — so an item whose image was still a raw
      // web URL (not downloaded yet, or committed mid-enrich) lost its image on
      // commit (reported 2026-07-24). Prefer the stored file; else fall back to the
      // raw URL so the image is NEVER dropped — set INSTANTLY (no network in the
      // commit path: downloading inline made a bulk "Confirm all" hang, ~25s per
      // line worst case, reported 2026-07-25). A raw catalog URL can be hotlink-blocked
      // and render broken, so we ALSO kick off a background download that repoints
      // the part at a stored same-origin file once it lands — commit stays fast.
      const imagePath = committedImagePath(ctx.org.slug, row.catalog_image_file_id, row.catalog_image_url);
      if (imagePath) fields.image_path = imagePath;
      if (!row.catalog_image_file_id && row.catalog_image_url) {
        const url = row.catalog_image_url;
        const itemId = id;
        // DETACHED: storing the catalog photo locally; the record shows the catalog address until it lands
        void (async () => {
          try {
            const ok = await downloadCatalogImage({ db, orgId: ctx.org.id, itemId }, url);
            if (!ok) return;
            const fresh = await db
              .selectFrom("core_scan_inbox_items")
              .select(["catalog_image_file_id"])
              .where("id", "=", itemId)
              .executeTakeFirst();
            const fid = fresh?.catalog_image_file_id;
            if (fid) {
              const stored = committedImagePath(ctx.org.slug, fid, null);
              if (stored) await writer.update(ctx.org.id, locId, { image_path: stored });
            }
          } catch (err) {
            console.warn("[core-scan] background catalog-image upgrade failed:", (err as Error).message);
          }
        })();
      }
    }
    await writer.update(ctx.org.id, locId, fields);

    const [locModule, locKind] = locationKind.split(":") as [string, string];
    const resolvedRow = await db
      .updateTable("core_scan_inbox_items")
      .set({
        status: "resolved",
        target_module: locModule,
        target_kind: locKind,
        target_entity_id: locId,
        // What Undo needs (/unconfirm): a bin this scan made goes away with
        // it; a bin that was already there stays, with what it said before.
        suggested_metadata: mergeMeta({
          attached_to: made
            ? { kind: locationKind, id: locId, mode: NEW_BIN }
            : { kind: locationKind, id: locId, mode: INTO_BIN, before: { metadata: currentMeta, description: loc.description ?? null, image_path: loc.image_path ?? null } },
        }) as never,
        resolved_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      // CAS: the bin-identity merge above is additive/idempotent, so the only
      // thing a racing second caller must not do is double-resolve — losing
      // the flip means someone else already confirmed this row.
      .where("status", "=", "pending")
      .returningAll()
      .executeTakeFirst();
    if (!resolvedRow && made && writer?.delete) await writer.delete(ctx.org.id, made.id).catch(() => null);
    if (!resolvedRow) {
      res.status(409).json({
        error: { code: "already_resolved", message: "This item was already confirmed." },
      });
      return;
    }

    void platform().events.emit("core-scan.scan.confirmed", {
      orgId: ctx.org.id,
      itemId: id,
      targetModule: locModule,
      targetKind: locKind,
      entityId: locId,
    });

    res.json({ item: await served(req, resolvedRow), location_id: locId, location_name: made?.name ?? String(loc.name ?? "") });
  }),
);
