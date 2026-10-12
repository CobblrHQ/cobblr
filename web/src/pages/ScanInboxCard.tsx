import { NumberStepper, RecordFormModal, NewFromTemplateButton, useLater, useImageSrc, EntityPhoto, useOverlayOpenFlag, useToast, colorSwatch, wantsSwatch, ColourInput, valueFromInput, PopoverLayer, BackdropLayer, FieldPack, fieldNeed, fieldControl, fieldPackControlClass, type FieldType, relativeTime, SearchInput, ChoiceCombobox, ChoiceField, offersClarifier, noteKey, WorkspaceLink } from "@cobblr/platform-web";
// The scan inbox's DESKTOP card, and the pieces only it renders: the
// collapsed strip (photo column, title, facts, filing pair, tool rail), the
// expanded triage surface (photos beside intel, the confirm form, the AI
// evidence and correction boxes), and the sheets it opens (make a bin, photo
// options). InboxCard is also the BRAIN of the phone surfaces: it computes
// every value and mutation once and hands them to ScanPhoneRow and
// ScanItemScreen, so a phone and a desk never disagree about an item.
//
// Extracted from ScanPage.tsx (which had grown past ten thousand lines)
// with no change in behaviour; the page renders one InboxCard per item and
// owns the queue, the session chrome and the page-level menu.
import { leadWords } from "../lib/lead-words";
import { useMatchAmount } from "../lib/useMatchAmount";
import { isOwnCopy } from "@cobblr/platform-contract/share-offer";
import { ScanOfferStrip } from "./ScanOfferStrip";
import { readInboxOffer } from "@cobblr/platform-contract/share-offer";
import { addedByCardWords, cardSaysAddedBy, codeSourceNote, codeSourceOf, type AddedBy } from "@cobblr/platform-contract/scan-source";
import { type FieldRole } from "@cobblr/platform-contract/field-vocabulary";
import { ROLE_CLARIFIES } from "@cobblr/platform-contract/field-vocabulary";
import { createPortal } from "react-dom";
import { SamePictureOffer, ScanTwinsContext, TWIN_SENTENCE } from "./scanTwins";
import { useAwaitingWords, type AwaitingWords } from "./awaitingLookup";
import { answeredByLine } from "@cobblr/platform-contract/provider-reason";
import { useAutoGrowTextarea } from "../lib/useAutoGrowTextarea";
import { } from "../components/FileEverythingSheet";
import { } from "../components/UploadKindSheet";
import { } from "../components/SessionReadVerdict";

import { Fragment, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { StationNewFace } from "./StationNewFace";
import { Camera, CheckCircle, ChevronDown, Download, ExternalLink, Flag, Image as ImageIcon, ImagePlus, Library, Loader2, MapPin, MoreHorizontal, Pencil, RefreshCw, RotateCcw, ScanLine, Scissors, Sparkles, X, Database } from "lucide-react";
import { } from "../components/ScanImportModal";
import { suggestedPlace } from "../lib/sessionPlaceSuggestion";
import { } from "../components/ExportInboxModal";
import { CameraCaptureSheet } from "../components/CameraCaptureSheet";
import { ContributedDetailPanels } from "../panels/registry";
import { LocationChipPicker } from "../components/LocationChipPicker";
import { } from "../components/SessionLocationModal";
import { } from "../components/OrganizeWalkSheet";
import { } from "../components/LiveSortSheet";
import { ImageSearchPicker } from "../components/ImageSearchPicker";
import { CropPhotoModal } from "../components/CropPhotoModal";
import { imageUrlFrom } from "../components/pastedImage";
import { ImageLightbox, type LightboxItem } from "../components/ImageLightbox";
import { ScanYourPhotos } from "../components/ScanYourPhotos";
import { catalogCaption, leadYours, rowPictures, scanFileUrl, shownPictureUrl, yourPictures } from "../lib/rowPictures";
import { catalogUnsaved, COULDNT_SAVE_WORDS } from "@cobblr/platform-contract/scan-pictures";
import { } from "../components/ReceiptPeek";
import { fieldsStillOnTable, fieldsNoLongerOnTable, isQuietDefault, isImpliedByPeer, isStatedByReceipt } from "../lib/scanCandidateFields";
import { canRerunLookup } from "../lib/scanRerun";
import { headingSaysItAll, namelessReason, namelessRemedy } from "../lib/identifySentence";
import { MATCH_FAILED_WORDS, RUN_NO_ANSWER_WORDS, namelessWords } from "@cobblr/platform-contract/scan-nameless";
import { namelessCard } from "../lib/namelessCard";
import { fallbackChip, identifyFailureWords, type IdentifyFailure } from "@cobblr/platform-contract/scan-fallback";
import { TrackedMatchBanner, TrackedMatchLine } from "../components/TrackedMatchBanner";
import { scanCountVerb, useScanCountSave } from "../components/ScanCountBlock";
import { addedPlaceSentence } from "../lib/scan-place-words";
import { scanAddCount, scanCountResult } from "@cobblr/platform-contract/scan-count";
import { packPartsNote } from "@cobblr/platform-contract/store-product";
import { OrderLineOffer, OrderLineUnits } from "../components/OrderLineUnits";
import { } from "../components/BinAdjustModal";
import { HeaderMenu, MenuItem } from "../components/HeaderMenu";
import { } from "./DuplicateRecordsSheet";
import { } from "../components/ReceiptAddressChip";
import { catalogUndoHistory, catalogUndoLabel, catalogUndoTitle } from "./scanCatalogUndo";
import { shouldPersistNameEdit } from "./scanNameEdit";
import { ChipFields, type ChipFieldDef, type ChipFieldType } from "../components/ChipFields";
import { useAiStatus, aiStatusLine, aiReach } from "../components/AiStatusNotice";
import { filingLabel } from "../lib/scanFiling";
import { measureDevice, photoPressAction } from "../lib/photoDevice";
import { useHandheld } from "../lib/useHandheld";
import { SHEET_ACTION_CLASS, SheetActionLabel, type ScanItemSheetNav } from "./ScanItemSheet";
import { } from "./ScanInboxMenu";
import { ScanPhoneRow, type ScanPhoneRowAction } from "./ScanPhoneRow";
import { ScanItemScreen, screenIcons, type ScanItemScreenAction } from "./ScanItemScreen";
import { scanNotesPlacement } from "../lib/scanNotes";
import { ScanCardCommit } from "../components/ScanCardCommit";
import { ScanToolMenu } from "../components/ScanToolMenu";
import { BOX_STATE_EFFECT } from "@cobblr/platform-contract/scan-tools";
import { displayIdentity, displayName, modelNameBeside, compactCardFields, humanFieldLabel } from "@cobblr/platform-contract/display-identity";
import { useHeldField, useHeldRecord } from "../lib/scanHeldField";
import { ScanTitleInPlace } from "./ScanTitleInPlace";
import { ScanChoiceSelect, canGrowChoices } from "./ScanChoiceSelect";
import type { ScanTool } from "@cobblr/platform-contract/scan-tools";
import { shouldOfferSplit } from "../lib/splitOffer";
import { leadPhoto, photoOrder, photoUnverified, catalogRungs } from "../lib/scanPhoto";
import { } from "../lib/scanCombine";
import { entryKey, withRoutedInstances, pickDestinationKey } from "../lib/scanDestination";
import {
  type AiStatus,
  ApiError,
  api,
  type ImageOption,
  type ScanInboxItem,
  type ScanCandidate,
  type ScanMenuEntry,
  type TrackedMatch,
} from "../lib/api";
import { } from "../lib/scanPayload";
import { needsScanReview, scanRebuy, scanLooksFineResolves, scanDoubt, scanDoubtWords, scanProvenanceNote, scanReceiptReadFailed, scanReceiptAlreadyIn, scanSplitUncut, scanReviewQuestions, scanReviewReason, scanRowState, scanTrackedMatch, scanDeclinesRecord } from "@cobblr/platform-contract/scan-triage";
import { SCAN_UNDO_ACTIONS, scanCombinedCount } from "@cobblr/platform-contract/scan-recovery";
import { ScanReceiptUnread } from "../components/ScanReceiptUnread";
import { scanAssertedFields, fieldStandingsOf } from "@cobblr/platform-contract/scan-evidence";
import { provenanceHeadline, provenanceLines } from "@cobblr/platform-contract/field-contributions";
import { KEYWORD_ROUTE_SENTENCE, ACTION_ADD, actionInstallAdd, PHOTO_CHECK_NOTE, photoCheckIsLive } from "@cobblr/platform-contract/scan-copy";
import { matchParentType, readField } from "../lib/parent-type-match";
import { isRerunInFlight } from "./scan-status";
import { baseKind } from "./scanFileAll";
import { resolveInstanceForFiling } from "./scanInstall";
import { cleanCandidates, quickFileRow } from "./scanQuickFile";
import { creatorOf, seriesOf } from "../components/ScanSeriesBanner";
import { looksLikeContainer, nextBinName } from "./scanContainer";
import {
  declaredCategoryAxis,
  categoryChipLabel,
  categoryTravelsByName,
  tableCategoryAxis,
} from "./sessionCategory";
import { } from "../lib/chat-context";
import { } from "../lib/useBarcodeWedge";
import { } from "../hooks/useBrowserDrive";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { WHO_ANSWERS_ANCHOR } from "../components/WhoAnswersSection";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import { raiseBlockedAction } from "../lib/blocked-action";
import { useScanViewer } from "./scanViewer";
import { useFieldPresentation } from "../lib/useFieldPresentation";
import { useAuth } from "../auth/AuthContext";
import { type ScanTarget } from "./scanInboxShared";
import { ScanNameItInline as NameItInline } from "../components/ScanNameItInline";
import { LOOKUP_GAVE_UP, RECEIPT_READ_AGAIN, RECEIPT_UNREAD_SENTENCE, RECEIPT_READ_ANYWAY, classifiedCodeOf, receiptAlreadyInSentence } from "@cobblr/platform-contract/scan-copy";
import { scanInboxKeys } from "../lib/scan-inbox-keys";
import { withArticle } from "@cobblr/platform-contract/plural";
import { formatStoredMoney } from "@cobblr/platform-contract/money";

import { countOf } from "@cobblr/platform-contract/plural";
/** Base-kind fallback for when the scan menu can't load — the menu
 *  (GET /modules/core-scan/menu) is the real source of truth and lists
 *  the workspace's ACTUAL tables ("Yarn"), not module names. */
const FALLBACK_MENU: ScanMenuEntry[] = [
  { module: "inventory", instance: null, kind: "inventory:part", noun: "part", label: "Inventory part", fields: [] },
  { module: "assets", instance: null, kind: "assets:asset", noun: "asset", label: "Asset", fields: [] },
  { module: "machines", instance: null, kind: "machines:machine", noun: "machine", label: "Machine", fields: [] },
];

// ── scan-drives-screen (Phase 1) ─────────────────────────────────────────────

/** True when the item never got a real identity — no name, or the AI's
 *  "couldn't identify it" placeholder ("Unknown Item"). Used to suppress the
 *  catalog photo search (searching "Unknown Item" returns junk) and the default
 *  commit target (don't pre-route an unidentified thing into Inventory). */
function isUnidentified(name: string | null | undefined): boolean {
  const n = (name ?? "").trim();
  const lc = n.toLowerCase();
  if (!n || lc === "unknown" || lc === "unknown item" || lc === "unidentified" || lc.startsWith("unknown ")) {
    return true;
  }
  // Junk placeholders already stored before the backend guard landed: a run of
  // one character ("XXXXXXXX") or too short to be a product.
  const alnum = n.replace(/[^a-z0-9]/gi, "");
  return alnum.length < 3 || /(.)\1{3,}/i.test(alnum);
}

/** How a combine offer was found — drives the banner's wording + which item it
 *  keeps. "name" = same brand + product words; "barcode" = an OCR-read barcode
 *  that's a near-match to one you scanned earlier. */


/** A vendor/URL resolver (a Polar spool QR, …) stows its structured parse under
 *  `suggested_metadata.fields` — keys aligned to field-def names (size,
 *  batch_code, material, color, …). Pull that nested object out as a flat map. */

/** A vendor/URL resolver (a Polar spool QR, …) stows its structured parse under
 *  `suggested_metadata.fields` — keys aligned to field-def names (size,
 *  batch_code, material, color, …). Pull that nested object out as a flat map. */
function parsedScanFields(meta: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const f = meta?.fields;
  return f && typeof f === "object" && !Array.isArray(f) ? (f as Record<string, unknown>) : {};
}

/** "batch_code" -> "Batch code". Display label for a parsed field we don't have
 *  a field-def label for (it lands on a linked entity, e.g. the filament type). */

/** "batch_code" -> "Batch code". Display label for a parsed field we don't have
 *  a field-def label for (it lands on a linked entity, e.g. the filament type). */
function humanizeKey(k: string): string {
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// `colorSwatch` (a colour value → CSS colour) now lives in @cobblr/platform-web
// so the scan form and the shared EntityThumb agree on what renders as a
// swatch. Imported at the top of this file.

/** The at-the-moment-of-pain variant: a nameless miss in the confirm flow. */

/** The at-the-moment-of-pain variant: a nameless miss in the confirm flow. */
export function AiOffMissHint({ status }: { status: AiStatus | null }) {
  const line = aiStatusLine(status, "identify");
  if (!line) return null;
  return (
    <p className="text-xs text-amber-600 dark:text-amber-400">
      No catalog match - and no AI is set up to identify it, so name it
      yourself.{" "}
      {/* The link and its verb come from the one resolver, so this hint can
          never offer a connect path the operator has switched off. */}
      {line.cta && (
        <>
          <Link to={line.cta.to} className="underline">
            {line.cta.label.replace(/\s*\u2192$/, "")}
          </Link>{" "}
          to have these filled automatically.
        </>
      )}
    </p>
  );
}

/** Inline corrector for a barcode item whose resolved name is wrong. PATCHes the
 *  name (which, server-side, reports the fix to the shared Barcode Intelligence
 *  DB so the next scan of this UPC is right everywhere). Pre-filled with the
 *  current name so it's a quick edit, not a retype. */
/** The carrier vocabulary in words a person uses. Six states, so a table
 *  rather than a chain of conditions — and an unmapped one falls through to
 *  itself instead of rendering blank. */


function CorrectNameInline({
  slug,
  itemId,
  initial,
  onDone,
  large = false,
}: {
  slug: string;
  itemId: string;
  initial: string;
  onDone: () => void;
  /** A Station's size: a kiosk is read and tapped from arm's length. */
  large?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  // DRAFT-OK: a correction form opened on purpose and closed when sent; the person is the one changing it.
  const [name, setName] = useState(initial);
  const mut = useMutation({
    mutationFn: () => api.updateScanItem(slug, itemId, { name: name.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(slug) });
      toast.success("Fixed - thanks, that sharpens future scans of this barcode.");
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <div className="mt-1 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
      <input
        value={name}
        autoFocus
        onChange={(e) => setName(e.target.value)}
        aria-label="Correct the product name"
        className={large ? "input flex-1 !py-3 text-xl" : "input !py-1 text-xs flex-1"}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) mut.mutate();
          if (e.key === "Escape") onDone();
        }}
      />
      <button
        type="button"
        disabled={!name.trim() || mut.isPending}
        onClick={() => mut.mutate()}
        className={`shrink-0 rounded bg-amber-600 text-white font-medium hover:bg-amber-700 transition disabled:opacity-50 ${large ? "px-5 py-3 text-xl" : "text-xs px-2.5 py-1"}`}
      >
        Fix
      </button>
      <button type="button" onClick={onDone} className={large ? "shrink-0 px-3 py-3 text-xl text-muted" : "shrink-0 text-xs text-faint px-1.5 py-1"}>
        Cancel
      </button>
    </div>
  );
}

/** Where scans confirm into — a module instance (e.g. the "yarn" inventory
 *  instance), passed via the URL when you scan from an instance's table. */

function MakeBinSheet({
  item,
  onClose,
  onArmBin,
}: {
  item: ScanInboxItem;
  onClose: () => void;
  onArmBin?: (locId: string) => void;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const locs = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const suggested = useMemo(
    () => nextBinName((locs.data?.items ?? []).map((l) => l.name)),
    [locs.data],
  );
  const [name, setName] = useState("");
  const [parent, setParent] = useState<string | null>(item.target_location_id ?? null);
  // Seed the name once the locations land — not on every refetch, or typing races.
  const seeded = useRef(false);
  useEffect(() => {
    if (!seeded.current && locs.data) {
      setName(suggested);
      seeded.current = true;
    }
  }, [locs.data, suggested]);
  const create = useMutation({
    mutationFn: async (arm: boolean) => {
      const loc = await api.createLocation(activeSlug, {
        name: name.trim(),
        kind: "container",
        ...(parent ? { parent_id: parent } : {}),
      });
      await api.confirmScanIntoLocation(activeSlug, item.id, loc.id);
      return { loc, arm };
    },
    onSuccess: ({ loc, arm }) => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      void qc.invalidateQueries({ queryKey: ["core-locations", activeSlug] });
      if (arm) onArmBin?.(loc.id);
      toast.success(
        arm ? `${loc.name} created - new scans file into it` : `${loc.name} created`,
      );
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const busy = create.isPending;
  return (
    <RecordFormModal open onClose={onClose} title="Turn this into a bin">
      <div className="space-y-3">
        <p className="text-xs text-muted dark:text-slate-400">
          Creates a location from this scan in one step: the product photo, barcode
          and brand land on the bin&rsquo;s record and the inbox item is done. The
          bin&rsquo;s name is yours; the product identity rides underneath.
        </p>
        <label className="block">
          <span className="text-xs font-medium text-content dark:text-mortar-100">Bin name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim() && !busy) create.mutate(true);
            }}
            className="mt-1 w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-800 px-2 py-1.5 text-sm text-content dark:text-mortar-100"
          />
        </label>
        <div>
          <div className="text-xs font-medium text-content dark:text-mortar-100 mb-1">
            Where does the bin live? <span className="font-normal text-faint">(optional)</span>
          </div>
          <div className="max-h-44 overflow-y-auto">
            <LocationChipPicker value={parent} onChange={setParent} />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => create.mutate(false)}
            className="rounded border border-line dark:border-slate-600 px-3 py-1.5 text-sm text-muted dark:text-slate-300 hover:bg-mortar-50 dark:hover:bg-slate-800 transition disabled:opacity-50"
          >
            Create bin
          </button>
          <button
            type="button"
            disabled={busy || !name.trim()}
            onClick={() => create.mutate(true)}
            className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm font-medium transition disabled:opacity-50"
          >
            {busy ? "Creating…" : "Create & scan into it"}
          </button>
        </div>
      </div>
    </RecordFormModal>
  );
}


/** The phone row's count save is a hook, so it runs on every row; a row with
 *  no counted match hands it this and never calls it. */
const NO_COUNTED_MATCH = { kind: "", id: "", instance: null, title: "", qty: 0 } as unknown as TrackedMatch;

/** Who a value came from, said beside it as the record page does
 *  ("3DPrintopia 2026 · Jai"): the field's note from the candidate's own
 *  fields, or nothing. One reader for the desk card and the phone row. */
function whoFromBeside(fields: unknown, key: string): string {
  const v = (fields as Record<string, unknown> | null | undefined)?.[noteKey(key)];
  return v != null && String(v).trim() ? ` · ${String(v).trim()}` : "";
}

export function InboxCard({
  item,
  pageTarget,
  menu,
  sessionCategoryLabel,
  sessionSource,
  hasLocations,
  selected,
  onToggleSelect,
  defaultExpanded,
  openSignal,
  planContext,
  onCollapse,
  onArmBin,
  sheet,
  onOpenSheet,
  defaultCand,
  selectionActive,
  station,
}: {
  item: ScanInboxItem;
  pageTarget: ScanTarget | null;
  menu: ScanMenuEntry[] | null;
  /** The label this item's SESSION agreed on, so sibling cards cannot show one
   *  category two ways. Null when the session settled on nothing. */
  sessionCategoryLabel?: string | null;
  /** Where this item's SESSION came from (platform-contract scan-source):
   *  who added it, said once in the header, and whether it was emailed, so a
   *  code off it reads "from the email". */
  sessionSource?: { addedBy: AddedBy | null; emailed: boolean } | null;
  hasLocations: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  /** Open pre-expanded (the gallery view's focus modal). */
  defaultExpanded?: boolean;
  /** Opens the card in place when it changes to a new non-zero value: a link
   *  to this row from search or the dashboard (`/scan?item=`, #3909). */
  openSignal?: number;
  /** Rendered INSIDE an organize plan's accordion: the card is an identity
   *  FIXER there (name, photo, AI hint/rerun), never a commit surface —
   *  confirming into a table mid-plan yanks the item out of the plan (the
   *  trap the author hit). Hides the confirm form, table chips, and
   *  discard; the accordion owns collapse. */
  planContext?: boolean;
  /** In planContext, fully close the accordion row (the card is always expanded
   *  there, so the ▲ chevron delegates here instead of toggling its own body,
   *  which would leave the outer "Done fixing" box behind). */
  onCollapse?: () => void;
  /** "Turn into a bin" armed the new bin as the standing file-bin — the page
   *  owns that state (localStorage + header chip), so it passes the setter. */
  onArmBin?: (locId: string) => void;
  /** Rendered as the ITEM SHEET: the whole screen on a phone, one item at a
   *  time, with "All items" and previous/next in a pinned header and the
   *  commit action in a pinned footer (#2982). The list row's own expand,
   *  thumbnail and collapse controls stand down; the sheet is the expansion. */
  sheet?: ScanItemSheetNav;
  /** In the list, on a phone: expanding opens the item sheet instead of
   *  unfolding the row in place (a chip tap carries its candidate along, so
   *  the sheet opens on that table's form). */
  onOpenSheet?: (cand: ScanCandidate | null) => void;
  /** With `defaultExpanded`: the candidate the form opens on. */
  defaultCand?: ScanCandidate | null;
  /** Something in the list is selected, so the phone row shows its checkbox. */
  selectionActive?: boolean;
  /** At a Station (#4640): the record card's scale first (photo, name, how
   *  many, one big Add), with More for this whole card. `onFiled` runs once
   *  the Add has filed it. */
  station?: { onFiled: () => void };
}) {
  const { activeSlug } = useActiveOrg();
  const handheld = useHandheld();
  const qc = useQueryClient();
  const toast = useToast();

  // Locations, only to name the filing bin on the card. Same query key as the
  // page's list, so this reads the shared react-query cache — no extra fetch.
  const cardLocs = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug && hasLocations,
    staleTime: 60_000,
  });

  // The expansion's confirm context: which table/instance the form commits
  // into + the matchmaker's pre-filled fields. Keyed into ConfirmForm so
  // switching chips remounts (and so re-seeds) the form.
  const [expanded, setExpanded] = useState(false);
  const [stationMore, setStationMore] = useState(false);
  const [stationFixing, setStationFixing] = useState(false);
  // The list row on a phone: what decides whether to open the item, and the
  // one verb that files it. Everything else waits in the sheet, one tap away,
  // with the whole screen (scan-inbox-device-split.md §3.4).
  const phoneRow = handheld && !!onOpenSheet && !expanded;
  // The source-data box's disclosure — OPEN by default (provenance + the routed
  // fields at a glance); tap to collapse.
  // On a phone it starts closed: the sheet reads one item at a time and the
  // evidence is one tap away, under the pictures, when asked for.
  const [aiOpen, setAiOpen] = useState(() => !handheld);
  const [formCtx, setFormCtx] = useState<{
    selKey: string | null;
    prefill: Record<string, unknown>;
  }>({
    selKey: pageTarget ? entryKey(pageTarget.module, pageTarget.instance) : null,
    prefill: {},
  });
  // The commit form is SUMMONED, not ambient (scan-inbox-ux-review.md F1): a
  // plain expand shows the triage surface only, and the form renders once a
  // destination is picked — a chip tap, the "Add to …" summon row, or the
  // gallery-focus modal. Rendering every field of the top table on every
  // expand is what buried a tote under six empty vehicle boxes.
  const [formOpen, setFormOpen] = useState(false);
  // The table the person picked in the OPEN form. Saving it makes the served
  // row lead with it (#3587), which changes the answer's signature; that is
  // the form's own choice coming back, not a new answer, so it must not
  // remount the form over what they are typing.
  const formPickedKey = useRef<string | null>(null);
  // Collapse ENDS editing, whichever control collapsed the card. The form's
  // chips replace the header row's read-only chips while it is open, but the
  // form itself lives in the expanded body — so a card collapsed mid-edit kept
  // formOpen and showed NO chips at all: the read-only ones hidden, the
  // editable ones unmounted. The edits were already lost on collapse (the form
  // unmounts with the body); this makes the state say so.
  useEffect(() => {
    if (!expanded) setFormOpen(false);
  }, [expanded]);

  function expandOnly() {
    if (onOpenSheet && handheld && !expanded) {
      onOpenSheet(null);
      return;
    }
    setExpanded(true);
  }

  function openForm(cand?: ScanCandidate) {
    // No explicit chip and no ?into= target → open on the row's DESTINATION
    // (the pill's table), fields pre-filled when the matchmaker read some. Not
    // the top candidate: when a person or a better table moved the row, the
    // form asked for the old table's fields under the new table's name. Expanding a card should land on the
    // AI's best read, not a blank form (the chip tap is a shortcut, not a
    // requirement).
    // An unidentified item ("Unknown Item") shouldn't auto-route anywhere —
    // leave the target unselected so the user picks, rather than pre-filling
    // "Inventory part" for a thing we couldn't identify.
    if (onOpenSheet && handheld && !expanded) {
      onOpenSheet(cand ?? null);
      return;
    }
    const pick =
      cand ?? (pageTarget || isUnidentified(item.suggested_name) ? null : (dest ?? null));
    formPickedKey.current = null;
    setFormCtx(
      pick
        ? { selKey: entryKey(pick.module, pick.instance), prefill: pick.fields }
        : {
            selKey: pageTarget ? entryKey(pageTarget.module, pageTarget.instance) : null,
            prefill: {},
          },
    );
    setFormOpen(true);
    setExpanded(true);
  }

  useEffect(() => {
    if (openSignal) setExpanded(true);
  }, [openSignal]);
  // Gallery focus modal opens the card pre-expanded (one tap to triage);
  // plan accordions expand WITHOUT arming the (hidden) confirm form.
  useEffect(() => {
    if (defaultExpanded) {
      if (planContext) setExpanded(true);
      else openForm(defaultCand ?? undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The matchmaker is SERVER-OWNED: it runs once at intake (detached) and
  // inline during a rerun. The web never auto-triggers it — a page load
  // costs zero model runs. While the server hasn't stamped matched_at yet,
  // the card shows a passive "AI is reading…" pulse that the 8s list poll
  // resolves on its own.
  // Drop candidates that would file an EMPTY record — a table the matchmaker
  // thought fit but extracted 0 fields for (e.g. a bare "Home Inventory" chip
  // sitting next to "Bookshelf · 4 fields"). It reads like an equal option but
  // fills nothing. Always keep the top match though (index 0), so a weak-but-
  // best guess still offers somewhere to go; the full table picker in the
  // confirm form still lists every table if the user wants one of the dropped.
  // `fields` is non-optional on the type, so every read below takes it on
  // trust; the DATA can lie. An import door writes an envelope's candidates
  // verbatim, and one without a fields key took the whole page down with
  // "Cannot convert undefined or null to object" (#3392). The importer
  // normalises it now, and this is the guard for rows already stored: one
  // place, rather than a ?? {} at each read that the next one will forget.
  const candidates = cleanCandidates(item)
    .filter((c, i) => i === 0 || Object.keys(c.fields).length > 0)
    .slice(0, 3);
  const topCand = candidates[0] ?? null;
  // The destination is now CHOSEN, not just the top match: the split chip
  // carries a picker, so the other candidates are options in it rather than
  // chips of their own. Everything downstream reads `dest`, so the gates and
  // the one-tap commit follow the choice instead of the ranking.
  // Opened with a destination in hand (the phone row's override, a chip
  // tap), the screen starts on it rather than on the top match.
  const [destKey, setDestKey] = useState<string | null>(defaultCand ? entryKey(defaultCand.module, defaultCand.instance) : null);
  const [destOpen, setDestOpen] = useState(false);
  // The picker's dismiss layer covers the whole app, so floating chrome (the
  // Live pill, the feedback bubble) has to yield to it like any overlay.
  useOverlayOpenFlag(destOpen);
  // The menu PORTALS to body, positioned from the pill's rect. Anchored in
  // place it was clipped by the card's own bounds - it opened below correctly
  // and simply could not be seen past the second option.
  const destBtnRef = useRef<HTMLButtonElement | null>(null);
  const [destRect, setDestRect] = useState<{ top: number; left: number; above: number } | null>(null);
  const openDest = () => {
    const r = destBtnRef.current?.getBoundingClientRect();
    // PopoverLayer moves the menu back onto the screen from what it drew; a
    // clamp here from an assumed width is what ran off a phone (#3930).
    if (r) setDestRect({ top: r.bottom + 4, left: r.left, above: r.top });
    setDestOpen(true);
  };
  const closeDest = () => {
    setDestOpen(false);
    // Hand focus back to the pill, so Escape doesn't dump keyboard users at
    // the document root. The native <select> this replaced did all of this
    // for free — everything here is paying that debt back.
    destBtnRef.current?.focus();
  };
  // The menu's position is measured ONCE at open, so a page that scrolls
  // underneath would leave it floating detached from the pill. Close instead
  // of chasing it: a scroll mid-pick means attention moved elsewhere.
  useEffect(() => {
    if (!destOpen) return;
    const onScroll = () => setDestOpen(false);
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", onScroll, { capture: true });
  }, [destOpen]);
  // EVERY table, not just the matchmaker's guesses. The old "add somewhere
  // else…" existed because the chips only offered what the AI proposed; with a
  // picker there is no reason to hide the rest. Candidates keep their extracted
  // fields and lead the list; the remaining tables follow with none.
  const destOptions = (() => {
    const base = withRoutedInstances(menu && menu.length > 0 ? menu : FALLBACK_MENU, candidates);
    const seen = new Set(candidates.map((c) => entryKey(c.module, c.instance)));
    const rest = base
      .filter((m) => !seen.has(entryKey(m.module, m.instance)))
      // Same shape as a candidate, minus the things only the matchmaker knows
      // (no extracted fields, no basis, no bundle to install).
      .map(
        (m) =>
          ({
            ...m,
            instance: m.instance ?? null,
            fields: {} as Record<string, string>,
            // A table you picked yourself carries no matchmaker verdict: no
            // extracted name, no confidence. Explicit rather than cast away.
            name: item.suggested_name ?? "",
            confidence: 0,
          }) as (typeof candidates)[number],
      );
    return [...candidates, ...rest];
  })();
  // Who is looking: the workspace's tables, whether this person may install
  // one and whether they may file into each, the same answer the page's
  // session strip reads (scanViewer.ts).
  const viewer = useScanViewer(menu);
  // THE row's state (#3059 Engine 1): eligibility, the one sentence, the
  // action's words and the destination, resolved once in the contract and
  // rendered here, on the phone row and on the item screen alike. The
  // destination it answers with is a person's stored choice when there is
  // one, else the system's route, replaced by a better table the workspace
  // has gained since (the owner's ruling: an untouched system choice may be
  // replaced; a person's never).
  // The fields the AI supplied rather than read, from their stamps: shown
  // apart from the confirmed ones, never dressed in the confidence number.
  const assertedFields = scanAssertedFields(item);
  // Fields several sources spoke to: the headline names the decisive one and
  // the lines under it list every contribution, from one list (#4583).
  const contributedFields = Object.entries(fieldStandingsOf(item.suggested_metadata)).filter(([, st]) => (st.contributions?.length ?? 0) > 0);
  const rowState = scanRowState(item, {
    ...viewer,
    fieldLabel: (name) => (topCand ? menuFieldLabel(menu, topCand, name) : name),
  });
  const resolvedDestKey = rowState.destination ? entryKey(rowState.destination.module, rowState.destination.instance) : null;
  // A re-purchase adds to the record it matched, so the pill names that
  // record in its table ("Whole milk in Groceries"), not only a table a NEW
  // item would go to: the pill once said Inventory while Replaced wrote to
  // the milk in Groceries (#3707).
  const updating = rowState.destination?.updates ?? null;
  // A receipt whose lines could not be read is a receipt, not a nameless
  // item: the contract says which, and every surface draws the same block
  // (ScanReceiptUnread) with Read again first (#3581). It has no table (the
  // contract resolves it to no destination), so no pill, commit or quantity:
  // those are controls for filing a thing nobody can file yet.
  const receiptUnread = scanReceiptReadFailed(item);
  const dest = receiptUnread
    ? null
    : // A pick made a moment ago, until the row comes back served with it.
    destOptions.find((c) => entryKey(c.module, c.instance) === destKey) ??
    (resolvedDestKey ? destOptions.find((c) => entryKey(c.module, c.instance) === resolvedDestKey) : undefined) ??
    topCand ??
    destOptions[0] ??
    null;
  // A pick is the PERSON's choice: kept on the row and stamped theirs, so no
  // later system suggestion replaces it (#3062). The pill follows at once;
  // the row's state follows when the row is served again.
  const pickDestination = useMutation({
    mutationFn: (k: string) => {
      const c = destOptions.find((o) => entryKey(o.module, o.instance) === k);
      return api.updateScanItem(activeSlug, item.id, {
        destination: c ? { module: c.module, instance: c.instance ?? null, kind: c.kind ?? null, label: c.label } : null,
      });
    },
    onMutate: (k) => setDestKey(k),
    onSuccess: () => void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // A ROUTE CAN GO STALE WHILE IT SITS IN THE INBOX.
  //
  // The matchmaker answers once, against the workspace as it was. Scan a box of
  // tea, install a Tea table a week later, and the stored answer still says
  // plain Inventory - correct when it was written, wrong by the time anybody
  // presses File. That is how five teas and three spice blends ended up in
  // Inventory with Spices and Tea sitting empty beside them.
  //
  // Computed HERE, at render, against the LIVE menu - so unlike a stored
  // recomputation it cannot itself go stale. And it never changes the
  // destination on its own: a route somebody can see and ignore costs a glance,
  // one that moves under them costs their trust.
  const staleHint = (() => {
    if (!dest || item.status !== "pending") return null;
    // A system route that had a better table was replaced by the resolver
    // above; the chip then offers the way BACK. A person's choice is never
    // replaced, so for it the chip offers the better table, and only offers.
    if (rowState.destination?.replaced) {
      const r = rowState.destination.replaced;
      const entry = (menu ?? []).find((m) => m.module === r.module && (m.instance ?? null) === (r.instance ?? null));
      return entry ? { entry, label: r.label, back: true } : null;
    }
    // A person's choice: the resolver OFFERS the router's better table
    // beside it (scanDestination.offered), and only offers; this card never
    // asks the question itself (#3136).
    const offered = rowState.destination?.offered;
    if (!offered) return null;
    const entry = (menu ?? []).find((m) => m.module === offered.module && (m.instance ?? null) === (offered.instance ?? null));
    return entry ? { entry, label: offered.label, back: false } : null;
  })();
  // Re-arm the OPEN form when a re-run lands a new answer. `formCtx` (which drives
  // ADD TO + the pre-filled fields) is only set by openForm() on a CLICK, so a
  // re-run updated the header chips and the Source panel while the form below kept
  // the previous run's route + category until the user closed and reopened the
  // card (reported 2026-07-17: re-identified a miter-saw misread as a tool tote, but
  // ADD TO still said Machines / Power tool). A re-run is an explicit "identify
  // this again", so adopting its result into the open form is what's expected.
  // Keyed on the top candidate's signature (route + fields), the same shape the
  // ConfirmForm key already remounts on — so the props it remounts with stop being
  // stale. Only when the form is actually on screen; never auto-expands a card.
  const answerSig = topCand ? `${topCand.module}:${topCand.instance ?? ""}|${JSON.stringify(topCand.fields)}` : "none";
  const lastAnswerSig = useRef(answerSig);
  useEffect(() => {
    if (lastAnswerSig.current === answerSig) return;
    lastAnswerSig.current = answerSig;
    if (topCand && formPickedKey.current === entryKey(topCand.module, topCand.instance)) return;
    // Only re-arm a form that is actually on screen — a re-run must not summon
    // the form onto a card the user expanded for triage only.
    if (formOpen && expanded && !planContext) openForm(dest ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerSig]);
  // Stuck-nameless: enrichment finished (ai_suggested_at) but produced no name
  // and no candidates — a bare photo that couldn't be auto-identified. Offer the
  // manual "name it" entry instead of an endless "AI is reading…" pulse.
  // Reading a receipt is WORK, not failure. Without this the row - a photo,
  // no name, enrichment finished - reads as "couldn't identify" for the
  // seconds it takes to become line items (reported 2026-08-31).
  const readingReceipt =
    item.status === "pending" &&
    !!(item.suggested_metadata as { reading_receipt?: boolean } | null)?.reading_receipt;
  // Whatever the router gave it, a settled row with no name shows the name
  // field and gets no one-tap Add (lib/namelessCard.ts, #2918).
  const nameless = namelessCard({ status: item.status, suggested_name: item.suggested_name, barcode_text: item.barcode_text, ai_suggested_at: item.ai_suggested_at, readingReceipt });
  const needsName = nameless.nameField;
  // How long ago enrichment finished — the matchmaker runs detached AFTER that
  // and stamps matched_at when done. If matched_at never lands (the match threw
  // before stamping), GIVE UP the "finding the best table…" pulse after a few
  // minutes instead of spinning forever — show the resolved name + let the user
  // route/re-run by hand. (The 8s list poll re-renders the card, so this flips on
  // its own.) Belt-and-braces with the backend now stamping matched_at on failure.
  const matchAgeMs = item.ai_suggested_at ? Date.now() - new Date(item.ai_suggested_at).getTime() : Infinity;
  const serverMatching =
    item.status === "pending" &&
    !!(item.suggested_name || item.ai_suggested_at) &&
    candidates.length === 0 &&
    !(item.suggested_metadata as { matched_at?: string } | null)?.matched_at &&
    !needsName &&
    matchAgeMs < 180_000;
  // The post-match tail (matched_at → finalized_at: location + a cover re-fetched
  // for a renamed item) used to show a quiet "finishing…" here, on the theory that
  // it was a ~1-min gap where the card looked settled while still mutating. The
  // prod numbers say otherwise — mean 0.19s, p95 0.72s, max 0.88s over every
  // stamped item, none above 2s — so there is no gap to narrate. See itemEnriching.
  // Rate-limited: rapid scanning exhausted the go-upc gate / upcitemdb burst, so
  // the resolver was throttled. The row is tagged + left unfinished (no name, no
  // ai_suggested_at). Show a distinct "retrying" state — NOT a passive "awaiting
  // lookup" that reads like a miss — and the list auto-retries it (paced).
  const rateLimited =
    item.status === "pending" &&
    !item.suggested_name &&
    !item.ai_suggested_at &&
    !!(item.suggested_metadata as { rate_limited?: boolean } | null)?.rate_limited;
  // The "retrying…" pulse. The flag itself is now the whole answer: the server's
  // retry worker clears it when the budget is spent, so this stops pulsing
  // because the row stopped saying it was retrying - not because a browser tab
  // counted to two.
  const rlActive = rateLimited;
  // Couldn't auto-identify → offer manual naming. ONE condition now: enrichment
  // finished and left no name. A spent rate-limit arrives here too, because the
  // retry worker stamps ai_suggested_at when it gives up, which is what
  // needsName reads.
  const cantIdentify = needsName;
  // A place the system offers, with why; none when no reason is recorded
  // (lib/sessionPlaceSuggestion, #4933).
  const suggested = suggestedPlace(item);
  // A code no catalog looks up, by the server's classification: a store's
  // own label, an Amazon FNSKU (#4933). One reader for the card and the sheet.
  const classified = classifiedCodeOf(item.suggested_metadata);
  const storeCode = !!classified;
  // Of those, the ones nothing can EVER look up (a shop's own label, an
  // Amazon label): a retry would only ask again. An ISBN, an ASIN or a link
  // can answer later (a catalog outage), so they keep their retry.
  const neverLookedUp = classified?.type === "store-code" || classified?.type === "fnsku";
  // The matchmaker THREW for this item: the backend stamps match_failed (+
  // matched_at, so the pulse stops) — but the row then read as SETTLED with a
  // name, zero candidates, and no error anywhere, while File-all silently
  // skipped it. Surface the failure with a one-tap retry (rerun-ai clears the
  // marker server-side).
  const matchFailed =
    item.status === "pending" &&
    !!(item.suggested_metadata as { match_failed?: boolean } | null)?.match_failed;
  // A scan with no photo (just a barcode) must not say "this photo".
  const idNoun = item.barcode_text || item.source_kind === "barcode" ? "barcode" : "photo";
  // "Awaiting lookup…" only while genuinely fresh — nothing has come back yet.
  // Once the matchmaker has run, a tentative table exists, or we're rate-limited,
  // the lookup has SETTLED; an unnamed row then prompts to name, not "awaiting".
  const awaitingFresh =
    !item.suggested_name && !item.ai_suggested_at && candidates.length === 0 && !rateLimited;
  // A doubt the pipeline raised (a short barcode the catalogs may have
  // mis-matched, a split piece read from the group) that no person has
  // retired: the contract's one answer (scanDoubt), which already folds in
  // "Looks fine" (#3057). Surface the sentence + an obvious one-tap
  // corrector while it is open; the fix feeds the shared Barcode
  // Intelligence DB and improves the next scan of this UPC everywhere.
  const doubt = scanDoubt(item);
  const doubtWords = scanDoubtWords(item);
  // The same picture waiting here twice (scanTwins.tsx, #3852).
  const twinIds = useContext(ScanTwinsContext).get(item.id) ?? [];
  // The note as provenance: the doubt a lookup once baked into it is
  // stripped at render, so an older row reads like a new one.
  const provenanceNote = scanProvenanceNote(item.ai_notes);
  // Amber warning line vs the Source data box - one or the other, never both,
  // and never a function of whether the card happens to be open.
  // A photo the identify step could not name carries its reason as a code
  // (identify_failure) beside the note; the note is then the one thing the
  // card has to say, so it renders as a warning, never behind the box.
  // …and for a typed code that resolved to nothing, the lookup's own note
  // ("a store's own label", "nothing corroborated the web guess, left blank")
  // is the reason under the field, so it renders as the warning it is too.
  // A typed code the lookup settled without a name: the note is the reason.
  const lookupSettledNameless = item.status === "pending" && !item.suggested_name && !!item.barcode_text && !!item.ai_suggested_at;
  const heldWebGuess = !!item.barcode_text && !!(item.suggested_metadata as { held_reason?: string } | null)?.held_reason;
  // The reason is deterministic: a store's own code, or a web guess held
  // back. No AI was asked and failed, so no line says the AI could not read
  // it and no Retry is offered (#3017).
  const deterministicMiss = lookupSettledNameless && (neverLookedUp || heldWebGuess);
  const identifyFailed =
    item.status === "pending" && !item.suggested_name && (!!(item.suggested_metadata as { identify_failure?: unknown } | null)?.identify_failure || (lookupSettledNameless && !deterministicMiss));
  // A human who pressed "Looks fine" clears the review flag — and with it the
  // action that clears it — so a low-trust note must stop shouting in amber, or
  // it becomes a warning nobody can dismiss (feedback 29a2515b).
  const reviewed = (item.suggested_metadata as { reviewed?: boolean } | null)?.reviewed === true;
  const notesPlacement = scanNotesPlacement({ notes: provenanceNote, rateLimited, identifyFailed: identifyFailed || deterministicMiss, reviewed, doubt, doubtWords });
  const barcodeIdentified = !!item.barcode_text && !!item.suggested_name;
  // "I said I would photograph this." A person set it, so an AI re-run must
  // not clear it (see IDENTIFY_OWNED_KEYS in core-scan metadata.ts).
  const photoWanted =
    (item.suggested_metadata as { photo_wanted?: boolean } | null)?.photo_wanted === true;
  // core-scan's OWN identifier for the receipt this item came off. Handed to
  // contributed panels as a hint; what any of them make of it is theirs.
  const receiptGroupId =
    (item.suggested_metadata as { receipt_group_id?: string } | null)?.receipt_group_id ?? null;
  const [correcting, setCorrecting] = useState(false);
  // The photo cross-check flagged the barcode→name as wrong AND read the real
  // product off the label. Offer it as a one-tap fix: applying it renames the
  // item, and a rename reports the correction to the Barcode Intelligence DB.
  const photoMismatch = (
    item.suggested_metadata as { photo_mismatch?: { correct_name?: string; reason?: string } } | null
  )?.photo_mismatch;
  const photoSuggestedName = photoMismatch?.correct_name?.trim() || "";

  const discard = useMutation({
    mutationFn: () => api.discardScanItem(activeSlug, item.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      // Undo inline — a mis-click shouldn't send you hunting in Recently deleted.
      // Name the item so stacked toasts are distinguishable; auto-dismiss (7s) so
      // they don't pile up sticky.
      const label =
        item.suggested_name?.trim() ||
        (item.barcode_text ? `barcode ${item.barcode_text}` : "item");
      toast.action(`Removed ${label}`, {
        actionLabel: "Undo",
        duration: 7000,
        onAction: async () => {
          try {
            await api.restoreScanItem(activeSlug, item.id);
          } catch (e) {
            // An unhandled rejection here dismissed the toast, kept the item
            // deleted, and let the user believe it came back.
            toast.error(e instanceof ApiError ? e.message : "Couldn't bring it back - it is in Recently deleted");
            return;
          }
          void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
        },
      });
    },
    // The only mutation in this file that had no onError: a failed discard
    // showed nothing, the card stayed put, and the user tapped again.
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Apply the photo cross-check's identification as the name (one tap). The
  // rename PATCH reports the correction to the Barcode Intelligence DB, so the
  // wrong barcode→name is fixed for the next scan everywhere.
  const applyPhotoName = useMutation({
    mutationFn: () => api.updateScanItem(activeSlug, item.id, { name: photoSuggestedName }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      toast.success(`Renamed to "${photoSuggestedName}". Fix reported to the barcode DB.`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Adjust the pending item's quantity in place (e.g. an over-counted dedup) —
  // a PATCH that keeps it in the inbox; no commit.
  const qtyPatch = useMutation({
    mutationFn: (q: number) => api.updateScanItem(activeSlug, item.id, { quantity: q }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // A barcode rerun resolves inline server-side (so its toast can assert the
  // result). A PHOTO rerun is fire-and-forget now: the vision+match runs detached
  // so the request can't be held past Cloudflare's ~100s timeout (which 524s).
  // For photos, track a local "reading" pulse from the moment we fire until the
  // server stamps a fresh ai_suggested_at — the 8s list poll surfaces it — so the
  // card keeps a live "AI reading…" state instead of snapping back to its old one.
  const isPhotoItem = !item.barcode_text && !!item.image_file_id;
  const [reading, setReading] = useState(false);
  const readingSnapshot = useRef<string | null>(null);
  // One-tap confirm from the collapsed row — commit into the AI's top candidate
  // without opening the accordion (mirrors the form's confirm path). Ready only
  // when we have a routed candidate + a name (same guard as bulk-confirm).
  // A top match that is a bundle this workspace has not installed (a scanned
  // VIN → "Vehicles") is the row's needs-install state, resolved above with
  // whether this person may install it; the closed card's button says so.
  // Ready to one-tap confirm from the collapsed card. A not-installed-bundle top
  // match is only "ready" when the user can install it (else the green check
  // would try to file into a table that doesn't exist).
  // "We already have one of these" — resolved server-side at match time and
  // stamped on the row, so the CLOSED card knows without a per-card round trip.
  // One-tap Add CREATES an entity; offering it when the workspace already tracks
  // the thing is how you end up with a second Honda Civic. So the green Add gives
  // way to a chip that opens the card, where the merge banner lives.
  const trackedMatch = scanTrackedMatch(item);
  // A match the person turned down (Not the same, or a table picked for a
  // new one) is not "you already have" any more: the card files it as new.
  const alreadyTracked = !!trackedMatch && !scanDeclinesRecord(item, trackedMatch, viewer);
  // One name, whoever wrote it (#2982): the person's when they gave one,
  // the model's otherwise; the model's newest read is offered beside it.
  const shownName = displayName(item);
  const modelName = modelNameBeside(item);
  const identity = displayIdentity(shownName);
  // A keyword-basis route is a no-AI guess held up only by corroborating
  // keyword hits — the tier that filed a storage tote into Vehicles. It renders
  // tentative (outline + "?") and gets no one-tap Add; isScanReadyToFile applies
  // the same bar to File all, so the card and the bulk sweep agree.
  const tentativeRoute = rowState.sentence === KEYWORD_ROUTE_SENTENCE;
  const cardAiStatus = useAiStatus();
  const later = useLater();
  // A row still waiting on its lookup says why after a few seconds, on the
  // desk line and the phone row alike (awaitingLookup.ts, #3852).
  const awaiting = useAwaitingWords(item, item.status === "pending" && awaitingFresh, {
    identifyAvailable: cardAiStatus ? aiReach(cardAiStatus).identify : undefined,
  });
  /** Why this card has no name: nothing here can identify a photo (the setup
   *  sentence), a store's own code, the identify step's own coded reason
   *  (stamped by the server beside its note), or the AI did not answer
   *  (lib/identifySentence). */
  const identifyFailure =
    (item.suggested_metadata as { identify_failure?: IdentifyFailure } | null)?.identify_failure ?? null;
  // A code with no photo that no catalog resolved is an unresolved CODE: no
  // AI read anything, so "The AI could not read this one" with a Retry was
  // the wrong story on a booth visitor's unknown barcode (#3710).
  const codeWithoutPhoto = item.source_kind === "barcode" && !item.image_file_id;
  const namelessWhy = namelessReason(cardAiStatus, storeCode, identifyFailure, heldWebGuess || codeWithoutPhoto, receiptUnread);
  // The remedy under a photo the identify step could not name, or null when
  // nothing tried (no AI here) or a retry would only look again (#3233): the
  // phone row's line and its tool button read this, so neither says the AI
  // failed when it was never asked.
  const namelessFix = identifyFailed ? namelessRemedy(namelessWhy, identifyFailure) : null;
  const namelessSays = namelessWords(namelessWhy, {
    noun: idNoun,
    failure: identifyFailure,
    classifiedLine: classified?.line ?? null,
    heldGuess: heldWebGuess,
    lookupGaveUp: item.ai_notes === LOOKUP_GAVE_UP,
  });
  // The matchmaker fell to the keyword floor although this workspace HAS
  // working AI — the model call failed and the code silently downgraded. Say
  // so, with a one-tap retry, instead of letting a lexical guess sit there
  // looking settled (scan-inbox-ux-review.md F4).
  const aiDowngraded =
    !!topCand?.heuristic && !!cardAiStatus?.available && item.status === "pending";
  // Whether the pill offers Add or Review is ScanCardCommit's call, from the
  // contract's readiness rule; the mutation is only what Add runs.
  const quickConfirm = useMutation({
    // The same one tap the scan sheet offers (scanQuickFile.ts): install the
    // table on the way if needed, then file with the scan's values as-is.
    mutationFn: async () => {
      if (!dest) throw new Error("not ready to confirm");
      return quickFileRow(activeSlug, item, dest);
    },
    onSuccess: () => {
      // No toast: where it went is the filed row's to say, in the place the
      // card was (lib/filedRows.ts). A toast over that row covered the very
      // words it said, at a phone's width.
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      if (topCand?.bundle_external_id) {
        void qc.invalidateQueries({ queryKey: ["scan-menu", activeSlug] });
        void qc.invalidateQueries({ queryKey: ["org-modules", activeSlug] });
        void qc.invalidateQueries({ queryKey: ["instances", activeSlug] });
      }
    },
    onError: (e) => toast.error((e as Error).message),
  });
  // "+1 more": the resolver said this is another of a thing the workspace
  // counts, and named the record. Filed through the attach endpoint, the
  // same call the bulk sweep makes for the row, never a create (#3076).
  const quickMerge = useMutation({
    mutationFn: async () => {
      const m = rowState.merge;
      if (!m) throw new Error("not a merge");
      return api.scanAttach(activeSlug, item.id, {
        kind: m.kind,
        entity_id: m.id,
        instance: m.instance ?? undefined,
        mode: "add-qty",
        ...(item.target_location_id ? { location_id: item.target_location_id } : {}),
      });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      toast.success(
        r.added_place
          ? addedPlaceSentence(r.entity_title, r.added_place)
          : r.new_qty != null
            ? `${r.entity_title}: now ${r.new_qty}`
            : `Added one more to ${r.entity_title}`,
      );
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // A match on a record the workspace counts: the scan changes that count
  // (ScanCountBlock), on the card's own line and in the open banner.
  const trackedRaw = (item.suggested_metadata as { tracked_match?: Partial<TrackedMatch> & { qty?: unknown } } | null)?.tracked_match ?? null;
  const restockMatch: TrackedMatch | null =
    // A new place of the thing is not a count on it (AddPlaceBlock, #4552).
    rowState.action.kind === "merge" && rowState.merge && !rowState.merge.new_place && trackedRaw && typeof trackedRaw.qty === "number"
      ? ({ ...trackedRaw, kind: rowState.merge.kind, id: rowState.merge.id, instance: rowState.merge.instance, title: rowState.merge.title, qty: trackedRaw.qty, expired: !!trackedRaw.expired } as TrackedMatch)
      : null;
  // A record the workspace counts: the match line (closed) or the banner
  // (open) carries the count (ScanCountBlock), and IT is how this scan is
  // filed. The destination pill with its "+1 more" would say the same thing
  // again (#3884).
  const countFiles = !planContext && alreadyTracked && !!restockMatch;
  // The phone row's compact count: the same change and the same save as the
  // full control (useScanCountSave), in the room a list row has.
  // A re-buy adds what the line bought: a 10-pack line starts at +10 (#5719).
  const rowScanned = scanAddCount(item.quantity);
  const [rowChange, setRowChange] = useState(rowScanned);
  useEffect(() => setRowChange(rowScanned), [rowScanned]);
  const rowCount = useScanCountSave(item.id, restockMatch ?? NO_COUNTED_MATCH);
  const rowHave = Math.max(0, restockMatch?.qty ?? 0);
  const rowAmount = useMatchAmount(restockMatch?.unit);
  const commitBusy = quickConfirm.isPending || quickMerge.isPending;
  const runCommit = () => (rowState.action.kind === "merge" ? quickMerge.mutate() : quickConfirm.mutate());
  // "Ask an admin": the blocked row's button. The server explains what is
  // missing the way a 403 would, and the sheet offers the ask with this
  // row's own File as the thing a yes finishes (#3073).
  const askToFile = useMutation({
    mutationFn: async () => {
      const ask = rowState.ask ?? [];
      if (ask.length === 0 || !dest) throw new Error("nothing to ask for");
      const { blocked } = await api.describeBlockedAction(activeSlug, ask, "Filing this");
      // The row is its own draft (blocked-action.ts, refusedRequestFor): the
      // yes reopens the inbox and the row's CURRENT state says what its
      // button does. Nothing replays a snapshot of a row that may have
      // changed while the ask waited.
      raiseBlockedAction({
        blocked,
        subject: `File ${item.suggested_name ?? "this"} into ${dest.label}`,
        refused: null,
      });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Put back what the last re-run overwrote (the row snapshots it before running).
  const undoRerun = useMutation({
    mutationFn: () => api.scanUndoRerun(activeSlug, item.id),
    onSuccess: (it) => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      toast.success(it.suggested_name ? `Back to “${it.suggested_name}”` : "Previous lookup restored");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // "Read as a receipt": the identify step routes a photographed receipt on its
  // own verdict; when it misses, this sends the photo to the same receipt
  // parser from the card instead of a delete-and-rephotograph (#2882).
  const asReceipt = useMutation({
    mutationFn: (opts: { force?: boolean } | void) => api.readScanItemAsReceipt(activeSlug, item.id, opts ?? {}),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      toast.success(`Found ${r.items} item${r.items === 1 ? "" : "s"} on the receipt: review below`);
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not read that as a receipt."),
  });
  // "Treat it as one item": the other way out of a receipt whose read failed
  // (#3581). The row then asks for a name like any photo.
  const asItem = useMutation({
    mutationFn: () => api.updateScanItem(activeSlug, item.id, { read_as_item: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) }),
    onError: () => toast.error("Couldn't save that. Try again."),
  });
  const receiptBlock = receiptUnread
    ? {
        reading: asReceipt.isPending,
        saving: asItem.isPending,
        onReadAgain: () => asReceipt.mutate(),
        onAsItem: () => asItem.mutate(),
        alreadyIn: scanReceiptAlreadyIn(item),
        onReadAnyway: () => asReceipt.mutate({ force: true }),
      }
    : null;
  // The title is the name: the card's own rename, the same PATCH the form's
  // NAME chip and the phone's Name box use (#2982).
  const renameTitle = useMutation({
    mutationFn: (next: string) => api.updateScanItem(activeSlug, item.id, { name: next }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) }),
    onError: () => toast.error("Couldn't save the new name. Try again."),
  });
  const rerun = useMutation({
    mutationFn: (vars?: {
      hint?: string;
      wrong?: boolean;
      enrich?: boolean;
      noAi?: boolean;
      /** Corrected barcode - lands on barcode_text, then the lookup re-runs. */
      barcode?: string;
      /** Re-identify from THIS photo (an extra photo the user just added). */
      imageFileId?: string;
    }) =>
      api.rerunScanAi(activeSlug, item.id, {
        hint: vars?.hint,
        wrong: vars?.wrong,
        enrich: vars?.enrich,
        noAi: vars?.noAi,
        barcode: vars?.barcode,
        imageFileId: vars?.imageFileId,
      }),
    onMutate: (vars) => {
      if (isPhotoItem || vars?.imageFileId) {
        readingSnapshot.current = item.ai_suggested_at ?? null;
        setReading(true);
      }
    },
    onSuccess: (fresh, vars) => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      if (vars?.noAi) {
        toast.success("Re-applying the latest processing to what the AI already found…");
        return;
      }
      if (vars?.barcode) {
        // The barcode branch runs INLINE, so `fresh` is the re-resolved row.
        toast.success(
          fresh.suggested_name
            ? `Barcode corrected - now reads as ${fresh.suggested_name}`
            : "Barcode corrected - no match yet for the new code.",
        );
        return;
      }
      if (vars?.imageFileId) {
        toast.success("Re-identifying from your photo…");
        return;
      }
      if (isPhotoItem) {
        // Detached on the server — the result isn't ready yet; the poll shows it.
        toast.success("Reading the photo with AI…");
        return;
      }
      // A hint / wrong / enrich re-derive also runs DETACHED (the web identify),
      // so `fresh` still carries the OLD name — never claim "updated: <old name>".
      // The 1.5s inbox poll surfaces the corrected name a moment later.
      if (vars?.hint || vars?.wrong || vars?.enrich) {
        toast.success("Re-checking - the name updates in a moment…");
        return;
      }
      toast.success(
        fresh.suggested_name
          ? `Lookup updated: ${fresh.suggested_name}`
          : "Re-ran, still no match. Fill it in manually.",
      );
    },
    onError: (e) => {
      setReading(false);
      toast.error(e instanceof ApiError ? e.message : String(e));
    },
  });
  // "This is good — lock it in": verify the current listing into the shared
  // barcode DB (no re-resolve, doesn't commit to inventory).
  const confirmBarcode = useMutation({
    mutationFn: () => api.confirmScanBarcode(activeSlug, item.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      toast.success("Locked into the barcode database - future scans of this code get this listing.");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Clear the local pulse once the server stamps a newer ai_suggested_at (the
  // identify finished — named or a "couldn't identify" note); cap it so a dropped
  // enrich can't pulse forever.
  useEffect(() => {
    if (reading && (item.ai_suggested_at ?? null) !== readingSnapshot.current) setReading(false);
  }, [item.ai_suggested_at, reading]);
  useEffect(() => {
    if (!reading) return;
    const t = setTimeout(() => setReading(false), 95_000);
    return () => clearTimeout(t);
  }, [reading]);
  // In flight = the local mutation is pending (optimistic, before the server has
  // even stamped pipeline_started_at) OR the server says the run is still going
  // (isRerunInFlight — the SAME signal the header count uses, so the spinner and
  // the "N finishing" pill can't disagree). `reading` alone stopped the moment the
  // name landed, ~60s before a real AI re-run actually finished.
  const rerunning = rerun.isPending || reading || isRerunInFlight(item);
  // "Replay" runs the SAME mutation with noAi — but showing it as
  // "Re-running the lookup…" with the AI sparkle made a token-free replay look
  // like a model call ("all the spinners are going incl the AI one"). Label the
  // in-flight variant honestly.
  const replayNoAi =
    (rerun.isPending && (rerun.variables as { noAi?: boolean } | undefined)?.noAi === true) ||
    ((item.suggested_metadata as { pipeline_kind?: string } | null)?.pipeline_kind === "replay" &&
      (rerunning || serverMatching));
  const aiWorking = rerunning || serverMatching;

  // Internal /api/v1 file URLs need the Bearer token a bare <img> can't
  // send — useImageSrc blob-loads those; external URLs pass through.
  // The catalog picture is the stored file or nothing (#4580); a file that
  // will not load is marked broken and the next rung (the user's own photo)
  // shows instead of a dead image on the card.
  const [brokenSrcs, setBrokenSrcs] = useState<Set<string>>(new Set());
  // The web candidates the strip below fetched, reported up so the one
  // resolver can fold them in (the lightbox filmstrip, the outline rule).
  const [photoCandidates, setPhotoCandidates] = useState<ImageOption[]>([]);
  const markBroken = (u: string | null) =>
    u && setBrokenSrcs((s) => (s.has(u) ? s : new Set(s).add(u)));
  const catalogFileUrl = item.catalog_image_file_id ? scanFileUrl(activeSlug, item.catalog_image_file_id) : null;
  // Where the tracked record's picture sits against this item's own catalog
  // slot is scanPhoto.ts's call (catalogRungs): the record's picture beats a
  // lookup's find, and a picture the person chose here beats both.
  const catalogUrl =
    catalogRungs(item, [catalogFileUrl]).find(
      (u): u is string => !!u && !brokenSrcs.has(u),
    ) ?? null;
  const pictureStatus = (item.suggested_metadata as { catalog_image_status?: string } | null)?.catalog_image_status;
  const noPictureFound = !catalogUrl && !item.image_file_id && (pictureStatus === "none" || pictureStatus === "throttled");
  /** The engine refused a burst, not the query: it retries itself, and the
   *  chip should not read as "nobody has a picture of this". */
  const pictureBusy = pictureStatus === "throttled";
  /** A picture chosen once that could not be stored: said, never drawn. */
  const unsaved = catalogUnsaved(item);
  const unsavedNote = unsaved ? (
    <span data-testid="catalog-unsaved" title={`The site would not give Cobblr that picture to keep (${unsaved.url}). Pick another from the web results.`} className="px-1 text-center text-[10px] leading-tight text-amber-700 dark:text-amber-400">
      {COULDNT_SAVE_WORDS}
    </span>
  ) : null;
  // The row's pictures, resolved ONCE (lib/rowPictures.ts, the contract's
  // scan-pictures, #3046): the pair's yours slot, the lightbox's own panes,
  // the strip's "Your photos" column and the outline rule all read this list.
  // Four surfaces used to compute it four ways, and a split child's crop and
  // group shot fell between them.
  const resolved = rowPictures(activeSlug, item, { web: photoCandidates });
  const yoursPicture = leadYours(resolved.pictures);
  const yoursRawUrl = yoursPicture ? resolved.src(yoursPicture) : null;
  const yoursUrl = yoursRawUrl && !brokenSrcs.has(yoursRawUrl) ? yoursRawUrl : null;
  // The item's photograph, cropped out of a screenshot by the enrich. Kept as a
  // filmstrip pane of its own so it stays one tap away after a detour through
  // the web results — it is a picture of the ACTUAL item, so it is worth
  // returning to.
  const screenshotCrop = resolved.pictures.find((p) => p.role === "crop" && p.cropOf === "screenshot") ?? null;
  const cropRawUrl = screenshotCrop ? resolved.src(screenshotCrop) : null;
  const catalogImg = useImageSrc(catalogUrl);
  const yoursImg = useImageSrc(yoursUrl);
  const cropImg = useImageSrc(cropRawUrl && !brokenSrcs.has(cropRawUrl) ? cropRawUrl : null);
  // While a barcode's catalog image is UNVERIFIED — being checked against your
  // photo, or already flagged a mismatch — lead with YOUR photo, not the catalog
  // one. A barcode can resolve to a wrong/spam product (an action figure, a
  // lookup-site screenshot) whose race-fetched image reads as "the scan failed";
  // your own photo is never wrong. Once the check confirms, the catalog image
  // (a clean product shot) leads again.
  // The shared rule (lib/scanPhoto.ts) decides; this surface only maps roles to
  // the images it already resolved. Seven surfaces used to answer separately.
  const unverified = photoUnverified(item);
  const thumbRole = photoOrder(item).find((r) =>
    r === "catalog" ? !!catalogImg : r === "yours" ? !!yoursImg : false,
  );
  const thumb = thumbRole === "yours" ? yoursImg : thumbRole === "catalog" ? catalogImg : null;

  // Image viewer: click to zoom (the shared ImageLightbox — same viewer as the
  // web-photo "view full size"), revert the catalog image to the original
  // (preserved server-side on the first override), or use your own scan photo as
  // the catalog image. ONE filmstrip regardless of which image you click: the
  // item's own shots (catalog + yours, already-resolved blob urls above) followed
  // by the web photo candidates — so opening from the catalog shows the same
  // options as opening from a web tile (reported 2026-07-24). The candidates are
  // fetched by the PhotoOptions strip below and reported up via onItems.
  const [zoomIdx, setZoomIdx] = useState<number | null>(null);
  // The search that produced those candidates, owned HERE so the same one can
  // be driven from the inline picker or from inside the full-screen viewer.
  // Refining while the viewer is open is the whole point: that is where you are
  // actually comparing, so leaving it to retype a term was the detour.
  const [photoTerm, setPhotoTerm] = useState("");
  const [photoSearched, setPhotoSearched] = useState("");
  const [zoomTerm, setZoomTerm] = useState("");
  const zoomTermTouched = useRef(false);
  // Keep the viewer's box showing what was actually searched until the user
  // edits it, then leave their text alone.
  useEffect(() => {
    if (!zoomTermTouched.current) setZoomTerm(photoTerm || photoSearched);
  }, [photoTerm, photoSearched]);
  // YOUR photo leads, then the rest of what is already yours, then a divider,
  // then the web results.
  //
  // The strip is a comparison surface: you are deciding which of fourteen
  // candidates is a picture of the thing in front of you. The photo you took is
  // the REFERENCE you compare against, so it belongs at the fixed left edge
  // where the eye returns, not somewhere in the queue as tile three of fourteen
  // (reported 2026-08-17). Mixed in, the one image you can identify at a glance
  // becomes another one to hunt for.
  // The row's own pictures from the resolver, in its order; the lead pair
  // (yours, catalog) keeps its already-resolved blob urls, the rest load by
  // address. The group shot and the added photos are panes too (#3046).
  const ownItems: LightboxItem[] = [
    ...(yoursImg && yoursImg !== catalogImg ? [{ key: "yours", caption: yoursPicture?.caption ?? "Your photo", url: yoursImg }] : []),
    ...(catalogImg ? [{ key: "catalog", caption: "Catalog image", url: catalogImg }] : []),
    ...(cropImg && cropImg !== catalogImg ? [{ key: "crop", caption: "From your screenshot", url: cropImg }] : []),
    ...yourPictures(resolved.pictures)
      .filter((p) => p !== yoursPicture && p !== screenshotCrop && p.fileId !== item.catalog_image_file_id)
      .map((p) => ({ key: p.key, caption: p.caption, url: resolved.src(p)! })),
  ];
  const zoomItems: LightboxItem[] = [
    ...ownItems,
    ...photoCandidates.map((o, i) => ({
      key: o.url,
      caption: `${o.title} · ${o.source}`,
      href: o.source,
      url: shownPictureUrl(activeSlug, o.url, o.source),
      thumbUrl: shownPictureUrl(activeSlug, o.thumb || o.url, o.source),
      // The seam between what is yours and what the web offered. Only on the
      // first one, and only when there is something to its left to separate it
      // from.
      ...(i === 0 && ownItems.length > 0 ? { dividerBefore: true } : {}),
    })),
  ];
  const openZoom = (key: "catalog" | "yours") => {
    const i = zoomItems.findIndex((z) => z.key === key);
    if (i >= 0) setZoomIdx(i);
  };
  const openZoomUrl = (url: string) => {
    const i = zoomItems.findIndex((z) => z.key === url);
    if (i >= 0) setZoomIdx(i);
  };
  // "Use this image" on a web candidate in the viewer → set it as the catalog.
  const pickCatalogImage = useMutation({
    mutationFn: (url: string) =>
      api.setScanCatalogImage(activeSlug, item.id, url, {
        // The thumbnail the viewer is showing for this very candidate. If the
        // full-size original is hotlink-blocked, that visible picture is used
        // rather than the pick being refused.
        thumbUrl: photoCandidates.find((o) => o.url === url)?.thumb,
      }),
    onSuccess: () => {
      toast.success("Catalog photo updated");
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Revert is undo over a STACK, so the control lives as long as there is any
  // earlier image, and it names the one press lands on. The rule is pure and
  // unit-tested next door rather than inline here.
  const catalogHistory = catalogUndoHistory(
    item.suggested_metadata as { catalog_history?: unknown; orig_catalog?: unknown } | null,
  );
  const undoLabel = catalogUndoLabel(catalogHistory);
  const hasOrigCatalog = !!undoLabel;
  const catalogAction = useMutation({
    mutationFn: (action: "revert" | "use_own_photo" | "use_screenshot_crop") =>
      api.scanCatalogAction(activeSlug, item.id, action),
    onSuccess: () => void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // The crop door for "use as catalog": the route has cropped the identify
  // photo since 2026-08-11; this is the first surface that asks it to.
  const [cropOpen, setCropOpen] = useState(false);
  // "Crop again" on a split child (#3046): the group shot, cut again into
  // this row's own picture.
  const [cropAgainOpen, setCropAgainOpen] = useState(false);
  const groupPicture = resolved.pictures.find((p) => p.role === "group") ?? null;
  const groupImg = useImageSrc(groupPicture ? resolved.src(groupPicture) : null);
  const cropAgain = useMutation({
    mutationFn: (box: { x: number; y: number; w: number; h: number }) =>
      api.cropScanCatalogImage(activeSlug, item.id, box, { source: "group" }),
    onSuccess: () => {
      setCropAgainOpen(false);
      toast.success("Cut again from the group photo");
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const cropCatalog = useMutation({
    mutationFn: (box: { x: number; y: number; w: number; h: number }) =>
      api.cropScanCatalogImage(activeSlug, item.id, box),
    onSuccess: () => {
      setCropOpen(false);
      toast.success("Cropped - that is the catalog image now");
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // ── image ops (scan-parity-final-mile.md Epic B) ────────────────────
  const invalidateInbox = () => void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
  const onErr = (e: unknown) => toast.error(e instanceof ApiError ? e.message : String(e));
  const rotate = useMutation({
    mutationFn: () => api.rotateScanPhoto(activeSlug, item.id, 90),
    onSuccess: invalidateInbox,
    onError: onErr,
  });
  const split = useMutation({
    mutationFn: () => api.splitScanItem(activeSlug, item.id),
    onSuccess: (r) => {
      toast.success(`Split into ${countOf(r.children.length, "item")}`);
      invalidateInbox();
    },
    onError: onErr,
  });
  // The other direction, from a piece: the group photo comes back as it
  // was and every piece of the split goes to Recently deleted.
  const unsplit = useMutation({
    mutationFn: () => api.unsplitScanItem(activeSlug, item.id),
    onSuccess: (r) => {
      toast.success(`Split undone: the group photo is back in the inbox and its ${r.discarded} piece${r.discarded === 1 ? "" : "s"} ${r.discarded === 1 ? "is" : "are"} in Recently deleted.`);
      invalidateInbox();
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    },
    onError: onErr,
  });
  // Undo combine (#3639): from the kept row, the rows it absorbed come back
  // and it gives back the quantity they added. The absorbed rows offer the
  // same from Recently deleted.
  const uncombine = useMutation({
    mutationFn: () => api.uncombineScanItem(activeSlug, item.id),
    onSuccess: (r) => {
      toast.success(`Combine undone: ${r.restored.length + 1} scans are back in the inbox as they were.`);
      invalidateInbox();
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    },
    onError: onErr,
  });
  const combinedCount = scanCombinedCount(item.suggested_metadata as Record<string, unknown> | null);
  // "Keep as one" — the OTHER answer to the split question. Persisted, so the
  // offer doesn't ask again on the next render.
  const keepGrouped = useMutation({
    mutationFn: () => api.updateScanItem(activeSlug, item.id, { keep_grouped: true }),
    onSuccess: () => {
      toast.success("Kept as one record.");
      invalidateInbox();
    },
    onError: onErr,
  });
  // Several DIFFERENT things in one photo (units of the SAME thing are a quantity,
  // not a split). Offered only when the PHOTO was the point - see lib/splitOffer.
  // not a split — the observation pass draws that line). Free: this comes from the
  // vision call every photo scan already makes. Hidden once answered, once split,
  // and on a child that IS a split result.
  const multiItem = (() => {
    const m = (item.suggested_metadata ?? {}) as {
      photo_distinct?: number;
      photo_individuals?: Array<{ name: string; qty: number }>;
      keep_grouped?: boolean;
      split_from?: string;
      split_into?: string[];
    };
    if (
      !shouldOfferSplit({
        distinct: m.photo_distinct,
        hasBarcode: !!item.barcode_text,
        keepGrouped: !!m.keep_grouped,
        alreadySplit: !!m.split_from || !!m.split_into,
        status: item.status,
      })
    ) {
      return null;
    }
    return {
      distinct: m.photo_distinct,
      individuals: m.photo_individuals ?? [],
    };
  })();
  // In-app capture (shared CameraCaptureSheet). The inbox card has no live camera,
  // so the sheet acquires its own rear camera — still no iOS native camera launch.
  const [captureSheet, setCaptureSheet] = useState<"add" | "retake" | null>(null);
  const toFile = (b: Blob, tag: string) =>
    b instanceof File ? b : new File([b], `${tag}-${Date.now()}.jpg`, { type: "image/jpeg" });
  const addPhoto = useMutation({
    mutationFn: (v: Blob | { blob: Blob; uploaded?: boolean }) => {
      const blob = v instanceof Blob ? v : v.blob;
      const uploaded = v instanceof Blob ? false : !!v.uploaded;
      return api
        .uploadFile(activeSlug, toFile(blob, "photo"))
        .then(async (up) => {
          const added = await api.addScanPhoto(activeSlug, item.id, up.id, { uploaded });
          // A CAPTURE of a photo-sourced item still being triaged is the person
          // saying "read THIS" - the label, the spec sticker, the box. Re-read
          // with it now rather than leaving the pic inert behind a ↺ nobody
          // finds. A barcode item keeps the server's cross-check (its identity
          // came from the code, and a vision re-read would only second-guess
          // it); a camera-roll file stays attached only, as before.
          const reread = !uploaded && item.status === "pending" && !item.barcode_text;
          if (reread) await api.rerunScanAi(activeSlug, item.id, { imageFileId: up.id });
          return { added, reread };
        });
    },
    onSuccess: (r) => {
      setCaptureSheet(null);
      toast.success(
        r.reread
          ? "Photo added - reading it for details…"
          : item.status === "pending"
            ? "Photo added - tap ↺ on it to re-identify from this shot"
            : "Photo added",
      );
      invalidateInbox();
    },
    onError: onErr,
  });
  const retakeCatalog = useMutation({
    mutationFn: (b: Blob) =>
      api.uploadFile(activeSlug, toFile(b, "catalog")).then((up) => api.setScanCatalogFile(activeSlug, item.id, up.id)),
    onSuccess: () => {
      setCaptureSheet(null);
      toast.success("Catalog photo replaced with your shot");
      invalidateInbox();
    },
    onError: onErr,
  });
  // A receipt document, by the same test the inbox's upload door uses. Chosen
  // from the card, it is the paperwork for THIS item rather than a new intake:
  // the order is recorded in full and nothing lands in the inbox, because this
  // item is already here. See docs/design-decisions/receipt-or-provenance.md.
  const attachReceipt = useMutation({
    mutationFn: (file: File) =>
      api
        .uploadFile(activeSlug, file)
        .then((up) => api.scanReceipt(activeSlug, up.id, { origin: "upload", target_item_id: item.id })),
    onSuccess: () => {
      setCaptureSheet(null);
      toast.success("Receipt attached - its purchase is on record");
      invalidateInbox();
    },
    onError: onErr,
  });

  // "I'll photograph this" — the mark half of the one photo button. On a device
  // that can actually take the picture the button opens the camera instead and
  // never gets here.
  const setPhotoWanted = useMutation({
    mutationFn: (wanted: boolean) => api.updateScanItem(activeSlug, item.id, { photo_wanted: wanted }),
    onSuccess: (_r, wanted) => {
      toast.success(wanted ? "Waiting on your phone" : "Cleared");
      invalidateInbox();
    },
    onError: onErr,
  });
  const setPrimaryPhoto = useMutation({
    mutationFn: (fileId: string) => api.setScanPrimaryPhoto(activeSlug, item.id, fileId),
    onSuccess: invalidateInbox,
    onError: onErr,
  });
  const removeExtraPhoto = useMutation({
    mutationFn: (fileId: string) => api.removeScanPhoto(activeSlug, item.id, fileId),
    onSuccess: invalidateInbox,
    onError: onErr,
  });
  // Barcode editor: digits (spaces/dashes ok while typing) → Save re-runs the
  // lookup on the corrected code via rerun-ai {barcode}.
  // The confirm form's buttons render HERE, in the same stack the closed
  // state's commit pair uses, so the action anchor does not move when the
  // form opens.
  const [actionSlot, setActionSlot] = useState<HTMLDivElement | null>(null);
  const [fieldSlot, setFieldSlot] = useState<HTMLElement | null>(null);
  // Where the location drawer opens: at the SEAM, directly under the chip strip
  // whose LOCATION chip opened it. It used to render inside the form, which sits
  // below the photos and the web strip — so tapping a chip at the top of the
  // card opened a picker most of a screen further down, with everything you had
  // been looking at in between.
  const [locSlot, setLocSlot] = useState<HTMLElement | null>(null);
  const [editingBarcode, setEditingBarcode] = useState(false);
  const [barcodeDraft, setBarcodeDraft] = useState("");
  const barcodeDigits = barcodeDraft.replace(/[\s-]/g, "");
  const barcodeDraftValid =
    /^\d+$/.test(barcodeDigits) && [8, 12, 13, 14].includes(barcodeDigits.length);
  const saveBarcode = () => {
    if (!barcodeDraftValid || barcodeDigits === item.barcode_text) {
      setEditingBarcode(false);
      return;
    }
    setEditingBarcode(false);
    rerun.mutate({ barcode: barcodeDigits });
  };
  // Box-state: explicit set/clear (menu grammar — tapping the active state
  // clears it; the old cycle button hid the next state behind a blind tap).
  const boxState =
    (item.suggested_metadata as { box_state?: "item-in-box" | "empty-box" } | null)?.box_state ?? null;
  const setBoxState = useMutation({
    mutationFn: (v: "item-in-box" | "empty-box" | null) =>
      api.updateScanItem(activeSlug, item.id, { box_state: v }),
    onSuccess: invalidateInbox,
    onError: onErr,
  });
  // The "this scan IS a container" one-shot (a scanned storage tote becomes a
  // core-locations bin, identity + photo riding onto the bin's record).
  const [makeBinOpen, setMakeBinOpen] = useState(false);
  // The served row's own answer (the contract's tool rule, #3006) when it
  // carries one; the name rule alone for a row from an older api.
  const containerish =
    !planContext &&
    item.status === "pending" &&
    hasLocations &&
    (item.tool_hints
      ? item.tool_hints.bin.relevance === "likely"
      : looksLikeContainer(
          item.suggested_name,
          (item.suggested_metadata as { category?: string } | null)?.category ?? null,
        ));
  // Needs a human: no clean name, a low-trust or rate-limited lookup, or low
  // confidence — unless someone already said "looks fine".
  // The card's own copy of this test read the LOCAL `rateLimited`, which also
  // requires that nothing came back yet — so a rate-limited item that later got
  // a suggestion counted in the header's "to review" and showed nothing here.
  const flaggedForReview = needsScanReview(item);
  // "Looks fine" only where it settles the review (the contract's one rule,
  // scanLooksFineResolves; #3616): never for a missing name, which the tap
  // cannot supply. There the corrective action is offered instead.
  const looksFineResolves = scanLooksFineResolves(item);
  const focusName = () => document.querySelector<HTMLInputElement>(`[data-name-it="${item.id}"]`)?.focus();
  // Why, in the contract's words: the pill's Review carries it, and a flagged
  // row with no note of its own shows it where the note would be.
  // With the field's own label when it names one ("Acquired from says
  // Facebook Marketplace, but the receipt says eBay"), which the contract
  // cannot know without the table.
  const reviewReason = scanReviewReason(item, { fieldLabel: (name) => (topCand ? menuFieldLabel(menu, topCand, name) : name) });
  // "Where should this go?" — accept the suggested home (from where siblings
  // live). One tap sets it as the item's filed location.
  const acceptSuggestedLocation = useMutation({
    mutationFn: () => api.updateScanItem(activeSlug, item.id, { target_location_id: item.suggested_location_id }),
    onSuccess: () => {
      toast.success(`Filed into ${item.suggested_location_note?.split(" — ")[0] ?? "the suggested spot"}`);
      invalidateInbox();
    },
    onError: onErr,
  });
  const markReviewed = useMutation({
    mutationFn: () => api.updateScanItem(activeSlug, item.id, { reviewed: true }),
    onSuccess: () => {
      toast.success("Marked as looks-fine");
      invalidateInbox();
    },
    onError: onErr,
  });
  // The flagged field takes what the receipt says, as the person's own
  // answer: kept over every re-run (#3008).
  const sourceConflict = item.source_conflict ?? null;
  const useEvidenceSource = useMutation({
    mutationFn: () =>
      api.updateScanItem(activeSlug, item.id, { fields: { [sourceConflict!.field]: sourceConflict!.evidence } }),
    onSuccess: () => {
      toast.success(`${topCand ? menuFieldLabel(menu, topCand, sourceConflict!.field) : sourceConflict!.field} set to ${sourceConflict!.evidence}`);
      invalidateInbox();
    },
    onError: onErr,
  });
  // The one thing the row still asks, as a question with its answers
  // (contract: scanReviewQuestions). A tap answer sets the field on the row
  // the way a typed value does, and when it was the last question the row
  // is marked looked-at in the same write, so it reads Add next; a person
  // answered, nothing was chosen for them (#3009, #3018).
  const questions = scanReviewQuestions(item);
  // Held only because of its match (one of several things you have, or one
  // unique thing that may be this one): the match banner asks that, with the
  // matches to pick from. A second panel saying "Needs your review: this could
  // be any of 2 things" under "Is this the same one?" asked it twice (#3884).
  const matchAsks = !questions[0] && alreadyTracked && scanRebuy(item, { ...viewer }).kind === "hold";
  // The closed card's questions. A field-less "check the name" whose reason
  // is the keyword fallback is said by the fallback line below instead: that
  // line carries the consequence and the recovery (Retry with AI), and two
  // lines for one fact is the clutter #3009 is about.
  const cardQuestions = aiDowngraded ? questions.filter((q) => q.field !== null) : questions;
  const questionPrompt = (q: { field: string | null; prompt: string; choices: unknown[] }) => {
    if (!q.field || !topCand) return q.prompt;
    const label = menuFieldLabel(menu, topCand, q.field);
    return q.choices.length ? `Check ${label.toLowerCase()}` : `${label} is not set`;
  };
  const answerQuestion = useMutation({
    mutationFn: ({ field, value, names, quantity }: { field: string | null; value: string; names?: true; quantity?: number }) => {
      // The answer is the row's name (a held web guess taken, #2918): written
      // the way a typed name is, a person's choice, never a table field.
      if (names || !field) return api.updateScanItem(activeSlug, item.id, { name: value.trim() });
      const last = questions.length === 1 && questions[0]?.field === field;
      const kind = (item.suggested_candidates?.[0] as { kind?: string } | undefined)?.kind;
      // A pack's answer is a count too: "10 of 1 kg" is ten things (#5350).
      return api.updateScanItem(activeSlug, item.id, { fields: { [field]: value }, ...(kind ? { fields_kind: kind } : {}), ...(last ? { reviewed: true } : {}), ...(quantity ? { quantity } : {}) });
    },
    onSuccess: (_r, v) => {
      toast.success(v.names || !v.field ? "Got it - finding the right table…" : `${v.field.replace(/_/g, " ")}: ${v.value}`);
      invalidateInbox();
    },
    onError: onErr,
  });
  /** The held web guess as the question's one tap (contract: a `names`
   *  question), for the name field on the open card. */
  const nameGuess = (() => {
    const q = questions.find((x) => x.names);
    const c = q?.choices[0];
    return q && c ? { value: c.value, source: c.source, prompt: q.prompt } : null;
  })();

  const ddg = (q: string) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;

  const overlays = (
    <>
      <CameraCaptureSheet
        open={captureSheet !== null}
        title={captureSheet === "retake" ? "Retake catalog photo" : "Add a photo"}
        busy={retakeCatalog.isPending || addPhoto.isPending}
        // A picture CHOSEN from the device is attached, never promoted to the
        // display image, whichever door opened the sheet. A capture is a photo
        // of the object in front of you; a file off the camera roll is
        // routinely a listing screenshot or a spec sheet, and quietly making
        // one the item's face is worse than asking. The gallery's make-primary
        // is one tap away when it really is the picture you want.
        onCapture={(blob, opts) => {
          // The file's TYPE routes it, the same rule the inbox door states: a
          // PDF or CSV is only ever a receipt, so it goes to the parser and
          // becomes this item's purchase. Everything else is a picture.
          const f = blob instanceof File ? blob : null;
          const isReceiptDoc =
            !!f && (f.type === "application/pdf" || f.type === "text/csv" || /\.(pdf|csv)$/i.test(f.name));
          if (isReceiptDoc && f) return attachReceipt.mutate(f);
          return opts?.uploaded
            ? addPhoto.mutate({ blob, uploaded: true })
            : captureSheet === "retake"
              ? retakeCatalog.mutate(blob)
              : addPhoto.mutate(blob);
        }}
        onClose={() => setCaptureSheet(null)}
      />
      {makeBinOpen && (
        <MakeBinSheet
          item={item}
          onClose={() => setMakeBinOpen(false)}
          onArmBin={onArmBin}
        />
      )}
    </>
  );
  const cropModal = (
    <>
          {cropOpen && item.image_file_id && (
            <CropPhotoModal
              src={yoursImg ?? null}
              busy={cropCatalog.isPending}
              onCrop={(box) => cropCatalog.mutate(box)}
              onClose={() => setCropOpen(false)}
            />
          )}
          {cropAgainOpen && groupPicture && (
            <CropPhotoModal
              src={groupImg ?? null}
              busy={cropAgain.isPending}
              onCrop={(box) => cropAgain.mutate(box)}
              onClose={() => setCropAgainOpen(false)}
            />
          )}
    </>
  );
  const lightbox = (
    <>
          {zoomIdx !== null && zoomItems[zoomIdx] && (
            <ImageLightbox
              searchSlot={
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    // An address is the picture, not a phrase to look it up by.
                    const url = imageUrlFrom(zoomTerm);
                    if (url) {
                      pickCatalogImage.mutate(url);
                      setZoomIdx(null);
                      return;
                    }
                    setPhotoTerm(zoomTerm.trim());
                  }}
                  className="flex items-center gap-1.5"
                >
                  <SearchInput
                    value={zoomTerm}
                    onChange={(v) => {
                      zoomTermTouched.current = true;
                      setZoomTerm(v);
                    }}
                    placeholder="search, or paste an image link…"
                    aria-label="Search for a picture, or paste an image link"
                    size="sm"
                    tone="onDark"
                    wrapperClassName="flex-1 min-w-0"
                  />
                  <button
                    type="submit"
                    className="shrink-0 rounded border border-white/20 px-2 py-1 text-[11px] font-medium text-white/80 hover:text-white hover:border-white/40"
                  >
                    {imageUrlFrom(zoomTerm) ? "Use" : "Search"}
                  </button>
                  {(photoTerm || zoomTermTouched.current) && (
                    <button
                      type="button"
                      onClick={() => {
                        zoomTermTouched.current = false;
                        setPhotoTerm("");
                      }}
                      className="shrink-0 rounded px-2 py-1 text-[11px] text-white/50 hover:text-white/80"
                      title="Back to the automatic search"
                    >
                      Reset
                    </button>
                  )}
                </form>
              }
              items={zoomItems}
              index={zoomIdx}
              onIndex={setZoomIdx}
              onClose={() => setZoomIdx(null)}
              // Cmd+V with the viewer open. You are looking at the picture you
              // want to replace, so this is where the gesture means something:
              // a picture from the clipboard becomes the catalog photo, an
              // address is fetched into one. Both land where a picked web
              // candidate lands.
              onPasteImage={(pasted) => {
                if (pasted.kind === "file") retakeCatalog.mutate(pasted.file);
                else pickCatalogImage.mutate(pasted.url);
                setZoomIdx(null);
              }}
              tools={
                handheld
                  ? [
                      {
                        label: (it) => (it.key === "yours" && item.image_file_id ? "Rotate" : null),
                        busy: rotate.isPending,
                        onAction: () => rotate.mutate(),
                      },
                      {
                        label: (it) => (it.key === "yours" && item.image_file_id ? "Crop for catalog" : null),
                        busy: cropCatalog.isPending,
                        onAction: () => {
                          setZoomIdx(null);
                          setCropOpen(true);
                        },
                      },
                      {
                        label: (it) => (it.key === "catalog" && hasOrigCatalog ? undoLabel : null),
                        busy: catalogAction.isPending,
                        onAction: () => {
                          catalogAction.mutate("revert");
                          setZoomIdx(null);
                        },
                      },
                    ]
                  : undefined
              }
              action={{
                // Zooming YOUR photo is exactly when you decide it beats the
                // catalog shot, so the adopt action belongs here too — the card's
                // small caption button is not where you are looking at that
                // moment (reported 2026-08-11). The catalog image itself stays
                // action-less: it is already the catalog image.
                label: (it) =>
                  it.key === "catalog"
                    ? null
                    : it.key === "yours" || it.key === "crop"
                      ? "Use as catalog"
                      : "Use this image",
                busy: pickCatalogImage.isPending || catalogAction.isPending,
                onAction: (it) => {
                  if (it.key === "yours") catalogAction.mutate("use_own_photo");
                  else if (it.key === "crop") catalogAction.mutate("use_screenshot_crop");
                  else if (photoCandidates.some((o) => o.url === it.key)) pickCatalogImage.mutate(it.key);
                  setZoomIdx(null);
                },
              }}
            />
          )}
    </>
  );
  // Which AI answered, when it was not the first one asked (#3819).
  const answeredBy = answeredByLine((item.suggested_metadata as { ai_answered_by?: Parameters<typeof answeredByLine>[0] } | null)?.ai_answered_by);
  const packNote = packPartsNote(item.suggested_metadata);
  const evidenceBox = (
    <>
          {(item.ai_notes || item.ai_confidence || topCand || aiWorking || answeredBy) && (
            <div className="rounded-md border border-cobble-300 dark:border-cobble-700 bg-cobble-50/60 dark:bg-cobble-900/20 px-3 py-2">
              <button
                type="button"
                onClick={() => setAiOpen((o) => !o)}
                aria-expanded={aiOpen}
                className="w-full text-left text-xs font-medium text-content dark:text-mortar-100 flex items-center gap-1.5"
              >
                {replayNoAi ? (
                  <RefreshCw size={12} className="text-accent animate-spin" />
                ) : (
                  <Sparkles size={12} className={aiWorking ? "text-accent animate-pulse" : "text-accent"} />
                )}
                {aiWorking ? (
                  <span className="animate-pulse">
                    {rerun.isPending ? "Re-running the lookup…" : "AI is reading the details…"}
                  </span>
                ) : (
                  "Source data"
                )}
                {!aiWorking && item.ai_confidence && (
                  <span className="text-muted">· {item.ai_confidence}</span>
                )}
                {!aiWorking && item.updated_at && (
                  <span className="text-faint">· updated {relativeTime(item.updated_at)}</span>
                )}
                <ChevronDown
                  size={13}
                  className={`ml-auto text-faint transition-transform ${aiOpen ? "rotate-180" : ""}`}
                />
              </button>
              {!aiWorking && answeredBy && (
                <p className="text-xs text-muted dark:text-slate-400 mt-1" data-testid="answered-by">
                  {answeredBy}{" "}
                  {/* The order that made it so, where it can be changed. */}
                  <Link to={`/configuration/ai#${WHO_ANSWERS_ANCHOR}`} className="text-accent hover:underline">
                    Who does what, in order
                  </Link>
                </p>
              )}
              {aiOpen && (<>
              {/* A warning already reads in amber above; repeating it here in
                  muted body text says it twice and says it quieter. */}
              {photoCheckIsLive(item) && (
                <p className="text-xs text-accent animate-pulse mt-1" data-testid="photo-check-live">{PHOTO_CHECK_NOTE}</p>
              )}
              {notesPlacement.sourceBox && (
                <p className="text-xs text-muted dark:text-slate-400 mt-1" data-testid="source-note">{notesPlacement.boxText}</p>
              )}
              {/* What the AI asserted, apart from what was read off the code,
                  the photo or the receipt: the confidence above is the
                  identification's, and says nothing about these (#3070). */}
              {contributedFields.map(([field, st]) => (
                <div key={field} className="text-xs text-muted dark:text-slate-400 mt-1" data-testid="field-contributions">
                  <p className="text-content dark:text-mortar-100">{provenanceHeadline(humanFieldLabel(field).toLowerCase(), st)}</p>
                  <ul className="list-disc pl-4">
                    {provenanceLines(st).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {assertedFields.length > 0 && (
                <p className="text-xs text-muted dark:text-slate-400 mt-1" data-testid="asserted-fields">
                  Said by the AI, not read off the item:{" "}
                  {assertedFields.map((f, i) => (
                    <span key={f.field}>
                      {i > 0 && ", "}
                      {humanFieldLabel(f.field).toLowerCase()} <span className="text-content dark:text-mortar-100">{f.value}</span>
                    </span>
                  ))}
                  .
                </p>
              )}
              {/* A re-run is a gamble you can LOSE: vision re-read a dark photo of
                  a tool tote as a "Portable Bluetooth Speaker" and the good name
                  was gone, recoverable only by hand-reading the raw AI call log
                  (reported 2026-07-17). The run snapshots what it's about to
                  overwrite, so the way back is one tap. Shown only while a
                  snapshot exists — the next run replaces it, and undoing clears it. */}
              {(() => {
                const snap = (
                  item.suggested_metadata as { pre_rerun?: { name?: string | null; kind?: string } } | null
                )?.pre_rerun;
                if (!snap || item.status !== "pending") return null;
                return (
                  // ONE LINE, no panel. A bordered, tinted box with its own
                  // padding spent roughly 70px on a sentence and a button, and
                  // the sentence wrapped so the button fell below it. The amber
                  // stays on the control, which is the part that acts.
                  <div className="mt-1.5 flex items-center gap-2 min-w-0">
                    <span className="min-w-0 truncate text-[11px] text-muted dark:text-slate-400">
                      {snap.name ? (
                        <>
                          {/* The NAME is the thing you are deciding about, so the
                              label gets out of its way. Which mechanism replaced
                              it (replay vs re-run) is in the history below and
                              does not need saying twice, and "revert" is not
                              repeated because the button beside it says so. */}
                          Previously:{" "}
                          <span className="font-medium text-content dark:text-mortar-100">{snap.name}</span>
                        </>
                      ) : (
                        <>This {snap.kind === "replay" ? "replay" : "re-run"} replaced the previous answer</>
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => undoRerun.mutate()}
                      disabled={undoRerun.isPending}
                      className="shrink-0 inline-flex items-center gap-1 rounded-full border border-amber-400 dark:border-amber-700 text-amber-800 dark:text-amber-300 hover:bg-amber-100/70 dark:hover:bg-amber-900/30 px-2 py-0.5 text-[11px] font-medium transition disabled:opacity-50"
                    >
                      <RotateCcw size={11} className={undoRerun.isPending ? "animate-spin" : ""} />
                      {undoRerun.isPending ? "Reverting…" : "Revert"}
                    </button>
                  </div>
                );
              })()}
              {/* Per-item history — what you did to this listing, newest first.
                  ("You asked for more detail · 2 min ago".) */}
              {(() => {
                const hist = (
                  item.suggested_metadata as { history?: { action: string; at: string; note?: string }[] } | null
                )?.history;
                if (!Array.isArray(hist) || hist.length === 0) return null;
                const label: Record<string, string> = {
                  rerun: "Re-ran the lookup with AI",
                  replay: "Replayed: the latest processing, same identification",
                  "rerun-hint": "Re-ran with a hint",
                  hint: "Read the hint",
                  "confirm-guess": "Confirmed the first look",
                  "reject-guess": "Said the first look was wrong",
                  "crop-again": "Cut it again from the group photo",
                  barcode: "Corrected the barcode",
                  wrong: "Flagged wrong, re-checked everything",
                  enrich: "Asked for more detail",
                  confirm: "Locked into the barcode database",
                  combine: "Combined similar items",
                  "undo-rerun": "Undid the re-run",
                  "store-code": "Named again from its photo: a shop's own barcode",
                };
                // "Re-ran the lookup with AI" is written when the run STARTS,
                // so on its own it claims something the run may never have
                // delivered - the monitor-label item read exactly that for a run
                // the AI never answered (reported 2026-08-10). The row stamps
                // whether a model answered the LATEST run; the newest entry IS
                // that run, so the outcome is reported there and nowhere else.
                // Only for actions that ASK the AI - a replay is no-AI by design.

                return (
                  <div className="mt-2 border-t border-line dark:border-slate-700/60 pt-1.5">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">history</div>
                    {/* The LIST scrolls, the card does not grow. Nothing is
                        dropped: an unbounded history is what makes this rail
                        tall, and the rail's height is the card's height.
                        Newest first, so the useful end needs no scrolling. */}
                    <ul className="space-y-0.5 max-h-20 overflow-y-auto pr-1">
                      {[...hist].reverse().map((h, i) => {
                        // The verdict rides on the ENTRY, so it stays with the
                        // run it describes instead of hopping to whatever is
                        // newest (reported 2026-08-10).
                        const noAnswer = (h as { ai_answered?: boolean }).ai_answered === false;
                        return (
                        <li key={i} className="text-[11px] text-muted dark:text-slate-400 flex items-baseline gap-2">
                          <span className="min-w-0">
                            {label[h.action] ?? h.action}
                            {noAnswer && (
                              <span className="text-amber-600 dark:text-amber-400"> - {RUN_NO_ANSWER_WORDS}</span>
                            )}
                            {h.note ? `: “${h.note}”` : ""}
                          </span>
                          <span className="text-faint ml-auto whitespace-nowrap">{relativeTime(h.at)}</span>
                        </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })()}
              {/* The actual data the lookup returned — every parsed field, so it's
                  visible even when the form has no box for it, plus the raw dump. */}
              {(() => {
                const fields = parsedScanFields(item.suggested_metadata as Record<string, unknown> | null);
                const entries = Object.entries(fields).filter(([, v]) => v != null && v !== "");
                if (entries.length === 0) return null;
                return (
                  <div className="mt-1.5">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1">Parsed fields</div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                      {entries.map(([k, v]) => {
                        const sw = /colou?r/i.test(k) ? colorSwatch(v) : null;
                        return (
                        <div key={k} className="flex items-baseline gap-1.5 text-[11px] min-w-0">
                          {sw && <span className="h-2.5 w-2.5 self-center shrink-0 rounded-full border border-line dark:border-slate-600" style={{ background: sw }} />}
                          <span className="shrink-0 text-faint">{humanizeKey(k)}</span>
                          <span className="truncate font-medium text-content dark:text-mortar-200">{String(v)}</span>
                        </div>
                        );
                      })}
                    </div>
                    {!handheld && (
                    <details className="mt-1.5">
                      <summary className="cursor-pointer select-none text-[10px] text-faint hover:text-muted">raw response</summary>
                      <pre className="mt-1 overflow-x-auto rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-2 text-[10px] leading-snug text-content dark:text-mortar-200">
{JSON.stringify(item.suggested_metadata, null, 2)}
                      </pre>
                    </details>
                    )}
                  </div>
                );
              })()}
              {/* What the scan read for its top table, shown only while the
                  row is still headed there: under a pill that says another
                  table, these read as that table's fields. */}
              {topCand && dest && entryKey(dest.module, dest.instance) === entryKey(topCand.module, topCand.instance) && Object.keys(topCand.fields).length > 0 && (
                <div className="flex flex-wrap items-center gap-1 mt-1.5">
                  <span className="text-[11px] text-muted dark:text-slate-400">
                    → {topCand.label}:
                  </span>
                  {Object.entries(topCand.fields).map(([k, v]) => (
                    <span
                      key={k}
                      className="inline-flex items-center gap-1 rounded-full bg-surface dark:bg-slate-800 border border-line dark:border-slate-700 px-2 py-0.5 text-[11px] text-content dark:text-mortar-200"
                    >
                      <span className="text-faint">{menuFieldLabel(menu, topCand, k)}</span>
                      {String(v)}
                    </span>
                  ))}
                </div>
              )}
              {/* Audit links live with the provenance they audit — they were an
                  everyday-looking row of the identity strip (review F6). */}
              {(item.barcode_text || item.suggested_name) && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                  <span className="text-faint">Sanity-check on the web:</span>
                  {item.barcode_text && (
                    <a
                      href={ddg(item.barcode_text)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline inline-flex items-center gap-0.5"
                    >
                      barcode <ExternalLink size={10} />
                    </a>
                  )}
                  {item.suggested_name && (
                    <a
                      href={`${ddg(item.suggested_name)}&iax=images&ia=images`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline inline-flex items-center gap-0.5"
                    >
                      name (images) <ExternalLink size={10} />
                    </a>
                  )}
                </div>
              )}
              </>)}
            </div>
          )}
    </>
  );
  // A hand-over: offered to you (Take / Pass / Maybe later), or from here.
  const offerStrip = <ScanOfferStrip item={item} slug={activeSlug} />;
  const hintBox = (
          <HintBox
            onSubmit={(h, opts) => rerun.mutate({ hint: h || undefined, ...opts })}
            busy={aiWorking}
            busyKind={aiWorking ? (replayNoAi ? "replay" : "ai") : null}
            hasBarcode={!!item.barcode_text}
            onConfirm={() => confirmBarcode.mutate()}
            confirming={confirmBarcode.isPending}
            // Only when the status has LOADED and says no. A null status means
            // "not answered yet", and greying a working button during that
            // window is worse than the button being live for a moment.
            aiOff={!aiReach(cardAiStatus).identify}
            webCheckOff={!aiReach(cardAiStatus).chat}
            phone={handheld}
            rowLeading={handheld ? null : (
              <>
              {editingBarcode ? (
                <span className="inline-flex items-center gap-1 font-mono" onClick={(e) => e.stopPropagation()}>
                  ▌▌
                  <input
                    autoFocus
                    inputMode="numeric"
                    value={barcodeDraft}
                    onChange={(e) => setBarcodeDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveBarcode();
                      else if (e.key === "Escape") setEditingBarcode(false);
                    }}
                    placeholder="digits from the label"
                    className="w-36 rounded border border-accent bg-surface dark:bg-slate-900 px-1.5 py-0.5 font-mono text-content outline-none"
                  />
                  <button
                    type="button"
                    disabled={rerun.isPending || !barcodeDraftValid}
                    onClick={saveBarcode}
                    className="rounded bg-cobble-600 hover:bg-cobble-700 px-2 py-0.5 text-[11px] font-medium text-white transition disabled:opacity-50"
                  >
                    {rerun.isPending ? "Looking up…" : "Save & re-run"}
                  </button>
                  <button
                    title="Cancel barcode edit"
                    type="button"
                    onClick={() => setEditingBarcode(false)}
                    className="text-faint hover:text-content"
                    aria-label="Cancel barcode edit"
                  >
                    <X size={12} />
                  </button>
                </span>
              ) : item.barcode_text ? (
                <span className="inline-flex items-center gap-1 font-mono text-content dark:text-mortar-200 bg-subtle dark:bg-slate-800 rounded px-2 py-0.5">
                  ▌▌{item.barcode_text}
                  {item.status === "pending" && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setBarcodeDraft(item.barcode_text ?? "");
                        setEditingBarcode(true);
                      }}
                      title="Edit the barcode - saving re-runs the lookup on the corrected code"
                      aria-label="Edit the barcode"
                      className="text-faint hover:text-accent transition"
                    >
                      <Pencil size={11} />
                    </button>
                  )}
                </span>
              ) : item.status === "pending" ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setBarcodeDraft("");
                    setEditingBarcode(true);
                  }}
                  title="Type the barcode off the label - it identifies the product exactly"
                  className="inline-flex items-center gap-1 font-mono text-muted dark:text-slate-400 border border-dashed border-line dark:border-slate-700 rounded px-2 py-0.5 hover:border-accent hover:text-content transition"
                >
                  ▌▌ Add barcode
                </button>
              ) : null}
              </>
            )}
            rowTrailing={
              <>
              {looksFineResolves && !handheld && (
                <button
                  type="button"
                  disabled={markReviewed.isPending}
                  onClick={(e) => {
                    e.stopPropagation();
                    markReviewed.mutate();
                  }}
                  title="A human looked - this one's fine; stop flagging it"
                  className="inline-flex items-center gap-1 rounded border border-emerald-400/60 px-2 py-0.5 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 transition disabled:opacity-50 max-sm:min-h-11 max-sm:px-3"
                >
                  ✓ Looks fine
                </button>
              )}
              </>
            }
          />
  );
  const identityRow = (
    <>
          {/* Identity row: barcode + area + sanity-check links. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {/* The barcode is EDITABLE while pending. The camera/vision can read
                a digit wrong, and before this the row was display-only: the one
                field a "correct barcode X" correction was about was the one
                field it couldn't reach, so every re-run faithfully re-resolved
                the misread code (reported 2026-08-03). Saving re-runs the lookup on
                the corrected code. */}
            {item.scan_area && (
              <span className="inline-flex items-center gap-1 text-muted dark:text-slate-400">
                <MapPin size={11} className="text-accent" /> {item.scan_area}
              </span>
            )}
            {/* The suggested spot is offered ONCE, beside the Location field
                in the form (#3074); it used to sit here too, as a second
                "Put here" that did the same write. */}
          </div>
    </>
  );
  const photoStrip = (
              <PhotoOptions
                item={item}
                onView={openZoomUrl}
                onItems={setPhotoCandidates}
                term={photoTerm}
                onTerm={setPhotoTerm}
                onSearched={setPhotoSearched}
                compact
                phone={handheld}
                // No add button here. It widened the strip's first column for a
                // job the card's camera menu ("Add a photo") already does, and
                // that width is exactly what the tiles want.
                leadingLabel={
                  yourPictures(resolved.pictures).length === 0 ? undefined : (
                    <span className="text-xs font-medium text-content shrink-0">Your photos</span>
                  )
                }
                // The row's own pictures from the one resolver (#3046): a
                // split child's crop and group shot, an ordinary row's photo
                // and the photos added to it. A row with none gets no column
                // and no label, on a phone and on a desk alike (the #2982
                // rule, generalised).
                leading={
                  yourPictures(resolved.pictures).length === 0 ? undefined : (
                    <ScanYourPhotos
                      slug={activeSlug}
                      row={item}
                      actions={{
                        onView: (p) => {
                          const u = resolved.src(p);
                          if (u) openZoomUrl(u);
                        },
                        onMakePrimary: (pid) => setPrimaryPhoto.mutate(pid),
                        onRemove: (pid) => removeExtraPhoto.mutate(pid),
                        onReidentify: item.status === "pending" ? (pid) => rerun.mutate({ imageFileId: pid }) : undefined,
                        onCropAgain: () => setCropAgainOpen(true),
                        busy: setPrimaryPhoto.isPending || removeExtraPhoto.isPending || rerun.isPending,
                      }}
                    />
                  )
                }
              />
  );
  const confirmForm = (
    <>
          {!planContext && formOpen && !receiptUnread && <ConfirmForm
            // The row and the chosen table ONLY. This key once carried the name,
            // the maker, the AI timestamp and the top route's fields, so every
            // refetch that moved one of them remounted the whole form and every
            // input in it: the owner was thrown out of the Name box ten times
            // while his re-run updated the row (#2982). Server changes now reach
            // the form through props and the held-field rule (scanHeldField.ts).
            key={`${item.id}:${formCtx.selKey ?? "auto"}`}
            item={item}
            menu={menu}
            candidates={candidates}
            hasLocations={hasLocations}
            initialKey={formCtx.selKey}
            prefill={formCtx.prefill}
            // The form's "Add to" is the same choice as the pill: stored on
            // the row and stamped the person's, so Replay, a re-identify and
            // the list all read it (#3062, #3587).
            onPickDestination={(k) => {
              formPickedKey.current = k;
              pickDestination.mutate(k);
            }}
            onDone={() => {
              setFormOpen(false);
              setExpanded(false);
            }}
            // Cancel undoes the EDIT, not your place. It used to be identical to
            // onDone - close the form AND collapse the card - so cancelling an edit
            // slammed the accordion shut and landed you on the closed row's
            // "Add to Inventory…", which read as the card doing something weird
            // rather than as your edit being discarded. Now: the chips go back to
            // read-only, and you are still looking at the card you opened.
            onCancel={() => setFormOpen(false)}
            onCollapse={sheet ? undefined : () => setExpanded(false)}
            actionsLayout={sheet ? "row" : "stack"}
            fieldsLayout={sheet ? "list" : "chips"}
            actionSlot={actionSlot}
            fieldSlot={sheet ? null : fieldSlot}
            locSlot={locSlot}
          />}
    </>
  );

  // ── the phone: its own row and its own screen, fed by the brain above ──
  // (ScanPhoneRow.tsx, ScanItemScreen.tsx). The desktop card follows.
  const subtitleParts = (() => {
    const segs: string[] = [];
    const brand = item.suggested_manufacturer?.trim() || creatorOf(item);
    if (brand) segs.push(brand);
    const shop = (item.suggested_metadata as { receipt_vendor?: string } | null)?.receipt_vendor;
    if (!item.suggested_manufacturer && shop?.trim()) segs.push(leadWords("from", shop));
    if (item.suggested_sku) segs.push(item.suggested_sku);
    const filedInto = item.target_location_id ? (cardLocs.data?.items ?? []).find((l) => l.id === item.target_location_id) : null;
    if (filedInto) segs.push(`📍 ${filingLabel(filedInto)}`);
    else if (item.scan_area) segs.push(`📍 ${item.scan_area}`);
    else if (suggested) segs.push(`📍 ${suggested.place} · ${suggested.why}`);
    const ps = (item.suggested_metadata as { pack_size?: number } | null)?.pack_size;
    if (ps) segs.push(`${ps}-pack`);
    if (boxState) segs.push(boxState === "empty-box" ? "📦 empty box" : "📦 in box");
    if ((item.suggested_metadata as { split_from?: string } | null)?.split_from) segs.push("✂ from split");
    return segs;
  })();
  const phoneSubtitle = subtitleParts.join(" · ");
  // A piece still on the group photo says so on every surface: the desk row,
  // the item screen and the phone row (scanSplitUncut, #3614).
  const splitUncut = scanSplitUncut(item);
  const cropSplitPiece = () => (groupPicture ? setCropAgainOpen(true) : setCropOpen(true));
  const phoneWarning = notesPlacement.amber ? notesPlacement.amberText : flaggedForReview && !matchAsks && item.suggested_name ? reviewReason : null;
  // The card asks its question instead of reading the sentence; the item
  // screen keeps the sentence, where the evidence is.
  // The same picture twice comes first: it is the one line whose answer
  // (keep one) makes the rest of the row's questions moot for the copy.
  const phoneRowWarning =
    (twinIds.length ? TWIN_SENTENCE : null) ??
    (awaiting?.offerWaysOut ? awaiting.line : null) ??
    (questions.length > 0 && (item.suggested_name || questions[0]?.names) ? null : phoneWarning) ??
    splitUncut?.sentence ??
    null;
  const phoneWorking = rerunning
    ? replayNoAi ? "Replaying the latest processing…" : "Re-running the lookup…"
    : serverMatching ? "AI is reading the details…"
    : rlActive ? "Rate-limited, retrying…"
    : readingReceipt ? "Reading the receipt's lines…"
    : split.isPending ? "Splitting the photo…"
    : null;
  const phoneAddLabel = dest && !isUnidentified(item.suggested_name) ? `Add to ${dest.label}…` : "Add to a table…";
  const blockedAsk = rowState.action.kind === "blocked" && (rowState.ask?.length ?? 0) > 0;
  // The phone offers a tool by the row's own `tool_hints` (#3006): likely
  // inline, possible behind the fold with its reason, no not at all. A row
  // with no hints (an older api) offers every tool, as before.
  const phoneTool = (t: ScanTool): { folded?: string } | null => {
    const h = item.tool_hints?.[t];
    if (!h || h.relevance === "likely") return {};
    if (h.relevance === "no") return null;
    return { folded: h.reason };
  };
  const toolSplit = phoneTool("split");
  const toolReceipt = phoneTool("receipt");
  const toolBin = phoneTool("bin");
  const toolBox = phoneTool("box_state");
  if (station && !stationMore) {
    const oneTap = rowState.action.kind === "add" || rowState.action.kind === "install-add" || rowState.action.kind === "merge";
    const filed = { onSuccess: () => station.onFiled() };
    return (
      <>
        <StationNewFace
          photo={thumb}
          name={shownName ?? ""}
          working={phoneWorking}
          quantity={receiptUnread || restockMatch || item.status !== "pending" ? null : { value: isOwnCopy(item.suggested_metadata) ? (item.quantity ?? 1) : Math.max(1, item.quantity ?? 1), busy: qtyPatch.isPending, onChange: (n) => qtyPatch.mutate(Math.max(1, n)) }}
          commit={
            dest && item.status === "pending" && oneTap && !restockMatch
              ? {
                  label: rowState.action.label,
                  destination: updating ? `${updating.title} in ${dest.label}` : dest.label,
                  busy: commitBusy,
                  onAdd: () => (rowState.action.kind === "merge" ? quickMerge.mutate(undefined, filed) : quickConfirm.mutate(undefined, filed)),
                }
              : null
          }
          reason={rowState.sentence ?? rowState.action.title ?? null}
          fixing={stationFixing}
          onFix={() => setStationFixing(true)}
          fixName={<CorrectNameInline slug={activeSlug} itemId={item.id} initial={shownName ?? ""} large onDone={() => setStationFixing(false)} />}
          onMore={() => setStationMore(true)}
        />
        {overlays}
      </>
    );
  }
  // Whatever other modules declared into a scan item: the card's body and
  // the phone's item sheet show the same ones, so a receipt row says where
  // its parcel is on either.
  const contributedPanels = receiptGroupId ? (
    <ContributedDetailPanels
      target="core-scan:item"
      // NOT the universal side-cars. An inbox row is not a record: its
      // id belongs to the scan item, and filing it creates a DIFFERENT
      // record with a different id. A conversation or a tag attached
      // here is silently orphaned the moment somebody acts on the row,
      // which is worse than not offering one.
      //
      // This slot was built for one named contributor (the receipt
      // lines banner) and is gated on a receipt group for that reason.
      universal={false}
      ctx={{
        slug: activeSlug,
        entityId: item.id,
        entityTitle: item.suggested_name ?? "this item",
        hints: {
          receipt_group_id: receiptGroupId,
          // A line that came OFF this receipt sits in the inbox beside
          // its siblings, so a panel counting them is describing the
          // rows immediately above and below it. The panel that earns
          // its place is the other case: a receipt attached to an item
          // you already had, where the rest of the order is nowhere on
          // screen. Say which case this is and let the panel decide.
          siblings_visible: item.source_kind === "receipt" ? "yes" : "no",
          // The order line this row came from, when the read recorded
          // one: where its parcel is, before it is any record.
          receipt_order_item_id: typeof item.suggested_metadata?.receipt_order_item_id === "string" ? item.suggested_metadata.receipt_order_item_id : undefined,
        },
      }}
    />
  ) : null;
  if (sheet) {
    const actions: ScanItemScreenAction[] = [];
    if (item.status === "pending") {
      if (item.image_file_id && !multiItem && toolSplit) actions.push({ ...toolSplit, tool: "split", label: "Split into items", icon: screenIcons.split, hint: "Several different things in one photo", busy: split.isPending, onClick: () => split.mutate() });
      if (item.image_file_id && toolReceipt) actions.push({ ...toolReceipt, tool: "receipt", label: "Read as a receipt", icon: screenIcons.receipt, hint: "This photo is a receipt: split into its lines", busy: asReceipt.isPending, onClick: () => asReceipt.mutate() });
      if (combinedCount) actions.push({ label: SCAN_UNDO_ACTIONS.undoCombine, icon: screenIcons.undo, hint: `Put the ${countOf(combinedCount, "scan")} back as they were`, busy: uncombine.isPending, onClick: () => uncombine.mutate() });
      if ((item.suggested_metadata as { split_from?: string } | null)?.split_from) actions.push({ label: SCAN_UNDO_ACTIONS.undoSplit, icon: screenIcons.undo, hint: "Put the group photo back; every piece goes to Recently deleted", busy: unsplit.isPending, onClick: () => unsplit.mutate() });
      if (hasLocations && toolBin) actions.push({ ...toolBin, tool: "bin", label: "Turn into a bin", hint: "This IS a container: make it a location you can scan into", onClick: () => setMakeBinOpen(true) });
      if (toolBox) actions.push({ ...toolBox, tool: "box_state", group: "box_state", label: boxState === "empty-box" ? "Not an empty box" : "Empty box", hint: BOX_STATE_EFFECT["empty-box"], busy: setBoxState.isPending, onClick: () => setBoxState.mutate(boxState === "empty-box" ? null : "empty-box") });
      if (toolBox) actions.push({ ...toolBox, tool: "box_state", group: "box_state", label: boxState === "item-in-box" ? "Not in its box" : "Item in box", hint: BOX_STATE_EFFECT["item-in-box"], busy: setBoxState.isPending, onClick: () => setBoxState.mutate(boxState === "item-in-box" ? null : "item-in-box") });
      // "Put it where suggested" lives beside the Location field now (#3074).
    }
    return (
      <ScanItemScreen
        item={item}
        receipt={receiptBlock}
        nav={sheet}
        subtitle={phoneSubtitle}
        modelName={modelName && item.status === "pending" ? { name: modelName, busy: renameTitle.isPending, onApply: () => renameTitle.mutate(modelName) } : null}
        barcode={{
          value: item.barcode_text ?? null,
          editing: editingBarcode,
          draft: barcodeDraft,
          valid: barcodeDraftValid,
          pending: rerun.isPending,
          canEdit: item.status === "pending",
          onStart: () => {
            setBarcodeDraft(item.barcode_text ?? "");
            setEditingBarcode(true);
          },
          onDraft: setBarcodeDraft,
          onSave: saveBarcode,
          onCancel: () => setEditingBarcode(false),
        }}
        warning={phoneWarning}
        working={phoneWorking}
        uncut={splitUncut ? { ...splitUncut, onCrop: cropSplitPiece } : null}
        // The screen leads with what the row asks: the contract's question
        // with its tap answers, then the other ways to settle it. Looks fine
        // is one of those answers (the human override that stops the
        // nagging), so it lives here and nowhere else on the phone; a row
        // with no flag has no block and no Looks fine (#3018).
        review={
          rowState.eligibility === "needs-review" && !matchAsks
            ? (() => {
                // Every reason the resolver holds a row back leads the screen
                // with its sentence: a doubt's question when there is one, else
                // the sentence itself (a duplicate, a keyword route). Looks fine
                // retires whichever it is, as the resolver reads `reviewed`.
                const q = questions[0];
                const typed = q && q.field && !q.choices.length;
                return {
                  prompt: q ? questionPrompt(q) : rowState.sentence ?? "Check this item",
                  because: q ? rowState.sentence ?? q.because ?? "" : "",
                  busy: answerQuestion.isPending || markReviewed.isPending,
                  choices: (q?.choices ?? []).map((c) => ({ value: c.value, source: c.source, onPick: () => q && (q.field || q.names) && answerQuestion.mutate({ field: q.field, value: c.value, ...(q.names ? { names: true as const } : {}), ...(c.quantity ? { quantity: c.quantity } : {}) }) })),
                  actions: [
                    ...(typed && !formOpen ? [{ label: "Type it", hint: "Set the value on the form below", onClick: () => openForm(dest ?? undefined) }] : []),
                    looksFineResolves
                      ? { label: "Looks fine", hint: "A person looked; stop flagging it", busy: markReviewed.isPending, onClick: () => markReviewed.mutate() }
                      : { label: "Name it", hint: "Nothing files without a name", onClick: focusName },
                  ],
                };
              })()
            : null
        }
        photoName={photoSuggestedName && photoSuggestedName !== (item.suggested_name ?? "") ? { name: photoSuggestedName, busy: applyPhotoName.isPending, onApply: () => applyPhotoName.mutate() } : null}
        multi={multiItem ? { distinct: multiItem.distinct ?? multiItem.individuals.length, names: multiItem.individuals.map((i) => i.name), onSplit: () => split.mutate(), onKeep: () => keepGrouped.mutate(), busy: split.isPending || keepGrouped.isPending } : null}
        pictures={{
          yours: yoursImg && yoursImg !== catalogImg ? yoursImg : null,
          catalog: catalogImg,
          catalogChecking: unverified,
          catalogCaption: catalogCaption(resolved.pictures),
          onOpenYours: () => openZoom("yours"),
          onOpenCatalog: () => openZoom("catalog"),
          onCapture: () => setCaptureSheet("add"),
          onRetake: item.image_file_id ? () => setCaptureSheet("retake") : null,
          // An empty slot is a tap that opens the picker; the file lands
          // where the slot says, through the routes the Photo button uses
          // (#2982): the catalog picture, or a photo of the person's own.
          onPickCatalog: (f) => retakeCatalog.mutate(f),
          onPickYours: (f) => addPhoto.mutate({ blob: f, uploaded: true }),
          onYoursBroken: () => markBroken(yoursRawUrl),
          onCatalogBroken: () => markBroken(catalogUrl),
        }}
        actions={actions}
        slots={{
          nameIt: cantIdentify ? <NameItInline slug={activeSlug} itemId={item.id} /> : undefined,
          panels: contributedPanels,
          tracked:
            item.status === "pending" ? (
              <>
                <SamePictureOffer slug={activeSlug} itemId={item.id} />
                <TrackedMatchBanner item={item} locationId={item.target_location_id} stamped={restockMatch} />
              </>
            ) : undefined,
          strip: !isUnidentified(item.suggested_name) ? <div onClick={(e) => e.stopPropagation()}>{photoStrip}</div> : undefined,
          form: confirmForm,
          evidence: evidenceBox,
          correction: (
            <>
              {offerStrip}
              {hintBox}
              {identityRow}
            </>
          ),
          overlays: (
            <>
              {overlays}
              {lightbox}
              {cropModal}
            </>
          ),
        }}
        footer={{
          formOpen,
          // A record the workspace counts: the banner's count control files
          // this scan, so the footer offers the other answer, a new record.
          addLabel: restockMatch ? "File as a different one" : rowState.action.kind === "merge" || blockedAsk ? rowState.action.label : phoneAddLabel,
          onOpenForm: restockMatch ? () => openForm(dest ?? undefined) : rowState.action.kind === "merge" ? runCommit : blockedAsk ? () => askToFile.mutate() : () => openForm(dest ?? undefined),
          // The screen's footer says what the row says (#3076): +1 more runs
          // the merge, and a blocked row's Ask raises the ask, never a form
          // whose Confirm would meet the refusal a second time.
          primary: receiptBlock
            ? receiptBlock.alreadyIn
              ? {
                  label: RECEIPT_READ_ANYWAY,
                  title: receiptAlreadyInSentence(receiptBlock.alreadyIn.label, receiptBlock.alreadyIn.lines),
                  busy: receiptBlock.reading,
                  onClick: receiptBlock.onReadAnyway,
                }
              : { label: RECEIPT_READ_AGAIN, title: RECEIPT_UNREAD_SENTENCE, busy: receiptBlock.reading, onClick: receiptBlock.onReadAgain }
            : rowState.action.kind === "merge" && !restockMatch
              ? { label: rowState.action.label, title: rowState.action.title, busy: commitBusy, onClick: runCommit }
              : blockedAsk
                ? { label: rowState.action.label, title: rowState.action.title, busy: askToFile.isPending, onClick: () => askToFile.mutate() }
                : null,
          filedOnScreen: !!restockMatch && !receiptBlock,
          onDiscard: () => discard.mutate(),
          discardPending: discard.isPending,
          setActionSlot,
        }}
      />
    );
  }
  if (phoneRow) {
    const destEntry = dest ? (menu ?? []).find((m) => m.module === dest.module && (m.instance ?? null) === (dest.instance ?? null)) : undefined;
    const userValues = (((item.suggested_metadata as { user_fields?: { values?: Record<string, unknown> } } | null)?.user_fields?.values) ?? {}) as Record<string, unknown>;
    const liveFields = dest ? fieldsStillOnTable(destEntry, dest.fields) : {};
    // The same dedupe the desktop chips use: nothing the subtitle already
    // says (the brand, the shop, an ISBN), no quiet default, nothing a
    // sibling field implies. Three at most; Details has them all.
    const brandLower = (item.suggested_manufacturer ?? "").trim().toLowerCase();
    const creatorLower = (creatorOf(item) ?? "").trim().toLowerCase();
    const shopLower = ((item.suggested_metadata as { receipt_vendor?: string } | null)?.receipt_vendor ?? "").trim().toLowerCase();
    // Never the same value twice on one row: the contract's compactCardFields
    // drops a field the title line or the subtitle already prints (the ISBN
    // in "ISBN 9785170058907", the brand in the name, the shop) and reads
    // every label as words (#3077). The scan's own "not news" rules (a quiet
    // default, a value a sibling implies, a fact the receipt states) stay
    // on top of that; three at most, Details has them all.
    const chips = compactCardFields(
      Object.entries(liveFields)
        .filter(([k, v]) => {
          if (v == null || String(v).trim() === "") return false;
          if (isQuietDefault(k, v) || isImpliedByPeer(k, v, liveFields)) return false;
          return !isStatedByReceipt(k, v, item.suggested_metadata as { receipt_date?: unknown; receipt_vendor?: unknown } | null);
        })
        .map(([k, v]) => ({ name: k, label: dest ? menuFieldLabel(menu, dest, k) : null, value: v })),
      [shownName, item.barcode_text, phoneSubtitle, brandLower, creatorLower, shopLower],
    )
      .slice(0, 3)
      .map(({ name: k, label, value: v }) => ({ key: k, label, value: `${String(v)}${whoFromBeside(dest?.fields, k)}`, confirmed: k in userValues, swatch: /colou?r/i.test(k) ? colorSwatch(v) : null }));
    const splitFrom = (item.suggested_metadata as { split_from?: string } | null)?.split_from;
    const more: ScanPhoneRowAction[] = [];
    if (item.status === "pending") {
      more.push({ label: "Replay processing", hint: "Free: keeps the identification, re-applies routing and fields", busy: aiWorking, onClick: () => rerun.mutate({ noAi: true }) });
      if (item.image_file_id && !multiItem && toolSplit) more.push({ ...toolSplit, tool: "split", label: "Split into items", hint: "Several different things in one photo", busy: split.isPending, onClick: () => split.mutate() });
      if (item.image_file_id && toolReceipt) more.push({ ...toolReceipt, tool: "receipt", label: "Read as a receipt", hint: "This photo is a receipt: split into its lines", busy: asReceipt.isPending, onClick: () => asReceipt.mutate() });
      if (combinedCount) more.push({ label: SCAN_UNDO_ACTIONS.undoCombine, hint: `Put the ${countOf(combinedCount, "scan")} back as they were`, busy: uncombine.isPending, onClick: () => uncombine.mutate() });
      if (splitFrom) more.push({ label: SCAN_UNDO_ACTIONS.undoSplit, hint: "Put the group photo back; every piece goes to Recently deleted", busy: unsplit.isPending, onClick: () => unsplit.mutate() });
      if (hasLocations && toolBin) more.push({ ...toolBin, tool: "bin", label: "Turn into a bin", hint: "This IS a container: make it a location you can scan into", onClick: () => setMakeBinOpen(true) });
      if (toolBox) more.push({ ...toolBox, tool: "box_state", group: "box_state", label: boxState === "empty-box" ? "Not an empty box" : "Empty box", hint: BOX_STATE_EFFECT["empty-box"], busy: setBoxState.isPending, onClick: () => setBoxState.mutate(boxState === "empty-box" ? null : "empty-box") });
      if (toolBox) more.push({ ...toolBox, tool: "box_state", group: "box_state", label: boxState === "item-in-box" ? "Not in its box" : "Item in box", hint: BOX_STATE_EFFECT["item-in-box"], busy: setBoxState.isPending, onClick: () => setBoxState.mutate(boxState === "item-in-box" ? null : "item-in-box") });
      if (looksFineResolves) more.push({ label: "Looks fine", hint: "A person looked; stop flagging it", busy: markReviewed.isPending, onClick: () => markReviewed.mutate() });
      more.push({ label: "Discard", hint: "Recoverable from Recently deleted", busy: discard.isPending, danger: true, onClick: () => discard.mutate() });
    }
    return (
      <>
          <ScanPhoneRow
            item={item}
            receipt={receiptBlock}
            thumb={thumb}
            pictureNote={unsavedNote}
            onThumbBroken={() => markBroken(catalogImg ? catalogUrl : yoursRawUrl)}
            onViewImage={thumb ? () => openZoom(catalogImg ? "catalog" : "yours") : null}
            subtitle={[item.barcode_text, phoneSubtitle].filter(Boolean).join(" · ")}
            question={
              cardQuestions[0] && (item.suggested_name || cardQuestions[0].names)
                ? {
                    prompt: questionPrompt(cardQuestions[0]),
                    because: cardQuestions[0].because,
                    busy: answerQuestion.isPending,
                    choices: cardQuestions[0].choices.map((c) => ({ value: c.value, source: c.source, onPick: () => cardQuestions[0] && (cardQuestions[0].field || cardQuestions[0].names) && answerQuestion.mutate({ field: cardQuestions[0].field, value: c.value, ...(cardQuestions[0].names ? { names: true as const } : {}), ...(c.quantity ? { quantity: c.quantity } : {}) }) })),
                    // A names question is typed on the item screen, where the name field is.
                    onType: cardQuestions[0].field && dest ? () => openForm(dest) : cardQuestions[0].names && onOpenSheet ? () => onOpenSheet(dest) : null,
                  }
                : null
            }
            warning={phoneRowWarning}
            extra={
              <>
                {packNote && (
                  <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="pack-note" title={packNote.why || undefined}>
                    {packNote.sentence}
                  </p>
                )}
                <OrderLineUnits item={item} />
                <OrderLineOffer item={item} />
              </>
            }
            working={phoneWorking}
            failure={
              aiWorking
                ? null
                : aiDowngraded
                  ? (() => {
                      // The way back is the contract's: retry when the AI can be
                      // asked again, connect when there is no provider to ask
                      // (a Retry on "no AI provider is connected" was a button
                      // that could only fail the same way).
                      const chip = fallbackChip(topCand?.ai_fallback ?? null, topCand?.ai_fallback_reason);
                      return { text: chip.text, recovery: chip.retry ? ("retry" as const) : chip.connect ? ("connect" as const) : null, connectHref: `/w/${activeSlug}/ai` };
                    })()
                  : matchFailed
                    ? { text: MATCH_FAILED_WORDS, recovery: "retry" as const }
                    : identifyFailed
                      ? namelessFix && { ...namelessFix, connectHref: `/w/${activeSlug}/ai` }
                      : null
            }
            quantity={
              receiptUnread
                ? null
                : restockMatch
                  ? { value: rowChange, busy: rowCount.isPending, onChange: (n) => setRowChange(Math.max(-rowHave, n)), signed: { floor: -rowHave } }
                  : { value: isOwnCopy(item.suggested_metadata) ? (item.quantity ?? 1) : Math.max(1, item.quantity ?? 1), busy: qtyPatch.isPending, onChange: (n) => qtyPatch.mutate(Math.max(1, n)) }
            }
            chips={chips}
            commit={
              !dest || item.status !== "pending"
                ? null
                : {
                    kind:
                      rowState.action.kind === "add"
                        ? "add"
                        : rowState.action.kind === "install-add"
                          ? "install"
                          : rowState.action.kind === "merge"
                            ? "merge"
                            : rowState.action.kind === "blocked" && rowState.ask?.length
                              ? "ask"
                              : "review",
                    label: restockMatch ? scanCountVerb("change", rowChange, rowHave, rowAmount.amount, rowAmount.measured) : rowState.action.label,
                    destination: restockMatch ? `${restockMatch.title}: ${rowAmount.amount(rowHave)} → ${rowAmount.amount(scanCountResult("change", rowHave, rowChange))}` : updating ? `${updating.title} in ${dest.label}` : dest.label,
                    tentative: tentativeRoute && !updating,
                    reason: rowState.sentence ?? rowState.action.title,
                    busy: commitBusy || askToFile.isPending,
                    onAdd: restockMatch ? () => rowCount.mutate({ mode: "change", value: rowChange }) : rowState.action.kind === "blocked" ? () => askToFile.mutate() : runCommit,
                    options: destOptions.map((c) => ({
                      key: entryKey(c.module, c.instance),
                      label: c.label,
                      installs: !!c.bundle_external_id,
                      selected: entryKey(c.module, c.instance) === entryKey(dest.module, dest.instance),
                    })),
                    onPick: (k) => pickDestination.mutate(k),
                    better: staleHint ? { label: staleHint.label, onPick: () => pickDestination.mutate(entryKey(staleHint.entry.module, staleHint.entry.instance)) } : null,
                  }
            }
            multi={multiItem ? { distinct: multiItem.distinct ?? multiItem.individuals.length, onSplit: () => split.mutate(), onKeep: () => keepGrouped.mutate(), busy: split.isPending || keepGrouped.isPending } : null}
            tracked={
              alreadyTracked && trackedMatch?.title
                ? rowState.merge
                  ? `You already have: ${trackedMatch.title}`
                  : `Possible match: ${trackedMatch.title}`
                : null
            }
            rerun={{ running: aiWorking, replaying: replayNoAi, failed: !aiWorking && (matchFailed || namelessFix?.recovery === "retry" || aiDowngraded), can: canRerunLookup(item), onRun: () => rerun.mutate(undefined) }}
            onCapture={() => setCaptureSheet("add")}
            more={more}
            toolHints={item.tool_hints}
            selection={onToggleSelect ? { active: !!selectionActive, selected: !!selected, onToggle: onToggleSelect } : null}
            onOpen={() => onOpenSheet?.(dest)}
          />
        {overlays}
        {lightbox}
      </>
    );
  }

  return (
    <div
      className={
        sheet
          ? "bg-surface dark:bg-slate-900"
          : "rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 overflow-hidden"
      }
    >
      {/* ── collapsed header row (click = expand) ───────────────────── */}
      <div
        className="flex items-stretch cursor-pointer"
        onClick={() => (planContext && onCollapse ? onCollapse() : expanded ? setExpanded(false) : expandOnly())}
      >
        {/* Photo column: a CONSISTENT WIDTH (so every card's text starts at the
            same x), stretched to the row's full height — a book cover / product
            shot reads far better big. Wider now (the select checkbox moved ONTO
            it as a top-left overlay, freeing its old column), and object-CONTAIN
            so a tall bottle/tub shows in full instead of a cropped centre strip.
            min-h keeps a short card's image sensible.

            max-h BOUNDS IT. `h-full` inside a column with no determinate height
            falls back to the image's intrinsic size, so the picture decided how
            tall the row was: a spice grinder shot at roughly 1:3, drawn 112px
            wide, made a 336px card holding one line of text and a strip of
            empty space (reported 2026-08-14 - "the aspect ratio of the image
            makes the box too tall, and this is a bad use of screen real
            estate"). object-contain still shows the whole product; it is simply
            no longer allowed to set the card's height. The cap is 128px
            since the tools left the side rail (#3009): a portrait shot is
            still shown whole and recognisable at that height, and a quiet
            row is no taller than its picture asks. */}
        <div className="relative w-24 sm:w-28 shrink-0 self-stretch min-h-[4.5rem] max-h-32 rounded-l-xl border-r border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 flex items-center justify-center overflow-hidden">
          {/* EAGER, not lazy: an EXTERNAL catalog URL (a user-picked web/dealer
              photo) with loading="lazy" stayed unloaded on the closed card. The
              intersection observer saw the card at 0-height on first render and
              never re-checked, so it looked broken until opening the accordion
              forced a reflow. Internal thumbs are blob URLs (load instantly), so
              only external ones showed the bug. */}
          <EntityPhoto
            src={thumb}
            alt={item.suggested_name ?? item.barcode_text ?? ""}
            fill
            fit="contain"
            eager
            className="!bg-transparent"
            placeholder={unsavedNote ?? <ScanLine size={26} className="text-faint dark:text-slate-600" />}
            onBroken={() => markBroken(catalogImg ? catalogUrl : yoursRawUrl)}
          />
          {onToggleSelect && (
            <div
              className="absolute top-1 left-1 rounded bg-white/85 dark:bg-slate-900/75 p-0.5 shadow-sm"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={!!selected}
                onChange={onToggleSelect}
                aria-label="Select for bulk action"
                className="h-4 w-4 accent-cobble-600 cursor-pointer block"
              />
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0 p-3">
          {/* The scan usually KNOWS the name before the matchmaker finishes —
              never replace a known title with a status line. Status renders as
              a subtle chip beside it; the pulse only owns the title slot when
              there's genuinely nothing to show yet. */}
          {/* Title and subtitle share ONE flex row that wraps. A short name with a
              short subtitle ("Baby Carrots" / "from Lidl") then reads as one
              line instead of spending two on eleven characters, and a long name
              or a busy subtitle still gets its own line — the wrap decides,
              rather than a width guess that is wrong on somebody's phone. */}
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
          <div className="font-medium text-content dark:text-mortar-100 flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
            {shownName ? (
              <>
                {/* The closed card shows the name a person scans for: the
                    lead of a long marketing title (brand, type, the model
                    that tells it from its sibling), the full name as the
                    tooltip and on the open card. The stored name is not
                    touched (#3009, displayIdentity). A tap on the title
                    edits it in place; a tap elsewhere opens the card (#2982). */}
                <ScanTitleInPlace
                  name={shownName}
                  shown={expanded ? shownName : identity.lead}
                  dataLead={!expanded && !!identity.rest}
                  title={!expanded && identity.rest ? shownName : undefined}
                  canEdit={item.status === "pending" && !renameTitle.isPending}
                  onSave={(next) => renameTitle.mutate(next)}
                  // No max-w-full here: beside the hover pill's negative margin
                  // it resolved against a container sized from the title itself
                  // and clamped the title under its own word width ("Kugelho /
                  // pf", #3086). The flex column shrinks it when it must.
                  className="break-words min-w-0"
                />
                {modelName && item.status === "pending" && (
                  <span data-testid="model-name" className="text-xs font-normal text-muted dark:text-slate-400 min-w-0 break-words">
                    AI read &ldquo;{modelName}&rdquo;{" "}
                    <button
                      type="button"
                      disabled={renameTitle.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        renameTitle.mutate(modelName);
                      }}
                      className="font-medium underline underline-offset-2 hover:text-content dark:hover:text-mortar-100"
                    >
                      Use it
                    </button>
                  </span>
                )}
                {rerunning || serverMatching ? (
                  <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-cobble-300 dark:border-cobble-700 bg-cobble-50 dark:bg-cobble-900/30 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-accent animate-pulse">
                    {replayNoAi ? "replaying" : rerunning ? "re-running" : "AI reading…"}
                  </span>
                ) : matchFailed ? (
                  <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/30 px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest text-amber-700 dark:text-amber-300">
                    matching failed
                    <button
                      type="button"
                      onClick={() => rerun.mutate({})}
                      className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100 transition"
                    >
                      retry
                    </button>
                  </span>
                ) : null}
              </>
            ) : rerunning ? (
              <span className="text-accent animate-pulse">
                {replayNoAi ? "Re-applying the latest processing…" : "Re-running the lookup…"}
              </span>
            ) : serverMatching ? (
              <span className="text-accent animate-pulse">
                {replayNoAi ? "Re-applying the latest processing…" : "AI is reading the details…"}
              </span>
            ) : rlActive ? (
              <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                <Loader2 size={13} className="animate-spin shrink-0" />
                Rate-limited - retrying…
              </span>
            ) : readingReceipt ? (
              <span className="text-muted">That’s a receipt - reading its line items…</span>
            ) : cantIdentify && namelessWhy === "receipt-unread" && receiptBlock ? (
              <ScanReceiptUnread {...receiptBlock} compact />
            ) : cantIdentify ? (
              // What the card says without a name: the contract's words for
              // the reason the RECORD carries (scan-nameless.ts, #4933), never
              // a guessed cause. The button is the reason's way forward.
              <span className="text-muted" title={namelessWhy === "classified-code" ? classified?.title : undefined} data-testid={namelessWhy === "classified-code" ? "classified-code" : "nameless-line"} data-reason={namelessWhy}>
                {namelessSays.action === "identify-again" && (
                  <button type="button" className="underline hover:text-content" onClick={(e) => { e.stopPropagation(); rerun.mutate({}); }} disabled={rerun.isPending} data-testid="nameless-identify-again">
                    {namelessSays.actionLabel}
                  </button>
                )}
                {namelessSays.line}
                {namelessSays.action === "set-up-ai" && (
                  <>
                    {" ("}
                    <WorkspaceLink slug={activeSlug} to={`/ai`} className="underline hover:text-content" onClick={(e) => e.stopPropagation()}>
                      {namelessSays.actionLabel}
                    </WorkspaceLink>
                    {")"}
                  </>
                )}
                {namelessSays.action === "read-as-receipt" && (
                  <>
                    {" "}
                    <button type="button" className="underline hover:text-content" onClick={(e) => { e.stopPropagation(); asReceipt.mutate(); }} disabled={asReceipt.isPending} data-testid="nameless-read-as-receipt">
                      {namelessSays.actionLabel}
                    </button>
                    :
                  </>
                )}
                {namelessSays.action === "identify" && (
                  <>
                    {" "}
                    <button type="button" className="underline hover:text-content" onClick={(e) => { e.stopPropagation(); rerun.mutate({}); }} disabled={rerun.isPending} data-testid="nameless-identify">
                      {namelessSays.actionLabel}
                    </button>
                    :
                  </>
                )}
                {/* Why the label could not be read, by its class (#4933). */}
                {namelessWhy === "classified-code" && identifyFailure && (
                  <span className="block text-[11px] text-faint" data-testid="classified-code-why">
                    {identifyFailureWords(identifyFailure).sentence}
                  </span>
                )}
              </span>
            ) : awaitingFresh ? (
              <AwaitingLookupLine
                words={awaiting ?? { line: "Awaiting lookup…", offerWaysOut: false }}
                identifyAvailable={cardAiStatus ? aiReach(cardAiStatus).identify : undefined}
                onTryAgain={() => rerun.mutate({})}
                retrying={rerun.isPending}
                onNameIt={() => {
                  expandOnly();
                  later.after("focus-name", 50, focusName);
                }}
              />
            ) : (
              // Settled (matchmaker ran / a tentative table) but still nameless.
              <span className="text-muted">Name this {idNoun}:</span>
            )}
            {/* Sold by weight: the weight IS the quantity, and the $/lb is the
                number worth seeing next time. Not a count control - 4.14 lb of
                chicken breast is one package, and "x4" was recording four
                (2026-09-06). */}
            {typeof (item.suggested_metadata as { weight?: unknown } | null)?.weight === "number" && (
              <span
                className="shrink-0 inline-flex items-center rounded-full bg-cobble-600 text-white text-[11px] font-semibold px-2 py-0.5 tabular-nums"
                title="Sold by weight, as printed on the receipt"
              >
                {(item.suggested_metadata as { weight: number }).weight}{" "}
                {(item.suggested_metadata as { weight_unit?: string }).weight_unit ?? ""}
                {typeof (item.suggested_metadata as { unit_price?: unknown }).unit_price === "number" && (
                  <span className="ml-1 font-normal opacity-90">
                    · {formatStoredMoney((item.suggested_metadata as { unit_price: number }).unit_price, "amount")}/
                    {(item.suggested_metadata as { weight_unit?: string }).weight_unit ?? "unit"}
                  </span>
                )}
              </span>
            )}
            {/* The count is shown at every value, one included: a card that hid
                it until it passed one gave no way to raise it without opening
                the form (#4552). */}
            {!receiptUnread && typeof (item.suggested_metadata as { weight?: unknown } | null)?.weight !== "number" && (
              <NumberStepper
                className="shrink-0 inline-flex items-center rounded-full bg-cobble-600 text-white text-[11px] font-semibold overflow-hidden"
                value={item.quantity ?? 1}
                min={1}
                busy={qtyPatch.isPending}
                stopClicks
                label="Quantity"
                prefix="×"
                decreaseLabel="Decrease quantity"
                increaseLabel="Increase quantity"
                buttonClassName="px-1.5 py-0.5 hover:bg-cobble-700 disabled:opacity-50"
                inputClassName="w-7 bg-transparent px-0.5 text-center tabular-nums text-white"
                onChange={(n) => qtyPatch.mutate(n)}
              />
            )}
          </div>
          <div className="text-[11px] font-mono text-faint dark:text-slate-500 min-w-0 whitespace-normal break-words sm:truncate">
            {(() => {
              // Build the subtitle from the fields that are PRESENT and join them
              // with " · ". An absent field (a photo-identified book has no
              // barcode/ISBN) must not leave a dangling leading separator — that
              // reads as "something's missing here". Never a leading/trailing dot.
              const segs: ReactNode[] = [];
              // An agent's add (MCP or the chat's add_thing, #4472) waits here
              // for its person, so it is not mistaken for their scan. Said on
              // the card only when it differs from its session: the header
              // says it once for every card that shares it (#4581).
              const ownSource = cardSaysAddedBy(item, sessionSource?.addedBy ?? null);
              if (ownSource) segs.push(<span className="text-cobble-700 dark:text-cobble-300">{addedByCardWords(ownSource)}</span>);
              if (item.barcode_text) {
                // Say where it CAME FROM. Read-from-photo over an emailed
                // eBay receipt was simply untrue (reported 2026-08-31), and a
                // line stamped the old way still said it (#4581). One wording,
                // in platform-contract scan-source, which the server reads too.
                const codeNote = codeSourceNote(codeSourceOf(item), { emailed: !!sessionSource?.emailed });
                segs.push(
                  <>
                    {item.barcode_text}
                    {codeNote && <span className="text-amber-600 dark:text-amber-500"> ({codeNote})</span>}
                  </>,
                );
              }
              // A book's ISBN is its identifier — surface it up FRONT (like a
              // barcode) from the top match's `isbn` field, when there's no
              // scanned barcode. Dropped from the fill-chips below so it isn't
              // shown twice. (Hit-or-miss: only when the identify captured one.)
              const isbnKey = topCand ? Object.keys(topCand.fields).find((k) => /^isbn$/i.test(k)) : undefined;
              const isbn = isbnKey ? String(topCand!.fields[isbnKey] ?? "").trim() : "";
              if (isbn && !item.barcode_text) segs.push(<span>ISBN {isbn}</span>);
              // Creator (author/director/…) then publisher/brand — a book reads
              // "Laura Ingalls Wilder · Scholastic".
              const creator = creatorOf(item);
              const brand = item.suggested_manufacturer?.trim() || null;
              const cb = [creator, brand].filter((p, i, a): p is string => !!p && a.indexOf(p) === i);
              if (cb.length) segs.push(cb.join(" · "));
              // Where it was BOUGHT, for a line off a receipt. A receipt names
              // the shop and never the maker, so without this a line reads
              // "Croissant" with nothing to say which croissant. Deliberately
              // not written into the brand field: the shop is where you bought
              // it, and a tin of branded beans from the same receipt would then
              // claim the supermarket made it.
              const boughtFrom = (item.suggested_metadata as { receipt_vendor?: string } | null)?.receipt_vendor;
              if (!brand && boughtFrom?.trim()) segs.push(leadWords("from", boughtFrom));
              // WHO sold it, when the receipt named someone other than the shop -
              // a marketplace order has both, and they are different facts. Kept
              // by the parser since receipts shipped and shown nowhere until now.
              const soldBy = (item.suggested_metadata as { receipt_seller?: string } | null)?.receipt_seller;
              // A thing handed over is from someone, not sold: its strip says who.
              if (soldBy?.trim() && soldBy.trim() !== boughtFrom?.trim() && !readInboxOffer(item.suggested_metadata)) segs.push(leadWords("sold by", soldBy));
              if (item.suggested_sku) segs.push(item.suggested_sku);
              // Where it's being FILED — the bin set by "Set location" (bulk or
              // per-item). This is target_location_id, the authoritative
              // destination, and it's distinct from any AI-guessed location-ish
              // custom field (a bundle's `room`). Without showing it, using "Set
              // location" changed nothing visible on the card. Falls back to the
              // free-text scan_area stamped at scan time when no bin is set.
              const filedInto = item.target_location_id
                ? (cardLocs.data?.items ?? []).find((l) => l.id === item.target_location_id)
                : null;
              if (filedInto) segs.push(<span className="inline-block text-accent">📍 {filingLabel(filedInto)}</span>);
              else if (item.scan_area) segs.push(<span className="inline-block">📍 {item.scan_area}</span>);
              const ps = (item.suggested_metadata as { pack_size?: number } | null)?.pack_size;
              if (ps) segs.push(<span className="text-accent">{ps}-pack</span>);
              const bs = (item.suggested_metadata as { box_state?: string } | null)?.box_state;
              if (bs) segs.push(<span>📦 {bs === "empty-box" ? "empty box" : "in box"}</span>);
              if (combinedCount && item.status === "pending")
                segs.push(
                  <span className="text-accent">
                    ⧉ {countOf(combinedCount, "scan")} combined
                    <button
                      type="button"
                      data-testid="undo-combine"
                      onClick={(e) => {
                        e.stopPropagation();
                        uncombine.mutate();
                      }}
                      disabled={uncombine.isPending}
                      title="Put every scan this one absorbed back in the inbox, each with its own quantity."
                      className="ml-1.5 rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-content disabled:opacity-50"
                    >
                      {SCAN_UNDO_ACTIONS.undoCombine}
                    </button>
                  </span>,
                );
              if ((item.suggested_metadata as { split_from?: string } | null)?.split_from)
                segs.push(
                  <span className="text-accent">
                    ✂ from split
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        unsplit.mutate();
                      }}
                      disabled={unsplit.isPending}
                      title="Put the group photo back in the inbox as it was; every piece of this split goes to Recently deleted."
                      className="ml-1.5 rounded border border-line px-1.5 py-0.5 text-[10px] text-muted hover:text-content disabled:opacity-50"
                    >
                      {SCAN_UNDO_ACTIONS.undoSplit}
                    </button>
                  </span>,
                );
              // A piece still showing the whole group photo says so, with the
              // crop tool beside it (scan-triage.ts, scanSplitUncut; #3614).
              const uncut = splitUncut;
              if (uncut)
                segs.push(
                  <span data-testid="split-uncut" title={uncut.why} className="inline-flex flex-wrap items-center gap-1.5 text-amber-700 dark:text-amber-400">
                    {uncut.sentence}
                    <button
                      type="button"
                      data-testid="split-crop-it"
                      onClick={(e) => {
                        e.stopPropagation();
                        cropSplitPiece();
                      }}
                      className="rounded border border-amber-400/70 px-1.5 py-0.5 text-[10px] font-medium hover:bg-amber-50 dark:hover:bg-amber-950/30"
                    >
                      Crop it
                    </button>
                  </span>,
                );
              if (item.source_url) {
                let host = "";
                try {
                  host = new URL(item.source_url).hostname.replace(/^www\./, "");
                } catch {
                  /* not a URL */
                }
                if (host)
                  segs.push(
                    <a
                      href={item.source_url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="text-accent hover:underline"
                    >
                      {host} ↗
                    </a>,
                  );
              }
              return segs.map((s, i) => (
                <Fragment key={i}>
                  {i > 0 && " · "}
                  {s}
                </Fragment>
              ));
            })()}
          </div>
          </div>
          {/* Routine provenance ("Identified via go-upc.") no longer costs the
              closed card a line - it lives in the Source data box. This line is
              for a WARNING a triager must see, and it stays amber whether the
              card is open or closed (see scanNotesPlacement). */}
          {/* On the closed card a flagged row asks its question, with the
              answers a tap can give, in the amber slot: "Check weight class:
              Fingering (the name says 4 Ply) or Aran (the AI's read)". The
              pipeline's whole sentence is evidence, and reads in full on the
              open card and in the Source data box. */}
          {/* A hand-over is the card's first question, open or closed. */}
          <div className="mt-1" onClick={(e) => e.stopPropagation()}>
            {offerStrip}
          </div>
          {!expanded && cardQuestions.length > 0 && !!item.suggested_name && (
            <div className="mt-0.5 space-y-0.5" onClick={(e) => e.stopPropagation()} data-testid="review-questions">
              {cardQuestions.slice(0, 2).map((q) => (
                <div key={q.field ?? q.prompt} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-amber-700 dark:text-amber-400" title={q.because}>
                  <span className="font-medium">{questionPrompt(q)}{q.choices.length ? ":" : ""}</span>
                  {q.choices.length ? (
                    q.choices.map((c, i) => (
                      <span key={c.value} className="inline-flex items-center gap-1">
                        {i > 0 && <span className="text-faint">or</span>}
                        <button
                          type="button"
                          disabled={answerQuestion.isPending}
                          onClick={() => (q.field || q.names) && answerQuestion.mutate({ field: q.field, value: c.value, ...(q.names ? { names: true as const } : {}), ...(c.quantity ? { quantity: c.quantity } : {}) })}
                          className="rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 font-medium text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition disabled:opacity-50"
                          title={`Set ${q.field?.replace(/_/g, " ")} to ${c.value}: ${c.source}`}
                        >
                          {c.value}
                        </button>
                        <span className="text-faint">{c.source}</span>
                      </span>
                    ))
                  ) : (
                    <>
                      <span className="text-faint">{q.because}.</span>
                      {q.field && dest && (
                        <button type="button" onClick={() => openForm(dest)} className="underline decoration-dotted underline-offset-2 hover:text-accent">
                          Type it
                        </button>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          <SamePictureOffer slug={activeSlug} itemId={item.id} />
          {/* A pack the store could not take apart, an order line's units and
              the "Part of …?" offer (#5719, #5734): open or closed. */}
          {packNote && (
            <p className="text-xs mt-0.5 text-amber-700 dark:text-amber-300" data-testid="pack-note" title={packNote.why || undefined}>
              {packNote.sentence}
            </p>
          )}
          <OrderLineUnits item={item} />
          <OrderLineOffer item={item} />
          {notesPlacement.amber && (expanded || cardQuestions.length === 0 || !item.suggested_name) && !(aiDowngraded && !expanded) && !(cantIdentify && headingSaysItAll(namelessWhy)) && (
            <div className={`text-[11px] mt-0.5 text-amber-600 dark:text-amber-400 ${expanded ? "" : "line-clamp-1"}`} data-testid="amber-note">
              {notesPlacement.amberText}
            </div>
          )}
          {/* A named row flagged with no note of its own (a low score) still
              says why it offers Review, in the same amber, where the note would
              be. A nameless row says so in the name field's place instead. */}
          {flaggedForReview && !matchAsks && !notesPlacement.amber && !!item.suggested_name && reviewReason && (expanded || cardQuestions.length === 0) && !(aiDowngraded && !expanded) && (
            <div className={`text-[11px] mt-0.5 text-amber-600 dark:text-amber-400 ${expanded ? "" : "line-clamp-1"}`}>
              {reviewReason}
            </div>
          )}
          {/* A field that contradicts the receipt is never settled by the
              pipeline; the person settles it. One tap takes the receipt's
              word for it, as their answer; the chip stays editable for any
              other. */}
          {flaggedForReview && sourceConflict && (
            <button
              type="button"
              data-testid="use-evidence-source"
              onClick={(e) => {
                e.stopPropagation();
                useEvidenceSource.mutate();
              }}
              disabled={useEvidenceSource.isPending}
              className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-900/20 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition disabled:opacity-50"
              title={`Set ${topCand ? menuFieldLabel(menu, topCand, sourceConflict.field) : sourceConflict.field} to what the ${sourceConflict.from} says`}
            >
              <CheckCircle size={12} className="shrink-0" />
              Use {sourceConflict.evidence}
            </button>
          )}
          {/* One-tap accept the photo's identification when the cross-check read a
              real product off the label (and it differs from the current name). */}
          {photoSuggestedName && photoSuggestedName !== (item.suggested_name ?? "") && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                applyPhotoName.mutate();
              }}
              disabled={applyPhotoName.isPending}
              className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-amber-400/60 bg-amber-50 dark:bg-amber-900/20 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition disabled:opacity-50"
              title="Rename to what the photo shows - and report the barcode fix"
            >
              <Sparkles size={12} className="shrink-0" />
              Use photo’s name: “{photoSuggestedName}”
            </button>
          )}
          {/* The photo holds several DIFFERENT things. The observation pass (which
              every photo scan already pays for) counted them and named them, so
              ask the only question that matters — one record, or one each? — right
              here on the closed card. Buried in the open card it may as well not
              exist: nobody expands a card to discover a question they didn't know
              they had. */}
          {multiItem && (
            // One line, not a panel above the match (#3884): the question and
            // its two answers. Which items were seen is on hover and in the
            // split itself.
            <div
              onClick={(e) => e.stopPropagation()}
              data-testid="multi-item-line"
              title={multiItem.individuals.map((ind) => `${ind.name}${ind.qty > 1 ? ` ×${ind.qty}` : ""}`).join(" · ")}
              className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-content dark:text-mortar-100"
            >
              <Sparkles size={12} className="shrink-0 text-accent" />
              <span>
                <strong>{multiItem.distinct} different items</strong> here?
              </span>
              <button
                type="button"
                onClick={() => split.mutate()}
                disabled={split.isPending || keepGrouped.isPending}
                className="inline-flex items-center gap-1 rounded-full bg-cobble-600 px-2 py-0.5 font-medium text-white hover:bg-cobble-500 transition disabled:opacity-50"
              >
                <Scissors size={11} className="shrink-0" />
                {split.isPending ? "Splitting…" : `Split into ${multiItem.distinct} items`}
              </button>
              <button
                type="button"
                onClick={() => keepGrouped.mutate()}
                disabled={split.isPending || keepGrouped.isPending}
                className="rounded-full border border-line dark:border-slate-600 px-2 py-0.5 text-muted hover:text-content dark:hover:text-mortar-100 transition disabled:opacity-50"
              >
                Keep as one
              </button>
            </div>
          )}
          {/* Whatever OTHER modules declared into a scan item, rendered
              without this page learning who they are or what they say. The
              receipt-lines banner arrives through here; core-scan names no
              contributor and hands over only its own receipt group id as a
              hint, which is the contributor's to interpret. Same seam that
              puts price history on a part page without inventory naming
              purchases — see docs/architecture/module-coupling-census.md. */}
          {contributedPanels}
          {cantIdentify && <NameItInline slug={activeSlug} itemId={item.id} guess={nameGuess} />}
          {/* One-tap correction: a barcode whose name looks wrong (always
              available, nudged for low-trust short codes). Renaming reports the
              fix to the shared Barcode Intelligence DB so the next scan is right. */}
          {/* The standing "Not right? Fix the name" offer moved to the card's ⋯
              menu - a closed card's height should be its IMAGE's height, and an
              offer nobody has taken is not worth a line (same rule as the drive
              offer). Only the LOW-TRUST warning variant keeps its line, and the
              inline editor still appears right here once summoned. It is the
              amber warning's own action, so it goes wherever the warning goes -
              open or closed - rather than disappearing at the moment someone
              opened the card to act on it. */}
          {barcodeIdentified && correcting && (
            <CorrectNameInline
              slug={activeSlug}
              itemId={item.id}
              initial={item.suggested_name ?? ""}
              onDone={() => setCorrecting(false)}
            />
          )}
          {barcodeIdentified && !correcting && doubt !== null && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setCorrecting(true);
              }}
              className="mt-0.5 text-[11px] underline decoration-dotted underline-offset-2 text-amber-600 dark:text-amber-400"
              data-testid="double-check-link"
            >
              Double-check: fix the name
            </button>
          )}
          {/* "You already have one of these" — its OWN line, because the answer
              has to NAME the record. As an action segment on the route chip it
              read "Vehicles | Same one?", which can't say same as WHAT (reported
              2026-07-16). Sits above the chips so it's read before the routing,
              which is the right order: whether this is a duplicate decides
              whether the routing matters at all. Opens the card rather than
              merging on the spot — the banner in there shows what would be
              filled, and merging into something you own is a decision.
              Hidden once the card is open: the full banner takes over there,
              and the two together said "you already have" twice. */}
          {!planContext && alreadyTracked && !expanded && (
            <TrackedMatchLine
              item={item}
              fallbackTitle={trackedMatch!.title!}
              stamped={restockMatch}
              onCompare={() => (dest ? openForm(dest) : setExpanded(true))}
            />
          )}
          {/* ONE row for everything the card says about routing + fields:
              the SERIES tag, the routing chip(s) to file into, AND the field
              VALUES the top match fills. Keeping these on a single wrapping row
              (they were two stacked rows) stops the text strip growing taller
              than the cover image beside it. On phones only the TOP routing
              match shows + a "+N" to expand; desktop shows them all. Field chips
              skip anything already in the subtitle (author, publisher/brand,
              ISBN) so there's no echo. */}
          {!planContext && (seriesOf(item) || candidates.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              {seriesOf(item) && (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/5 px-2 py-0.5 text-[11px] font-medium text-accent min-w-0"
                  title={`Part of the "${seriesOf(item)}" series`}
                >
                  <Library size={11} className="shrink-0" />
                  <span className="truncate">{seriesOf(item)}</span>
                  <span className="opacity-60 shrink-0">series</span>
                </span>
              )}
              {/* ONE destination control. The route used to be a split chip
                  whose left half opened the form, with the OTHER candidates as
                  separate chips beside it - so the same commit was offered
                  three ways and the alternatives looked like different actions
                  rather than different answers to one question. Now: pick the
                  table, press Add. */}
              {dest && !countFiles && (
                // FIRST on the row, whatever else the item has. A series chip
                // rendered ahead of it on the one card that had one, so the pill
                // sat in a different place there than on every other card and
                // the eye had to hunt for it (reported 2026-08-20). `order-first`
                // rather than moving the markup: the series stays next to the
                // name it qualifies for a reader, and only the layout changes.
                // On a phone the content column is ~170px and the bundle
                // suggestion ("Groceries?") used to sit beside the pill INSIDE
                // this wrapper, so the destination name got 6px and read "I…"
                // (measured on the live inbox, 2026-09-01). The wrapper wraps
                // there, the suggestion takes the next line, the verb drops
                // "& add", and the name keeps a floor. The walk asserts it.
                // The pill WRAPS rather than squeezes (#3705): the table's name
                // keeps a floor, and when the name at its floor and the verb do
                // not fit one line the verb takes a line of its own inside the
                // pill. Squeezed, the name went to 16px under the verb and the
                // restock choice ran past the card at 320px. The radius is a
                // length, not "full", so a two-line pill is a rounded block
                // rather than a lozenge. e2e/scan-card-never-clips.mjs walks it.
                <span data-dest-pill="" className="relative inline-flex max-w-full order-first flex-wrap items-center gap-1 max-sm:w-full">
                <span
                  className={
                    tentativeRoute
                      ? "inline-flex max-w-full max-sm:w-full flex-wrap items-stretch rounded-[0.875rem] overflow-hidden border border-dashed border-cobble-500 text-content dark:text-mortar-100 text-xs font-medium"
                      : "inline-flex max-w-full max-sm:w-full flex-wrap items-stretch rounded-[0.875rem] overflow-hidden border border-cobble-600 bg-cobble-600 text-white text-xs font-medium"
                  }
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* A native <select> paints the OS popup ON TOP of the pill,
                      covering the thing you are choosing. This is our own menu,
                      anchored under it. */}
                  {/* max-sm:flex-1 - on a phone the pill is full-width and this
                      region absorbs the slack, so the table's NAME gets the room
                      ("Home Invento…" at 61px of 91, second census 2026-08-30)
                      and Add sits flush right. */}
                  {/* Sized to its label (basis-auto), cut only when the row is
                      really full: a fixed 5rem basis sized the pill to 5rem
                      whatever the room, and the owner read "3D Printe… ▾" on
                      a desk card with half the row empty (#3884). The 5rem
                      stays as the floor. e2e/scan-card-never-clips.mjs holds
                      it: a name cut with room beside it fails. */}
                  <span className="relative inline-flex min-w-[5rem] max-w-full grow basis-auto items-center">
                    <button
                      type="button"
                      ref={destBtnRef}
                      onClick={(e) => {
                        e.stopPropagation();
                        destOpen ? closeDest() : openDest();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" && destOpen) closeDest();
                      }}
                      title={updating ? `Adds to ${updating.title}, which you already have in ${dest.label}. Pick another table to file it as a new item there instead.` : "Which table this gets filed into"}
                      aria-haspopup="listbox"
                      aria-expanded={destOpen}
                      className={
                        "inline-flex w-full min-w-0 items-center gap-1 pl-2.5 max-sm:pl-2 pr-2 py-1 transition " +
                        (tentativeRoute ? "hover:bg-cobble-600/10" : "hover:bg-cobble-700")
                      }
                    >
                      <Sparkles size={11} className="shrink-0 max-sm:hidden" />
                      <span className="min-w-0 truncate" data-testid="dest-pill-label">
                        {updating ? `${updating.title} in ${dest.label}` : dest.label}
                        {tentativeRoute && !updating ? "?" : ""}
                      </span>
                      {destOptions.length > 1 && <ChevronDown size={11} className="shrink-0 opacity-80 max-sm:hidden" />}
                    </button>
                  </span>
                  <ScanCardCommit
                    state={rowState}
                    busy={commitBusy || askToFile.isPending}
                    onAdd={runCommit}
                    onReview={() => (rowState.action.kind === "blocked" && rowState.ask?.length ? askToFile.mutate() : openForm(dest))}
                  />
                </span>
                {/* The route was answered against the workspace as it was. A table
                    that has appeared since is offered, never applied: a route you
                    can see and ignore costs a glance, one that moves under you
                    costs your trust. */}
                {staleHint && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      pickDestination.mutate(entryKey(staleHint.entry.module, staleHint.entry.instance));
                    }}
                    className="ml-1.5 max-sm:ml-0 max-sm:mt-1 max-sm:basis-full shrink-0 inline-flex items-center gap-1 rounded-full border border-ember-300 dark:border-ember-700 bg-ember-50 dark:bg-ember-950/30 px-2 py-0.5 text-[11px] text-ember-700 dark:text-ember-300 hover:bg-ember-100 dark:hover:bg-ember-900/40 transition"
                    aria-label={`Could also go in ${staleHint.label}`}
                    title={staleHint.back ? `Could also go in ${staleHint.label}. This scan was first routed there; tap to switch back.` : `Could also go in ${staleHint.label}, which was set up after this scan was routed. Tap to switch.`}
                  >
                    or {staleHint.label}?
                  </button>
                )}
                    {destOpen && destRect && createPortal(
                      <>
                        {/* click anywhere else to dismiss */}
                        <BackdropLayer className="z-[60]" onClick={(e) => { e.stopPropagation(); closeDest(); }} />
                        <PopoverLayer
                          role="listbox"
                          style={{ top: destRect.top, left: destRect.left }}
                          flipAbove={destRect.above}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.stopPropagation();
                              closeDest();
                              return;
                            }
                            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                            e.preventDefault();
                            const opts = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
                            const at = opts.indexOf(document.activeElement as HTMLButtonElement);
                            const next = e.key === "ArrowDown" ? Math.min(at + 1, opts.length - 1) : Math.max(at - 1, 0);
                            opts[next]?.focus();
                          }}
                          className="z-[61] min-w-[13rem] max-w-[18rem] rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg py-1 flex flex-col"
                        >
                          {updating && (
                            <p className="px-2.5 pt-1 pb-1.5 text-[11px] leading-snug text-muted border-b border-line dark:border-slate-700 mb-1">
                              Adds to {updating.title} in {dest.label}. Pick another table to file this as a new item there.
                            </p>
                          )}
                          {destOptions.map((c) => {
                            const k = entryKey(c.module, c.instance);
                            const on = k === entryKey(dest.module, dest.instance);
                            return (
                              <button
                                key={k}
                                type="button"
                                role="option"
                                aria-selected={on}
                                autoFocus={on}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  pickDestination.mutate(k);
                                  closeDest();
                                }}
                                className={
                                  "flex items-center gap-2 px-2.5 py-1.5 text-left text-xs transition " +
                                  (on
                                    ? "text-accent font-medium bg-subtle/60 dark:bg-slate-800/60"
                                    : "text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800")
                                }
                              >
                                <CheckCircle size={11} className={on ? "shrink-0" : "shrink-0 opacity-0"} />
                                <span className="min-w-0 truncate">
                                  {c.label}
                                  {c.bundle_external_id ? " · installs on add" : ""}
                                </span>
                              </button>
                            );
                          })}
                        </PopoverLayer>
                      </>,
                      document.body,
                    )}
                </span>
              )}
              {/* The editable chips land here while the form is open, in the
                  SAME row as the destination pill - so the fields sit with the
                  thing they are fields of. */}
              {formOpen && <span ref={setFieldSlot} className="contents" />}
              {candidates.length > 1 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExpanded(true);
                  }}
                  title="See the other matches"
                  className="sm:hidden inline-flex items-center rounded-full px-2 py-1 text-xs font-medium border border-line dark:border-slate-700 text-muted dark:text-slate-400 hover:border-cobble-400 shrink-0"
                >
                  +{candidates.length - 1}
                </button>
              )}
              {/* …and the field VALUES the row's DESTINATION fills — inline on
                  the SAME row, wrapping only if the row runs out of width. The
                  destination, not the top match: a toy sent to Inventory drew
                  Groceries' fields here while its pill said Inventory. */}
              {dest &&
                (() => {
                  const brand = (item.suggested_manufacturer ?? "").trim().toLowerCase();
                  const creator = (creatorOf(item) ?? "").trim().toLowerCase();
                  // Against the destination's CURRENT fields. A match is a
                  // snapshot, and a scan can sit here across a bundle upgrade
                  // that retires a field - see scanCandidateFields.ts.
                  const liveFields = fieldsStillOnTable(
                    (menu ?? []).find((m) => m.module === dest.module && (m.instance ?? null) === (dest.instance ?? null)),
                    dest.fields,
                  );
                  // Never the same value twice on one card (#3077): the
                  // contract's compactCardFields drops what the title line
                  // and the subtitle already print (an ISBN, the brand, the
                  // creator); the scan's own "not news" rules stay on top.
                  const entries: Array<[string, unknown]> = compactCardFields(
                    Object.entries(liveFields)
                      .filter(([k, v]) => {
                        if (isQuietDefault(k, v)) return false; // "kept ambient" is not news
                        if (isImpliedByPeer(k, v, liveFields)) return false; // "Storage Fridge" already says it
                        return !isStatedByReceipt(k, v, item.suggested_metadata as { receipt_date?: unknown; receipt_vendor?: unknown } | null); // the session header says it
                      })
                      .map(([k, v]) => ({ name: k, label: menuFieldLabel(menu, dest, k), value: v })),
                    [shownName, item.barcode_text, brand, creator],
                  ).map((f) => [f.name, f.value]);
                  // A table that keeps its own categories (inventory's tree)
                  // has no field for the category, so no field chip shows it.
                  // It is still the first thing the card should say (#3223).
                  const byNameAxis = categoryTravelsByName(menu, dest) ? tableCategoryAxis(menu, dest) : null;
                  const byNameCategory = byNameAxis && dest.category ? dest.category : null;
                  if (entries.length === 0 && !byNameCategory) return null;
                  // The row wraps, so let it breathe: cap only a genuinely long
                  // tail, and never render "+1" — that summary chip costs as
                  // much width as the field chip it hides (reported 2026-07-18).
                  const MAX = 6;
                  const shown = entries.length <= MAX + 1 ? entries : entries.slice(0, MAX);
                  const extra = entries.length - shown.length;
                  // The category chip shows the SAME label the session header
                  // does. Which field is the category comes from the table's
                  // declared axis, not from spotting a field whose value equals
                  // the candidate's category - that guess missed whenever the two
                  // had drifted, which is exactly when it mattered.
                  const axisKey = declaredCategoryAxis(menu, dest);
                  // What the row is NOT showing: the filled fields past the cap,
                  // plus every field this table declares that came back empty.
                  // Both are "more fields live in here", so they count as one
                  // affordance rather than two competing "+N" chips.
                  const unfilled = unfilledFieldLabels(menu, dest);
                  // What the scan read that this table no longer has. Counted
                  // with the rest rather than vanished: the value is still on
                  // the row, and saying so is the difference between "we
                  // dropped it" and "it disappeared".
                  const retired = fieldsNoLongerOnTable(
                    (menu ?? []).find((m) => m.module === dest.module && (m.instance ?? null) === (dest.instance ?? null)),
                    dest.fields,
                  );
                  const more = extra + unfilled.length + retired.length;
                  const moreTitle = [
                    ...entries.slice(shown.length).map(([k, v]) => `${menuFieldLabel(menu, dest, k)}: ${v}`),
                    ...unfilled.map((l) => `${l}: empty`),
                    ...retired.map((k) => `${k}: read by the scan, but this table no longer has that field`),
                  ].join(", ");
                  return (
                    <>
                      {/* A value the scan got wrong is a value you have to be
                          able to correct, and reading it while the only way to
                          change it is a separate summon is its own annoyance
                          ("Acquired from Facebook Marketplace is great! but
                          it's a field that I still need to be able to edit").
                          The chip stays a chip and gains the obvious gesture:
                          tap the value to open the form on this route with the
                          fields pre-filled. */}
                      {/* WHERE IT IS GOING, on the closed card. The suggestion
                          was stamped on every line of a receipt and shown on
                          none of them - it lived in the expanded view, and the
                          header said "Location" in amber over twelve items that
                          all had one (2026-09-06). */}
                      {!formOpen && suggested && !item.target_location_id && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            acceptSuggestedLocation.mutate();
                          }}
                          disabled={acceptSuggestedLocation.isPending}
                          className="inline-flex items-center gap-1 rounded-md bg-moss-500/10 border border-moss-500/30 px-1.5 py-0.5 text-[11px] text-moss-700 dark:text-moss-400 min-w-0 hover:border-moss-500 transition disabled:opacity-50"
                          title={`${item.suggested_location_note ?? "Suggested spot"} - Add and File all put it here; tap to set it now`}
                        >
                          <MapPin size={11} className="shrink-0" />
                          <span className="truncate">
                            {suggested.place}
                            {/* Why, in the card's own words (#4933). */}
                            <span className="text-moss-700/80 dark:text-moss-400/80"> · {suggested.why}</span>
                          </span>
                        </button>
                      )}
                      {!formOpen && noPictureFound && !unsaved && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            rerun.mutate({ enrich: true });
                          }}
                          disabled={rerun.isPending}
                          className="inline-flex items-center gap-1 rounded-md border border-dashed border-line/70 dark:border-slate-700/70 px-1.5 py-0.5 text-[11px] text-faint hover:text-accent hover:border-accent transition disabled:opacity-50"
                          title={pictureBusy ? "The picture search is busy right now - it will try again on its own, or tap to try now." : "The picture search came back empty. Try again."}
                        >
                          <ImagePlus size={11} className="shrink-0" /> {pictureBusy ? "Picture search busy · retry" : "No picture found · retry"}
                        </button>
                      )}
                      {!formOpen && byNameAxis && byNameCategory && (
                        <button
                          type="button"
                          data-category-chip
                          onClick={(e) => {
                            e.stopPropagation();
                            openForm(dest);
                          }}
                          className="inline-flex items-center gap-1 rounded-md bg-subtle/60 dark:bg-slate-800/60 border border-line/70 dark:border-slate-700/70 px-1.5 py-0.5 text-[11px] text-content dark:text-mortar-200 min-w-0 hover:border-cobble-400 dark:hover:border-cobble-600 transition"
                          title={`${byNameAxis.label}: ${categoryChipLabel(byNameCategory, sessionCategoryLabel)} (tap to edit)`}
                        >
                          <span className="text-faint shrink-0">{byNameAxis.label}</span>
                          <span className="truncate">{categoryChipLabel(byNameCategory, sessionCategoryLabel)}</span>
                        </button>
                      )}
                      {!formOpen && shown.map(([k, v]) => (
                        <button
                          key={k}
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openForm(dest);
                          }}
                          className="inline-flex items-center gap-1 rounded-md bg-subtle/60 dark:bg-slate-800/60 border border-line/70 dark:border-slate-700/70 px-1.5 py-0.5 text-[11px] text-content dark:text-mortar-200 min-w-0 hover:border-cobble-400 dark:hover:border-cobble-600 transition"
                          title={`${menuFieldLabel(menu, dest, k)}: ${String(v)} (tap to edit)`}
                        >
                          <span className="text-faint shrink-0">{menuFieldLabel(menu, dest, k)}</span>
                          {/* A colour is shown as itself: a swatch beside the
                              field's word, the hex only in the title (a card
                              printed "Color #E0E0E0" where the phone showed a
                              dot; #3009). A named colour keeps its name. */}
                          {(() => {
                            const sw = /colou?r/i.test(k) ? colorSwatch(v) : null;
                            const isHex = /^#?[0-9a-fA-F]{6}$/.test(String(v).trim());
                            return sw ? (
                              <>
                                <span data-swatch className="inline-block h-3 w-3 shrink-0 rounded-full border border-black/20 dark:border-white/20" style={{ backgroundColor: sw }} />
                                {!isHex && <span className="truncate">{String(v)}</span>}
                              </>
                            ) : (
                              <span className="truncate">
                                {k === axisKey || (dest.category && v === dest.category)
                                  ? categoryChipLabel(String(v), sessionCategoryLabel)
                                  : String(v)}
                                {whoFromBeside(dest.fields, k)}
                              </span>
                            );
                          })()}
                        </button>
                      ))}
                      {/* "+N more fields" said nothing anyone could act on
                          ("no one knows that's what it means so as far as they
                          know they can't edit or see anything") and the number
                          was wrong besides: unfilledFieldLabels returns [] when
                          the menu has not loaded, so it collapsed to the chip
                          overflow — "+1" on a table with six hidden fields.
                          The count is gone. This says what it opens, which is a
                          form that now lists every field by name. */}
                      {!formOpen && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openForm(dest);
                          }}
                          className="text-[11px] text-faint shrink-0 px-1 underline decoration-dotted underline-offset-2 hover:text-accent transition"
                          title={more > 0 ? moreTitle : "Open every field for this item"}
                        >
                          All fields
                        </button>
                      )}
                    </>
                  );
                })()}
            </div>
          )}
          {/* The workspace has AI but this match came from the keyword floor —
              the model call failed and the code fell back. Silent downgrade is
              how a lexical guess ends up looking settled; say it, offer the
              retry (scan-inbox-ux-review.md F4). */}
          {aiDowngraded && !planContext && (
            <div
              className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-amber-700 dark:text-amber-400"
              onClick={(e) => e.stopPropagation()}
            >
              <Sparkles size={11} className="shrink-0" />
              <span>
                {fallbackChip(topCand?.ai_fallback ?? null, topCand?.ai_fallback_reason).text}
                {/* The consequence, in the row's own terms: the name is the
                    receipt's or the code's and still files; what is missing
                    is the read (the table's fields, a picture). */}
                {dest && !expanded && <span className="text-amber-600/80 dark:text-amber-400/80"> Files into {dest.label} with nothing read.</span>}
              </span>
              {fallbackChip(topCand?.ai_fallback ?? null, topCand?.ai_fallback_reason).retry && (
                <button
                  type="button"
                  onClick={() => rerun.mutate(undefined)}
                  disabled={aiWorking || !canRerunLookup(item)}
                  className="underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200 disabled:opacity-50"
                >
                  Retry with AI
                </button>
              )}
            </div>
          )}
          {/* A scanned storage tote is usually about to BECOME a bin — offer the
              one-shot right on the closed card (buried in a menu it may as well
              not exist for the flow it exists for). */}
          {containerish && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
              <span className="inline-flex items-center gap-1.5 text-muted dark:text-slate-400">
                📦 Looks like a storage container.
              </span>
              <button
                type="button"
                onClick={() => setMakeBinOpen(true)}
                className="inline-flex items-center gap-1 rounded-full border border-cobble-400 dark:border-cobble-600 px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-cobble-50 dark:hover:bg-cobble-900/30 transition"
              >
                Turn into a bin
              </button>
            </div>
          )}
          {candidates.length === 0 && serverMatching && (
            <div className="text-[11px] text-faint italic mt-1">finding the best table…</div>
          )}
          {/* The top match is a bundle you don't have (a scanned VIN → Vehicles).
              Installing + filing lives in the destination pill above, which is
              where every other commit already lives — this used to be a SECOND
              brown button running the identical mutation, which meant the pill
              beside it had to offer "Review" instead of committing, and the real
              action sat outside the control that names the destination.
              What remains is the quiet way in: adjust the fields first. */}
        </div>
        {/* The tools are ONE column at the card's top right: camera, ⋯,
            re-run, discard, expand. They were a row for a day (#3009) and the
            owner asked for the column back (#3086). The column is top-aligned
            and never stretches the card (it once did, to about 150px, which
            is why the row was tried), so a quiet row is still no taller than
            its 128px picture: five 22px buttons and their gaps. */}
        {/* THE one image control on a closed card. Everything rarer (retake for
            catalog, another angle, split) stays in the ⋯ menu beside it.
            One button, one sentence: "I'll photograph this." The only thing
            that varies is now or later, and the DEVICE answers that (see
            lib/photoDevice.ts) rather than a setting or a menu - so the button
            means the same thing on every machine and needs no explaining.

            `self-start`, not centred in the rail: the rail is deliberately
            spread over the card's height, and a control that moves depending on
            how tall a card happens to be is a control you have to look for. Top
            of the card is the title's first line, and it stays there when a long
            title wraps to two - which is the case that would otherwise push it
            somewhere different on every row. */}
        <div data-testid="tool-rail" className="flex flex-col items-center shrink-0 self-start gap-0.5 pt-1.5 pr-1" onClick={(e) => e.stopPropagation()}>
        {item.status === "pending" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const act = photoPressAction(measureDevice(), photoWanted);
              // "I'll photograph this" is EVIDENCE about the object, so the
              // capture goes through the add-photo door (the server identifies
              // an unnamed item from it, cross-checks a named one). It used to
              // open the RETAKE sheet, which only swaps the display photo -
              // "did not trigger an AI rerun to get info from the new image"
              // (reported 2026-08-30).
              if (act === "capture") setCaptureSheet("add");
              else setPhotoWanted.mutate(act === "mark");
            }}
            disabled={setPhotoWanted.isPending}
            aria-pressed={photoWanted}
            title={
              photoWanted
                ? "Waiting for your photo - tap to clear"
                : "I'll photograph this myself"
            }
            className={`relative shrink-0 rounded-lg border p-1 transition disabled:opacity-50 ${
              photoWanted
                ? "border-cobble-400 bg-cobble-500/20 text-cobble-200"
                : "border-transparent text-faint hover:border-line hover:text-accent"
            }`}
          >
            <Camera size={14} />
            {photoWanted && (
              <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-amber-400" />
            )}
          </button>
        )}
        <div className="contents">
          {/* The item's rare tools. They lived under the photos, where the row
              they needed cost more vertical space than the controls were worth
              (reported 2026-08-11). The rail is where this card's other verbs
              already are, and putting them here makes them reachable without
              expanding at all. */}
          <HeaderMenu
            width={252}
            align="right"
            trigger={({ open, toggle }) => (
              <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                aria-label="More item tools"
                title="More item tools: split, retake, box state, turn into a bin"
                className="text-faint hover:text-accent p-1"
              >
                <MoreHorizontal size={14} />
              </button>
            )}
          >
              {({ close }) => (
                <ScanToolMenu
                  hints={item.tool_hints}
                  pending={item.status === "pending"}
                  hasPicture={!!item.image_file_id}
                  hasLocations={hasLocations}
                  boxState={boxState}
                  busy={{ split: split.isPending, receipt: asReceipt.isPending, boxState: setBoxState.isPending }}
                  onSplit={() => {
                    close();
                    split.mutate();
                  }}
                  onReceipt={() => {
                    close();
                    asReceipt.mutate();
                  }}
                  onMakeBin={() => {
                    close();
                    setMakeBinOpen(true);
                  }}
                  onBoxState={(next) => {
                    close();
                    setBoxState.mutate(next);
                  }}
                >
                  <MenuItem
                    icon={<Camera size={14} />}
                    label={retakeCatalog.isPending ? "Uploading…" : "Retake for catalog"}
                    hint="A nice shot becomes the display photo"
                    disabled={retakeCatalog.isPending}
                    onClick={() => {
                      close();
                      setCaptureSheet("retake");
                    }}
                  />
                  {/* The strip's add-tile only exists once there ARE extras, so
                      the first photo has to be addable from here. */}
                  <MenuItem
                    icon={<ImageIcon size={14} />}
                    label={addPhoto.isPending ? "Uploading…" : "Add a photo"}
                    hint="Another angle or the label, for a better read"
                    disabled={addPhoto.isPending}
                    onClick={() => {
                      close();
                      setCaptureSheet("add");
                    }}
                  />
                  {barcodeIdentified && item.status === "pending" && (
                    <MenuItem
                      icon={<Pencil size={14} />}
                      label="Fix the name…"
                      hint="Wrong product? Renaming also teaches the barcode database"
                      onClick={() => {
                        close();
                        setCorrecting(true);
                      }}
                    />
                  )}
                </ScanToolMenu>
              )}
          </HeaderMenu>
          <button
            aria-label={replayNoAi ? "Replaying…" : aiWorking ? "AI is working…" : "Rerun lookup"}
            type="button"
            onClick={() => rerun.mutate(undefined)}
            // Re-run needs SOMETHING to look up again — a barcode, a photo, OR a
            // name (a receipt/note line has only a name; re-running re-does the
            // web/text lookup and can finally fetch a product image). See
            // canRerunLookup — gating on barcode||image alone greyed out receipts.
            disabled={aiWorking || !canRerunLookup(item)}
            className="text-faint hover:text-accent p-1 disabled:opacity-30"
            title={replayNoAi ? "Replaying…" : aiWorking ? "AI is working…" : "Rerun lookup"}
          >
            <RotateCcw size={14} className={aiWorking ? "animate-spin text-accent" : ""} />
          </button>
          {!planContext && (
            <button
              aria-label="Discard (recoverable from Recently deleted)"
              type="button"
              onClick={() => discard.mutate()}
              disabled={discard.isPending}
              className="text-faint hover:text-ember-500 p-1 disabled:opacity-30"
              title="Discard (recoverable from Recently deleted)"
            >
              <X size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={() => (planContext && onCollapse ? onCollapse() : expanded ? setExpanded(false) : expandOnly())}
            aria-label={expanded ? "Collapse" : "Expand"}
            aria-expanded={expanded}
            title={expanded ? "Collapse" : "Expand the details"}
            className="text-faint hover:text-accent p-1"
          >
            <ChevronDown
              size={16}
              className={`transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        </div>
        </div>
      </div>

      {overlays}
      {/* The seam: the bottom edge of the closed strip. A control opened from a
          chip in that strip belongs here, against the line, not at the far end
          of the card. Empty until something opens. */}
      <div ref={setLocSlot} className="empty:hidden" />
      {/* ── expanded triage surface — photos left, intel right (lg+) ── */}
      {expanded && (
        <div className="border-t border-line dark:border-slate-800 p-3 space-y-3 bg-subtle/40 dark:bg-slate-950/40">
          {/* "Already tracked" — attach to the existing entity
              instead of creating a duplicate. Lazy: only queried on expand. */}
          {item.status === "pending" && (
            <TrackedMatchBanner item={item} locationId={item.target_location_id} stamped={restockMatch} />
          )}
          <div className="grid lg:grid-cols-2 gap-3 items-stretch">
          <div className="space-y-2 min-w-0 flex flex-col">
          {/* Catalog vs YOUR photo, side by side (whichever exist). The catalog
              caption says when it is still being checked — it used to read a
              confident "✦ catalog" during the exact window the thumbnail above
              deliberately refuses to show it. */}
          {(catalogImg || yoursImg) && (
            <div className="flex gap-2">
              {catalogImg && (
                <figure className="flex-1 min-w-0">
                  <button
                    type="button"
                    onClick={() => openZoom("catalog")}
                    aria-label="View the catalog photo full size"
                    title="View the catalog photo full size"
                    className="block w-full rounded-md overflow-hidden border border-line dark:border-slate-700 bg-white dark:bg-slate-800 flex items-center justify-center cursor-zoom-in"
                  >
                    {/* A SQUARE frame charged every photo the same height. A
                        landscape shot then sat in a band of empty black that was
                        pure wasted vertical space, while a portrait one used the
                        room it was given (reported 2026-08-10). Filling the
                        width and capping the height lets each photo take only
                        the height it needs: landscape gets short, portrait stays
                        tall and letterboxes sideways, which is the harmless
                        direction.
                        The cap has to BIND, though. These panes size by width,
                        so at a 209px column a 3:4 phone photo is 278px tall next
                        to a 156px landscape catalog shot - and the row inherits
                        the taller one. 20rem was above every height the layout
                        can produce, so it never applied and the pair looked
                        broken rather than comparable (reported 2026-08-11).
                        e2e/scan-card-photo-height.mjs holds the row to a budget
                        with a deliberately mismatched pair. */}
                    <EntityPhoto src={catalogImg} alt="catalog" aspect="4/3" fit="contain" eager placeholder={null} className="max-h-32 sm:max-h-48 !bg-transparent" onBroken={() => markBroken(catalogUrl)} />
                  </button>
                  {/* A photo's controls live ON the photo (its caption), not in
                      a standing ambient row — see scan-inbox-ux-review.md F2. */}
                  <figcaption
                    className={
                      "text-[10px] font-mono uppercase tracking-widest mt-1 flex items-center gap-2 " +
                      (unverified ? "text-amber-600 dark:text-amber-400" : "text-accent")
                    }
                  >
                    <span>{unverified ? "✦ catalog - checking" : "✦ catalog"}</span>
                    {hasOrigCatalog && !handheld && (
                      <button
                        type="button"
                        disabled={catalogAction.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          catalogAction.mutate("revert");
                        }}
                        title={catalogUndoTitle(catalogHistory)}
                        className="normal-case tracking-normal font-sans text-muted hover:text-content underline decoration-dotted underline-offset-2 transition disabled:opacity-50 inline-flex items-center gap-1"
                      >
                        {/* A real icon, not a unicode rotate glyph baked into
                            the label. A symbol used as an icon renders
                            differently on every platform and font, which is how
                            it ends up looking like a stray foreign character
                            rather than a control. */}
                        <RotateCcw size={11} className="shrink-0" />
                        {undoLabel}
                      </button>
                    )}
                  </figcaption>
                </figure>
              )}
              {yoursImg && yoursImg !== catalogImg && (
                <figure className="flex-1 min-w-0">
                  <button
                    aria-label="View full size"
                    type="button"
                    onClick={() => openZoom("yours")}
                    title="View full size"
                    className="block w-full rounded-md overflow-hidden border border-line dark:border-slate-700 bg-black flex items-center justify-center cursor-zoom-in"
                  >
                    <EntityPhoto src={yoursImg} alt="your photo" aspect="4/3" fit="contain" eager placeholder={null} className="max-h-32 sm:max-h-48 !bg-transparent" onBroken={() => markBroken(yoursRawUrl)} />
                  </button>
                  <figcaption className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mt-1 flex items-center gap-2">
                    <span>yours</span>
                    {item.image_file_id && !handheld && (
                      <button
                        type="button"
                        disabled={rotate.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          rotate.mutate();
                        }}
                        title="Rotate your photo 90°"
                        className="normal-case tracking-normal font-sans hover:text-content underline decoration-dotted underline-offset-2 transition disabled:opacity-50"
                      >
                        {rotate.isPending ? "rotating…" : "⟳ rotate"}
                      </button>
                    )}
                    {!handheld && (
                    <button
                      type="button"
                      disabled={catalogAction.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        catalogAction.mutate("use_own_photo");
                      }}
                      title="Use this photo as the catalog/display image"
                      className="normal-case tracking-normal font-sans hover:text-content underline decoration-dotted underline-offset-2 transition disabled:opacity-50"
                    >
                      use as catalog
                    </button>
                    )}
                    {item.image_file_id && !handheld && (
                      <button
                        type="button"
                        disabled={cropCatalog.isPending}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCropOpen(true);
                        }}
                        title="Crop part of this photo to be the catalog/display image"
                        className="normal-case tracking-normal font-sans hover:text-content underline decoration-dotted underline-offset-2 transition disabled:opacity-50"
                      >
                        crop for catalog
                      </button>
                    )}
                  </figcaption>
                </figure>
              )}
            </div>
          )}
          {cropModal}
          {/* Extra photos (multi-photo gallery): tap → make primary; × → remove.
              Renders ONLY when there are extras, so the photo-options strip sits
              directly under the big images: a strip holding nothing but its own
              add-tile spent a whole row saying nothing (reported 2026-08-11).
              Adding a photo lives in the ⋯ menu when the strip is absent. */}
          {lightbox}
          </div>
          <div className="min-w-0 flex flex-col gap-2">

          {/* The AI's read — collapsed to its one-line header by default
              tap to reveal the reconciliation paragraph + per-field
              chips. The working pulse lives in the always-visible header. */}
          {evidenceBox}

          {/* Research hint — re-run, confirm it's GOOD (lock into the barcode
              DB), flag WRONG (re-derive), or ask for more DETAIL (keep product,
              fill it in). */}
          {hintBox}
          {identityRow}

          </div>
          </div>

          {/* The strip and the commit controls are a FULL-WIDTH row under
              both columns. The strip used to sit in the photo column and
              reach right with a negative margin, which was only safe while
              that column happened to be taller than the rail: on an item
              with history and a long note the tiles ran straight under the
              research-hint box. No CSS can know which column is taller, so
              the strip stops borrowing the rail's space. */}
          <div className="flex flex-col gap-2 !mt-1.5 lg:flex-row lg:items-end lg:gap-3">
            {/* On a phone the strip has the row to itself and the commit
                controls take the next one: sharing a 393px row left the
                tiles ~170px and the "Add to Groceries…" button the rest. */}
            <div className="w-full min-w-0 lg:flex-1">
            {/* ONE strip: the item's own photos, a divider, then the web
                candidates - all the same tile, all in ONE flex row and ONE
                scroll container, because two adjacent rows with their own
                wrappers and their own tile sizes read as two widgets no matter
                how close together they sit. Its own full-width row under both
                columns, beside the commit stack. */}
            <div className="min-w-0" onClick={(e) => e.stopPropagation()}>
              {photoStrip}
            </div>
            </div>
            <div className="flex flex-row items-center justify-end gap-2 lg:mt-auto lg:flex-col lg:items-stretch">
              {/* The commit summon sits at the BOTTOM of the intel column, not on a
                  full-width row under the grid: the photo column always runs taller,
                  so that row was buying nothing but height (reported 2026-08-08).
                  Below `lg` the grid is one column, so this still lands last. */}
              {!planContext && !formOpen && (
                <div className="flex justify-end">
                  <div className="flex flex-col items-end gap-1">
                  {/* This is the ONE door into the fields: it opens the form on
                      the table CHOSEN in the header pill (not the matchmaker's
                      top guess - picking Assets up there and getting an
                      Inventory form down here was a real bug). "add somewhere
                      else…" is gone: the pill's picker lists every table, which
                      is the whole of what that link used to do. */}
                  <button
                    type="button"
                    onClick={() => openForm(dest ?? undefined)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-xs font-semibold transition"
                  >
                    {dest && !isUnidentified(item.suggested_name)
                      ? `Add to ${dest.label}…`
                      : "Add to a table…"}
                  </button>
                  </div>
                </div>
              )}
                {formOpen && <div ref={setActionSlot} className="flex justify-end" />}
                {!formOpen && (
                  <div className="flex justify-end">
                  {/* Close from where you FINISHED reading. The only collapse used to
                      be the chevron in the top rail, so getting out of a long card
                      meant scrolling back up past everything you had just read. */}
                  <button
                    type="button"
                    onClick={() => setExpanded(false)}
                    aria-label="Collapse this item"
                    title="Collapse"
                    className="shrink-0 rounded-md border border-line dark:border-slate-700 p-1.5 text-faint hover:text-accent hover:border-accent transition"
                    >
                    <ChevronDown size={14} className="rotate-180" />
                  </button>
                </div>
                )}
            </div>
          </div>


          {/* The inline confirm form — full width below (the right-rail
              attempt collided labels at every width; reverted per the author).
              NEVER in plan context: committing mid-plan removes the item from
              the plan — fixing identity is the only job here.
              SUMMONED, not ambient (review F1): a plain expand shows the summon
              row; the form renders once a destination is picked. */}
          {confirmForm}
        </div>
      )}
    </div>
  );
}

// ── gallery view tile: big photo + name + status ring; tap = triage ──

export function GalleryTile({
  item,
  slug,
  onOpen,
}: {
  item: ScanInboxItem;
  slug: string;
  onOpen: () => void;
}) {
  const resolved = rowPictures(slug, item);
  const yours = leadYours(resolved.pictures);
  const raw = leadPhoto(item, {
    catalog: [
      item.catalog_image_file_id ? scanFileUrl(slug, item.catalog_image_file_id) : null,
    ],
    yours: yours ? resolved.src(yours) : null,
  }).src;
  // The amber tile border marks the same thing the header's "to review" count
  // does, so it asks the shared predicate rather than re-deriving it. Its own
  // copy had already drifted: it kept flagging an item a human had marked "looks
  // fine", and stayed quiet on a low-confidence identification.
  const flagged = needsScanReview(item);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`group relative rounded-lg overflow-hidden border text-left aspect-square bg-subtle dark:bg-slate-800 ${
        flagged ? "border-amber-400/70" : "border-line dark:border-slate-700"
      }`}
    >
      <EntityPhoto src={raw} alt="" fill placeholder={<ScanLine size={22} className="text-faint" />} />
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-2 pt-6 pb-1.5">
        <div className="text-[11px] leading-tight text-white line-clamp-2">
          {item.suggested_name ?? <span className="italic text-white/70">unidentified</span>}
        </div>
        {(item.quantity ?? 1) > 1 && <div className="text-[10px] text-white/80">×{item.quantity}</div>}
      </div>
      {flagged && <span className="absolute top-1 right-1 text-[11px]">⚠</span>}
    </button>
  );
}

// ── photo options: DDG alternatives for the catalog image ────────────
// The "OTHER PHOTO OPTIONS" strip. Lazy — only fetches once a card
// is expanded; picking one downloads it into core-files as the catalog
// image (SSRF-guarded server-side).

function PhotoOptions({
  item,
  onView,
  onItems,
  term,
  onTerm,
  onSearched,
  compact,
  leading,
  leadingLabel,
  phone,
}: {
  item: ScanInboxItem;
  /** A tile's ⤢ opens the CALLER's full-screen viewer at this candidate (the
   *  scan card's ONE lightbox: catalog + yours + these candidates), instead of
   *  the picker's own viewer. */
  onView?: (url: string) => void;
  /** Report the fetched candidates up so the caller can fold them into its own
   *  filmstrip. */
  onItems?: (items: ImageOption[]) => void;
  /** The applied search term, owned by the caller so the SAME search can be
   *  driven from here or from the full-screen viewer. Uncontrolled when
   *  omitted. */
  term?: string;
  onTerm?: (t: string) => void;
  /** What the server actually searched for, reported up so a caller's own box
   *  can prefill with it rather than hiding it behind a placeholder. */
  onSearched?: (q: string) => void;
  /** Strip layout: one header line then the tiles, for sitting beside the
   *  item's own photo strip as a single row. */
  compact?: boolean;
  /** Rendered inside the tile row before the web candidates - the item's own
   *  photos and the divider, so the pair is one row. */
  leading?: ReactNode;
  leadingLabel?: ReactNode;
  /** Held in the hand: see ImageSearchPicker. */
  phone?: boolean;
}) {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  // The term box itself lives in the shared ImageSearchPicker; it hands the
  // typed term back via onSearch and we re-run the item's own ranked query
  // with it (the server treats a user term as an outright override).
  const [ownApplied, setOwnApplied] = useState("");
  const applied = term ?? ownApplied;
  const setApplied = (t: string) => (onTerm ? onTerm(t) : setOwnApplied(t));
  const options = useQuery({
    // ai_suggested_at is in the key on purpose: a re-run can change the NAME and
    // the resolved COLOUR, which changes the search phrase — but the old key was
    // just (item, term) with a 5 minute staleTime, so the strip kept serving the
    // photos from BEFORE the re-run. Hinting "color: blue" then looked like it
    // did nothing (reported 2026-07-30).
    // Keyed on the NAME, not just ai_suggested_at: the matchmaker can adopt a
    // better name without re-stamping ai_suggested_at, so a re-identify that
    // renamed the item left the strip searching the OLD title until a reload
    // (reported 2026-08-10). The name IS the search phrase, so it belongs in
    // the key of the query that searches by it.
    queryKey: [
      "scan-photo-options",
      activeSlug,
      item.id,
      applied,
      item.suggested_name ?? "",
      item.suggested_manufacturer ?? "",
      item.ai_suggested_at ?? "",
    ],
    queryFn: () => api.scanPhotoOptions(activeSlug, item.id, applied || undefined),
    // Only when there's a REAL name to search by — an unidentified item ("Unknown
    // Item") or a bare barcode returns junk photos, so don't even ask.
    enabled: !isUnidentified(item.suggested_name),
    staleTime: 5 * 60_000,
  });
  const pick = useMutation({
    mutationFn: (p: string | { url: string; aiPick?: boolean }) => {
      const url = typeof p === "string" ? p : p.url;
      return api.setScanCatalogImage(activeSlug, item.id, url, {
        ...(typeof p === "string" ? {} : { aiPick: p.aiPick }),
        thumbUrl: (options.data?.items ?? []).find((o) => o.url === url)?.thumb,
      });
    },
    onSuccess: () => {
      toast.success("Catalog photo updated");
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // A picture pasted into the search box. Uploaded and made the catalog image,
  // the same destination a picked web result reaches - a screenshot on your
  // clipboard is a perfectly good catalog photo and used to have no door at all
  // (reported 2026-09-03). An ADDRESS pasted here goes through `pick`, because
  // that is what a picked web result already is.
  const pasteCatalog = useMutation({
    mutationFn: (file: File) =>
      api
        .uploadFile(activeSlug, file)
        .then((up) => api.setScanCatalogFile(activeSlug, item.id, up.id)),
    onSuccess: () => {
      toast.success("Catalog photo set from your clipboard");
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // "✨ Pick best (AI)": a vision model ranks the options for the product-only,
  // correct-colour, no-people shot; on a pick we highlight its tile, show the
  // reason, and APPLY it as the catalog image in one press (the user can still
  // tap another). A null pick (no name / no provider) just surfaces the reason.
  // The DISPLAYED candidates + the applied term ride along, so the model ranks
  // exactly the tiles on screen (the ✨ badge always lands on a visible one) and
  // a second, nondeterministic search can't hand it a different pool.
  const [bestUrl, setBestUrl] = useState<string | null>(null);
  const [bestReason, setBestReason] = useState<string | null>(null);
  const pickBest = useMutation({
    mutationFn: () =>
      api.rankScanPhotoAi(activeSlug, item.id, {
        q: applied || undefined,
        candidates: options.data?.items ?? [],
      }),
    onSuccess: (r) => {
      if (r.chosen_url) {
        setBestUrl(r.chosen_url);
        setBestReason(r.reason || null);
        // Flagged as the AI's pick so Revert comes back HERE, not to the first
        // web result that this same apply stashes as the original.
        pick.mutate({ url: r.chosen_url, aiPick: true });
      } else {
        setBestUrl(null);
        setBestReason(r.reason || null);
        toast.info(r.reason || "AI couldn't pick a photo.");
      }
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  // Report the fetched candidates up so the card's ONE lightbox can fold them
  // into its filmstrip (open from the catalog image → see the web options too).
  useEffect(() => {
    onItems?.(options.data?.items ?? []);
    // What the server actually searched, so a caller's own box can PREFILL with
    // it. A blank box behind a placeholder hides the one thing you need to know
    // in order to change it.
    onSearched?.(options.data?.query ?? "");
  }, [options.data, onItems, onSearched]);
  // The search box, the grid, broken-thumb handling and the full-size preview
  // all live in the shared ImageSearchPicker now — this used to carry its own
  // copy of the box, which is exactly how the surfaces drifted apart. What
  // stays here is scan-specific: the item's own ranked pipeline
  // (scanPhotoOptions) and applying the pick as the CATALOG image.
  return (
    <ImageSearchPicker
      items={options.data?.items ?? []}
      throttled={!!options.data?.throttled}
      loading={options.isLoading}
      busy={pick.isPending || pasteCatalog.isPending}
      searchedTerm={options.data?.query ?? null}
      onSearch={(t) => {
        // A new search replaces the pool — a badge/reason about the OLD pool
        // would point at a tile that may no longer exist.
        setBestUrl(null);
        setBestReason(null);
        setApplied(t);
      }}
      onPick={(url) => pick.mutate(url)}
      onPreview={onView}
      label={applied ? `results for "${applied}"` : "find a better catalog photo"}
      phone={phone}
      onPickBest={() => pickBest.mutate()}
      pickingBest={pickBest.isPending}
      bestUrl={bestUrl}
      // catalog-address: marks which result is in use; only a stored pick is one.
      currentUrl={item.catalog_image_file_id ? (item.catalog_image_url ?? null) : null}
      bestReason={bestReason}
      compact={compact}
      leading={leading}
      leadingLabel={leadingLabel}
      onPasteImage={(file) => pasteCatalog.mutate(file)}
    />
  );
}

// ── research hint: tell the AI what it got wrong, re-run with it ─────

export function HintBox({
  onSubmit,
  busy,
  busyKind,
  hasBarcode,
  onConfirm,
  confirming,
  rowLeading,
  rowTrailing,
  aiOff = false,
  webCheckOff = aiOff,
  phone = false,
}: {
  onSubmit: (hint: string, opts: { wrong?: boolean; enrich?: boolean; noAi?: boolean }) => void;
  /** The workspace has NO AI provider. Every control here that calls a model is
   *  then a button that cannot do its job, and pressing it teaches nothing: the
   *  scan silently falls back to the keyword floor and the card looks unchanged.
   *  Say so on the control instead. Replay is exempt - it is noAi by design. */
  aiOff?: boolean;
  /** No chat model: the two curation checks (re-check every source and the
   *  web) need one. Re-run does not: it reads the photo again, which a
   *  deployment's hosted identify can do with no model connected at all, so
   *  it follows `aiOff` (the identify axis) instead. */
  webCheckOff?: boolean;
  /** On a phone: Replay (operator vocabulary, F5) and the shared-listing
   *  curation wait in the item menu and at a desk respectively. */
  phone?: boolean;
  busy: boolean;
  /** WHICH action is in flight — only that button's icon animates ("both
   *  spinners going" made a free replay read as an AI call). */
  busyKind?: "replay" | "ai" | null;
  hasBarcode: boolean;
  onConfirm: () => void;
  confirming: boolean;
  /** Controls that share the action row rather than each taking a row of their
   *  own. The barcode chip and the review-state toggle used to sit on separate
   *  lines above this box; folding them in here is pure height back. */
  rowLeading?: ReactNode;
  /** Controls that sit WITH Replay / Re-run rather than at the barcode end.
   *  Position is the only thing telling you what a control acts on, and
   *  "Looks fine" judges the identification, not the barcode it sat beside. */
  rowTrailing?: ReactNode;
}) {
  const [hint, setHint] = useState("");
  // The box shows its whole placeholder and grows with what is typed, up to
  // a few lines, instead of a fixed two rows that clipped the third line of
  // both (the owner, #3018).
  const hintRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoGrowTextarea(hintRef, hint, 160);
  // Folded away by default. These act on the SHARED catalog, not on the item in
  // front of you, and left open they were the loudest thing on the form: the
  // affirmative ran the full width at 350px while Confirm — the control that
  // actually files your item — was 95px and further down. Someone read the green
  // one as the confirm, pressed it, saw nothing arrive, and pressed it again
  // (reported 2026-07-15). A secondary action must not out-shout the primary one.
  const [curateOpen, setCurateOpen] = useState(false);
  // The three correction buttons below all write to the SHARED, cross-workspace
  // Barcode Intelligence DB (a wrong/enrich correction, or a green verify) — so a
  // scan in one workspace teaches every other workspace's future scans of that
  // UPC. Curating that shared DB is the platform operator's call, not every
  // member's: a well-meaning member "locking in" a mislabelled listing poisons it
  // for everyone. So the trio is operator-only. Members keep the research-hint +
  // Re-run AI above, which only re-resolves THEIR OWN item (workspace-scoped
  // cache), never the shared DB.
  const { user } = useAuth();
  const canCurateBarcodeDb = !!user?.is_platform_admin;
  const fire = (opts: { wrong?: boolean; enrich?: boolean; noAi?: boolean }) => {
    onSubmit(hint.trim(), opts);
    setHint("");
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // The hint is OPTIONAL — submitting empty re-runs the AI as-is (matches
        // the inline re-run); with a hint it re-runs with that extra context.
        if (aiOff) return;
        fire({});
      }}
      className="rounded-md border border-dashed border-line dark:border-slate-700 p-1.5"
    >
      {/* No caption row. It spent a line naming the box, which the box's own
          placeholder already does. Full-width textarea (a single-line input cut
          the placeholder off): Enter submits, Shift+Enter inserts a newline.
          The placeholder is two lines at a phone's width and the box grows
          with the typing, so nothing it says or holds is ever clipped. */}
      <textarea
        ref={hintRef}
        value={hint}
        onChange={(e) => setHint(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            fire({});
          }
        }}
        rows={2}
        placeholder="A model number, a better name, or the right barcode. Enter to submit."
        className="w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-800 resize-none"
      />
      {aiOff && (
        <p className="mt-1 text-[11px] text-muted dark:text-slate-400">
          Re-run needs a way to read photos, and this workspace has none yet. Replay still re-applies the latest processing.
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        {rowLeading}
        <span className="ml-auto" />
        {rowTrailing}
        {/* Replay — no model call of any kind. It re-runs everything DOWNSTREAM
            of the identification (routing, field mapping, pack size, decoder
            role-fill, the split derivation, category) over the answer already
            stored on this row, so a fix to any of that can be tried on a real
            item instantly and for free. It cannot produce a new identification,
            and by construction it cannot make the item worse. Use Re-run AI for a
            fresh look. Hidden when a hint is typed — a hint is new information,
            which needs a real read. */}
        {!hint.trim() && !phone && (
          <button
            type="button"
            disabled={busy}
            onClick={() => fire({ noAi: true })}
            title="Free and instant: re-applies Cobblr's latest processing (routing, fields, pack size) to what the AI already found. It keeps the identification as-is - use Re-run AI for a fresh look."
            className="rounded border border-line dark:border-slate-600 px-2 py-0.5 text-xs text-muted dark:text-slate-300 hover:bg-mortar-50 dark:hover:bg-slate-800 disabled:opacity-50 shrink-0 inline-flex items-center gap-1"
          >
            <RefreshCw size={11} className={busyKind === "replay" ? "animate-spin" : ""} /> Replay
          </button>
        )}
        {!phone && (
        <button
          type="submit"
          disabled={busy || aiOff}
          title={aiOff ? "Connect an AI provider under Configuration → AI to use this" : undefined}
          className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2 py-0.5 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed shrink-0 inline-flex items-center gap-1"
        >
          <RotateCcw size={11} className={busyKind === "ai" ? "animate-spin" : ""} /> {hint.trim() ? "Re-run with hint" : "Re-run AI"}
        </button>
        )}
      </div>
      {/* On a phone the two processing actions sit together on one row
          after the hint, at a thumb's size, with ONE short line under the
          row telling them apart; each button's full explanation is its
          title. They were a 20px button here and a row in a menu elsewhere,
          which made a recovery action look like an item transformation
          (#2982); then two columns with a helper paragraph each, which the
          owner read as wasted space (#3018). */}
      {phone && (
        <div className="mt-2 space-y-1">
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !!hint.trim()}
              onClick={() => fire({ noAi: true })}
              title="Free and instant: re-applies the latest processing (routing, fields, pack size) to what the AI already found; the identification stays as it is. Off while a hint is typed, since a hint needs a fresh read."
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-3 text-sm text-content dark:text-mortar-100 disabled:opacity-50"
            >
              <RefreshCw size={14} className={busyKind === "replay" ? "animate-spin" : ""} /> Replay
            </button>
            <button
              type="submit"
              disabled={busy || aiOff}
              title={aiOff ? "Connect an AI provider under Configuration → AI to use this" : hint.trim() ? "A fresh look at the photo and the code, using your hint." : "A fresh look at the photo and the code: the AI identifies it again from scratch."}
              className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md bg-cobble-600 px-3 text-sm font-medium text-white disabled:opacity-50"
            >
              <RotateCcw size={14} className={busyKind === "ai" ? "animate-spin" : ""} /> {hint.trim() ? "Re-run with hint" : "Re-run AI"}
            </button>
          </div>
          <p className="text-[11px] leading-snug text-faint">Replay is free and keeps the identification. Re-run AI looks at the photo and code again.</p>
        </div>
      )}
      {/* Shared-barcode-DB curation — OPERATOR ONLY (see canCurateBarcodeDb).
          Triage in traffic-light order — red → yellow → green:
          • This is wrong — distrust the identity entirely, re-derive from scratch.
          • Right — needs detail — product's right but the listing is thin; keep
            the identity, dig every source + the web for the full name/spec/photo.
          • This is good — verify the current listing into the shared barcode DB.
          The two corrections share a half-width row; the affirmative sits below. */}
      {canCurateBarcodeDb && !phone && !curateOpen && (
        <button
          type="button"
          onClick={() => setCurateOpen(true)}
          className="mt-2 w-full rounded border border-dashed border-line dark:border-slate-700 px-2 py-1 text-xs text-muted dark:text-slate-400 hover:bg-mortar-50 dark:hover:bg-slate-800 inline-flex items-center justify-center gap-1.5"
        >
          <Database size={11} /> Shared barcode listing
        </button>
      )}
      {canCurateBarcodeDb && !phone && curateOpen && (
        <>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-faint">Shared barcode listing</span>
            <button
              type="button"
              onClick={() => setCurateOpen(false)}
              className="text-xs text-muted dark:text-slate-400 hover:underline"
            >
              Hide
            </button>
          </div>
          <div className="mt-1 flex gap-2">
            <button
              type="button"
              disabled={busy || webCheckOff}
              onClick={() => fire({ wrong: true })}
              title={webCheckOff ? "Connect an AI provider under Configuration → AI to use this" : "Wrong product - re-check every source + the web, fix the name & photo, and correct the shared barcode database"}
              className="flex-1 min-w-0 rounded border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 px-2 py-1.5 text-sm font-medium disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              <Flag size={13} className={busy ? "animate-pulse" : ""} /> This is wrong
            </button>
            <button
              type="button"
              disabled={busy || webCheckOff}
              onClick={() => fire({ enrich: true })}
              title={webCheckOff ? "Connect an AI provider under Configuration → AI to use this" : "The product is right but the listing is sparse - re-check every source + the web to fill in the proper name, size and photo"}
              className="flex-1 min-w-0 rounded border border-amber-300 dark:border-amber-700/70 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/40 px-2 py-1.5 text-sm font-medium disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              <Sparkles size={13} className={busy ? "animate-pulse" : ""} /> Right - needs detail
            </button>
          </div>
          {hasBarcode && (
            <button
              type="button"
              disabled={busy || confirming}
              onClick={onConfirm}
              title="Publish the current name, brand & photo to the SHARED barcode database as verified. This does not file your own item - use Confirm for that."
              className="mt-2 w-full rounded border border-emerald-300 dark:border-emerald-700/70 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 px-3 py-1.5 text-sm font-medium disabled:opacity-50 inline-flex items-center justify-center gap-1.5"
            >
              <CheckCircle size={13} className={confirming ? "animate-pulse" : ""} /> Listing is correct - publish it
            </button>
          )}
        </>
      )}
    </form>
  );
}

// ── helpers for the AI chips + the menu-driven form ──────────────────

/** Pretty label for a candidate's extracted field — resolved from the
 *  menu entry's field defs, falling back to the raw field name. */

/** Pretty label for a candidate's extracted field — resolved from the
 *  menu entry's field defs, falling back to the raw field name. */
function menuFieldLabel(
  menu: ScanMenuEntry[] | null,
  cand: ScanCandidate,
  fieldName: string,
): string {
  const entry = (menu ?? []).find(
    (m) => m.module === cand.module && (m.instance ?? null) === (cand.instance ?? null),
  );
  // A table with no label for the field still reads as words, never as
  // "set_number" (#3077): the contract's humanFieldLabel.
  return humanFieldLabel(fieldName, entry?.fields.find((f) => f.name === fieldName)?.label);
}

/** The fields the DESTINATION declares that the matchmaker left empty.
 *
 *  The chip row only ever showed fields with a value, so a table's own
 *  distinctive fields were invisible whenever a scan happened not to fill them
 *  — asked as "where are all the unique fields for 3D Printer, not being
 *  shown?" (2026-08-11). They were never missing, just silent: an empty field
 *  has nothing to render as a chip. Counting them gives the row something
 *  honest to point at without pasting a blank form into a triage view. */

/** The fields the DESTINATION declares that the matchmaker left empty.
 *
 *  The chip row only ever showed fields with a value, so a table's own
 *  distinctive fields were invisible whenever a scan happened not to fill them
 *  — asked as "where are all the unique fields for 3D Printer, not being
 *  shown?" (2026-08-11). They were never missing, just silent: an empty field
 *  has nothing to render as a chip. Counting them gives the row something
 *  honest to point at without pasting a blank form into a triage view. */
function unfilledFieldLabels(
  menu: ScanMenuEntry[] | null,
  cand: ScanCandidate,
): string[] {
  const entry = (menu ?? []).find(
    (m) => m.module === cand.module && (m.instance ?? null) === (cand.instance ?? null),
  );
  if (!entry) return [];
  const filled = new Set(Object.keys(cand.fields ?? {}).map((k) => k.toLowerCase()));
  return entry.fields
    .filter((f) => !filled.has(f.name.toLowerCase()))
    .map((f) => f.label ?? f.name);
}

/** The `parent` config a bundle puts on a child instance (Spools → Filament
 *  Types): the create/scan flow find-or-creates the parent "type" by
 *  `key_fields` and links the child to it. Read off the instance's
 *  presentation-override config — generic, nothing filament-specific. */

/** The `parent` config a bundle puts on a child instance (Spools → Filament
 *  Types): the create/scan flow find-or-creates the parent "type" by
 *  `key_fields` and links the child to it. Read off the instance's
 *  presentation-override config — generic, nothing filament-specific. */
interface ParentConfig {
  instance: string;
  label?: string;
  key_fields?: string[];
  copy_fields?: string[];
}

/** Shown when the selected table is a CHILD instance with a `parent` type
 *  (Spools → Filament Types). It answers the question the auto-lift will
 *  resolve on commit — *does this type already exist?* — BEFORE you commit:
 *  match the in-progress item's `key_fields` against the parent instance's
 *  rows and show "adding to an existing <type>" vs "a new <type> will be
 *  created", with the defining fields (+ a colour swatch). Commit behaviour is
 *  unchanged — `inventory:lift-to-type` still does the find-or-create. Purely
 *  generic: the keys, label, and parent instance all come from the config. */

/** Shown when the selected table is a CHILD instance with a `parent` type
 *  (Spools → Filament Types). It answers the question the auto-lift will
 *  resolve on commit — *does this type already exist?* — BEFORE you commit:
 *  match the in-progress item's `key_fields` against the parent instance's
 *  rows and show "adding to an existing <type>" vs "a new <type> will be
 *  created", with the defining fields (+ a colour swatch). Commit behaviour is
 *  unchanged — `inventory:lift-to-type` still does the find-or-create. Purely
 *  generic: the keys, label, and parent instance all come from the config. */
function ParentTypeCard({
  slug,
  menu,
  parent,
  values,
  childNoun,
}: {
  slug: string;
  menu: ScanMenuEntry[] | null;
  parent: ParentConfig;
  /** The child item's current field values (merged custom fields + brand). */
  values: Record<string, unknown>;
  /** The child instance's own noun ("spool") for the copy. */
  childNoun: string;
}) {
  const typeLabel = parent.label?.trim() || "type";
  const keyFields = parent.key_fields ?? [];
  const items = useQuery({
    queryKey: ["instance-items", slug, parent.instance],
    queryFn: () =>
      api.request<{ items: Array<Record<string, unknown> & { id: string; name: string; metadata?: Record<string, unknown> }> }>(
        "GET",
        `/orgs/${slug}/instances/${parent.instance}/items`,
      ),
    enabled: !!slug && !!parent.instance,
    staleTime: 15_000,
  });

  // Labels for the parent's fields come from its scan-menu entry (so the chips
  // read "Material", "Colour" — not the raw key). Falls back to humanizeKey.
  const parentEntry = (menu ?? []).find((m) => m.instance === parent.instance);
  const labelOf = (k: string) =>
    parentEntry?.fields.find((f) => f.name === k)?.label ?? humanizeKey(k);

  // Match the in-progress item against the parent instance's rows (same
  // find-or-create rule the commit-time auto-lift uses).
  const { present, match } = matchParentType(items.data?.items ?? [], keyFields, values);
  const typeVal = readField;

  const chip = (k: string, v: unknown) => {
    const sw = /colou?r/i.test(k) ? colorSwatch(v) : null;
    return (
      <span
        key={k}
        className="inline-flex items-center gap-1 rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-0.5 text-[11px]"
      >
        {sw && <span className="h-3 w-3 shrink-0 rounded-full border border-line dark:border-slate-600" style={{ background: sw }} />}
        <span className="text-faint dark:text-slate-500">{labelOf(k)}</span>
        <span className="font-medium text-content dark:text-mortar-100">{String(v)}</span>
      </span>
    );
  };

  let body: ReactNode;
  if (items.isLoading) {
    body = <div className="text-[11px] text-faint dark:text-slate-500">Checking existing {typeLabel.toLowerCase()}s…</div>;
  } else if (present.length === 0) {
    body = (
      <div className="text-[11px] text-faint dark:text-slate-500">
        Fill {keyFields.map(labelOf).join(" / ") || "the defining fields"} and we'll match this to {withArticle(typeLabel.toLowerCase())} (or create one).
      </div>
    );
  } else if (match) {
    body = (
      <>
        <div className="text-[12px] text-content dark:text-mortar-100">
          <span className="font-semibold text-moss-600 dark:text-moss-400">✓ Existing {typeLabel.toLowerCase()}</span>
          {" — "}this {childNoun} will be added to{" "}
          <span className="font-semibold">{String(match.name)}</span>.
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {[...(parent.key_fields ?? []), ...(parent.copy_fields ?? [])]
            .map((k) => [k, typeVal(match, k)] as const)
            .filter(([, v]) => v != null && v !== "")
            .map(([k, v]) => chip(k, v))}
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div className="text-[12px] text-content dark:text-mortar-100">
          <span className="font-semibold text-cobble-600 dark:text-cobble-300">✦ New {typeLabel.toLowerCase()}</span>
          {" — "}no match yet, so {withArticle(typeLabel.toLowerCase())} will be created from these and this {childNoun} linked to it.
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {present.map((k) => chip(k, values[k]))}
        </div>
      </>
    );
  }

  return (
    <div className="rounded-md border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 px-3 py-2 sm:col-span-2">
      <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1.5">
        {typeLabel}
      </div>
      {body}
    </div>
  );
}

// ── the inline confirm form — driven by the workspace scan MENU ───────
// Series banner: when several pending items were identified as belonging to the
// SAME series/franchise (Harry Potter, Little House), offer to tag them all with
// the series in one tap. The series comes from the vision identify
// (suggested_metadata.series); tagging reuses the apply-theme loop, so the tag
// rides to each entity at confirm — books to Bookshelf, all carrying the series.
/** The date printed ON a receipt, when its lines carry one.
 *
 *  Every line of a parsed receipt is stamped with the receipt's own date, so the
 *  session can say when the shopping happened rather than when the photo was
 *  taken. Null for an ordinary scan session, which has no date but its own. */

function ConfirmForm({
  item,
  menu,
  candidates,
  hasLocations,
  initialKey,
  prefill,
  onPickDestination,
  onDone,
  onCancel,
  onCollapse,
  actionSlot,
  fieldSlot,
  locSlot,
  actionsLayout = "stack",
  fieldsLayout = "chips",
}: {
  item: ScanInboxItem;
  menu: ScanMenuEntry[] | null;
  /** The matchmaker's ranked candidates — switching the Add-to picker to a
   *  table the model already extracted for reseeds its field values. */
  candidates: ScanCandidate[];
  hasLocations: boolean;
  /** Pre-selected menu entry (a matchmaker chip or the ?into= target). */
  initialKey: string | null;
  prefill?: Record<string, unknown>;
  onDone: () => void;
  onCancel: () => void;
  /** Collapse the whole card. Rendered beside Confirm so the control keeps
   *  the same home it has when the form is closed. */
  onCollapse?: () => void;
  /** How the commit pair sits: a vertical stack against the card's right edge
   *  (the closed state's shape), or one ROW for a pinned footer, where only
   *  Confirm renders: the footer owns Cancel there, and it leaves the screen
   *  (ScanItemSheetFooter), so the form's own cancel would be a second Cancel
   *  with a different meaning (#3018). */
  actionsLayout?: "stack" | "row";
  /** The person picked a table in "Add to": store it on the row as theirs. */
  onPickDestination?: (key: string) => void;
  /** How the fields render: CHIPS on the card's own chip row (the desktop
   *  idiom, one line beside the pill), or a LIST of labelled inputs, every
   *  field of the table, two to a row, for the phone's item sheet, where a
   *  chip row of fourteen "+ Field" chips is a wall. One form, one state,
   *  two renderings, the way actionsLayout already does it for the buttons. */
  fieldsLayout?: "chips" | "list";
  /** Where the commit pair renders. The card gives the form the SAME slot the
   *  "Add to Inventory" pair uses when the form is closed, so the action anchor
   *  never moves between the two states. Null renders them inline. */
  actionSlot?: HTMLElement | null;
  /** Where the FIELDS render. Given a slot, the chips join the card's own chip
   *  row - the one that already shows them read-only - instead of being a
   *  second copy of that row lower down. The form keeps all of its state and
   *  submission; only the chips move. */
  fieldSlot?: HTMLElement | null;
  /** Where the LOCATION drawer opens: the seam under the chip strip that holds
   *  its trigger. Null renders it inline, at the bottom of the form. */
  locSlot?: HTMLElement | null;
}) {
  const { activeSlug, activeOrg } = useActiveOrg();
  const { user } = useAuth();
  const isAdmin = !!user?.is_platform_admin;
  // Installing a bundle changes workspace composition → owner/admin only (the
  // materialize endpoint enforces this). Gate the install-and-add card on it so
  // an editor doesn't hit a 403 dead-end; they still get the normal picker.
  // Editor included: the server-side enable path (module enable behind the
  // confirm) allows editor too, and gating the UI stricter than the API just
  // hands editors a raw 409 instead of the install flow (2026-08-25 audit).
  const canInstallBundle = roleSatisfies(activeOrg?.role, ["owner", "admin"]);
  const qc = useQueryClient();
  const toast = useToast();
  // Platform-admin only: capture this corrected commit as a matchmaker eval case.
  const [saveEvalCase, setSaveEvalCase] = useState(false);
  const [evalNote, setEvalNote] = useState("");

  // The workspace scan menu (with named instances like "Yarn") loads async, so
  // while it's in flight `menu` is null and we'd otherwise pick from FALLBACK_MENU
  // — which has ONLY the generic base tables. Seed the routed live-instance
  // candidates into the menu from the candidate itself (`withRoutedInstances`),
  // so a yarn-routed scan defaults to "Yarn" on the FIRST render instead of
  // flashing "Inventory part" (and filing there if the user confirms before the
  // fetch lands). Once the real menu resolves it already carries the instance —
  // with field defs — and the placeholder is dropped as a duplicate.
  const baseEntries = withRoutedInstances(
    menu && menu.length > 0 ? menu : FALLBACK_MENU,
    candidates,
  );
  // A not-installed flagship bundle can BE the best match (a scanned VIN →
  // "Vehicles"). Rather than dropping to Inventory with read-only chips, make it
  // a FIRST-CLASS editable destination that leads the picker and is the default:
  // fetch its field DEFS from the bundle menu and offer "Vehicles (installs on
  // confirm)"; the install happens as part of Confirm (nothing is created until
  // then). Owner/admin only — installing changes workspace composition.
  // The row's one destination decides (#3618); the candidate lends the
  // bundle's table details.
  const destBundle = item.resolved_destination?.bundle_external_id ?? null;
  const topBundleCand = canInstallBundle && destBundle ? (candidates.find((c) => c.bundle_external_id === destBundle) ?? null) : null;
  const bundleMenuQ = useQuery({
    queryKey: ["scan-bundle-menu", activeSlug],
    queryFn: () => api.scanBundleMenu(activeSlug),
    enabled: !!activeSlug && !!topBundleCand,
    staleTime: 5 * 60_000,
  });
  const willInstallEntry: (ScanMenuEntry & { bundle_external_id?: string }) | null =
    topBundleCand?.bundle_external_id
      ? (bundleMenuQ.data?.items ?? []).find(
          (m) =>
            m.bundle_external_id === topBundleCand.bundle_external_id &&
            m.module === topBundleCand.module &&
            (m.instance ?? null) === (topBundleCand.instance ?? null),
        ) ?? null
      : null;
  const willInstallKey = willInstallEntry ? entryKey(willInstallEntry.module, willInstallEntry.instance) : null;
  // The will-install destination leads the picker; dedupe against the base menu.
  const entries =
    willInstallEntry && !baseEntries.some((m) => entryKey(m.module, m.instance) === willInstallKey)
      ? [willInstallEntry, ...baseEntries]
      : baseEntries;
  // Initial pick: the will-install bundle when it's the top match, else the
  // routed entry, else a GENERIC default table (never an arbitrary named
  // instance). pickDestinationKey is pure + unit-tested in scanDestination.ts.
  const hintedKey =
    willInstallKey ??
    pickDestinationKey({
      initialKey,
      entries,
      entityType: (item.suggested_metadata as { entity_type?: string } | null)?.entity_type ?? null,
    });
  const [selKey, setSelKey] = useState<string>(hintedKey);
  // `withRoutedInstances` keeps `hintedKey` correct for a routed LIVE instance
  // even mid-load, so this adopt-on-change mainly covers the OTHER direction: a
  // routed candidate that turns out NOT to be a real table (a not-yet-installed
  // bundle key the loaded menu doesn't carry) → `hintedKey` flips to the generic
  // default once the menu resolves, and we follow it. When the real menu resolves
  // and now contains the routed instance, adopt it — unless the user already
  // picked a destination by hand.
  const userPickedDest = useRef(false);
  useEffect(() => {
    if (userPickedDest.current) return;
    if (selKey !== hintedKey) setSelKey(hintedKey);
  }, [hintedKey]);
  const entry =
    entries.find((m) => entryKey(m.module, m.instance) === selKey) ?? entries[0]!;

  // The matchmaker candidate for the initial selection: its extraction seeds
  // the fields and its cleaned `name` (retailer noise stripped) beats the raw
  // lookup title.
  const initialCand =
    candidates.find((c) => entryKey(c.module, c.instance) === hintedKey) ?? null;

  // If the selected table is a CHILD instance with a `parent` type (Spools →
  // Filament Types), read its parent config off the presentation override so
  // the form can show whether the type already exists. Generic — the keys all
  // come from config; nothing here knows "filament".
  const overrides = useQuery({
    queryKey: ["entity-kind-overrides", activeSlug],
    queryFn: () => api.listOverrides(activeSlug),
    enabled: !!activeSlug,
    staleTime: 30_000,
  });
  const parentConfig: ParentConfig | null = (() => {
    if (!entry.instance) return null;
    const o = (overrides.data?.items ?? []).find(
      (x) => x.target_kind === "instance" && x.target_id === `${entry.module}:${entry.instance}`,
    );
    const p = o?.config?.parent as ParentConfig | undefined;
    return p && p.instance ? p : null;
  })();

  // ONE name. The row's title is what the list, the sheet header and File N
  // show and what a rename writes; the candidate's name is the model's
  // proposal for the record. Seeding the input from the proposal meant a
  // renamed row reopened with the old name in its own Name box while the
  // title above it showed the new one (#2982, 2026-09-14). The title leads;
  // the proposal is the fallback for a row with no name of its own.
  // Every input below is HELD, not re-seeded: a field the person is on
  // keeps what they typed across a refetch, a server change to it is
  // offered beside it, a field nobody touched follows the server
  // (scanHeldField.ts, #2982).
  const nameF = useHeldField("name", item.suggested_name ?? initialCand?.name ?? "");
  const name = nameF.value;
  // Editing NAME here used to change only what the item would be FILED as: the
  // value went to confirmScanItem and never to the row, so the card's title kept
  // showing the AI's name, and leaving without committing threw the correction
  // away (reported 2026-08-13). Renaming an inbox item is already a supported
  // action - five other surfaces call updateScanItem({ name }) - so this one
  // joins them.
  //
  // ONLY ON A REAL EDIT, though, and that guard is load-bearing rather than
  // tidy. This field is seeded from the CANDIDATE's reconciled name, which
  // legitimately differs from the row's, so a blur-triggered save would rewrite
  // suggested_name just because someone opened the form and tabbed past. Worse:
  // PATCH /inbox/:id reports a renamed BARCODE item to the shared Barcode
  // Intelligence DB, so that phantom rename would publish a bogus correction to
  // every workspace that ever scans that UPC.
  const persistName = useMutation({
    mutationFn: (next: string) => api.updateScanItem(activeSlug, item.id, { name: next }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) }),
    // NOT silent: this card's own Confirm re-sends the name, but "File all"
    // reads the ROW's stored name - so a rename that silently failed meant the
    // bulk path filed the AI's original with no sign the correction was lost
    // (2026-08-25 audit).
    onError: () => toast.error("Couldn't save the new name - File all would use the old one. Try again."),
  });
  // Debounced: the phone's Name box calls this on every keystroke, and a
  // PATCH per keystroke meant a refetch per keystroke under the person's
  // hands. Flushed when the form goes away, so Cancel keeps the rename.
  const pendingName = useRef<string | null>(null);
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushName = () => {
    if (nameTimer.current) clearTimeout(nameTimer.current);
    nameTimer.current = null;
    const next = pendingName.current;
    pendingName.current = null;
    if (next !== null) persistName.mutate(next.trim());
  };
  const commitNameEditWith = (next: string) => {
    if (nameTimer.current) clearTimeout(nameTimer.current);
    nameTimer.current = null;
    if (!shouldPersistNameEdit({ dirty: true, next, rowName: item.suggested_name })) {
      pendingName.current = null;
      return;
    }
    pendingName.current = next;
    nameTimer.current = setTimeout(flushName, 700);
  };
  useEffect(() => () => flushName(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const takeTheirName = () => {
    const theirs = nameF.theirs;
    nameF.useTheirs();
    if (theirs !== null) {
      pendingName.current = null;
      if (nameTimer.current) clearTimeout(nameTimer.current);
      persistName.mutate(theirs.trim());
    }
  };
  // A serial/service tag the vision read off the label. It already commits to the
  // destination's native serial_number column, but was never SHOWN — so the user
  // couldn't tell it was captured (and the matchmaker note "no serial field in
  // this table" reinforced that). Surface it, pre-filled + editable (fix OCR
  // slips), for items where a serial applies: one was captured, or the target is
  // equipment (machines/assets). It rides to the native column via `extras`.
  // A decoded IDENTIFIER is a serial: the Vehicles bundle tags `serial_number` as
  // `identifier:vin`, so a VIN scan's code belongs in this box. Before, the VIN sat
  // in the card's title while the very field declared to hold it was blank.
  const decodedIdentifier = (() => {
    const m = item.suggested_metadata as { decoded?: { decoder_id?: string } } | null;
    return m?.decoded?.decoder_id ? (item.barcode_text ?? "") : "";
  })();
  const capturedSerial =
    String((item.suggested_metadata as { serial_number?: unknown } | null)?.serial_number ?? "") ||
    decodedIdentifier;
  const serialF = useHeldField("serial_number", capturedSerial);
  const serial = serialF.value;
  const showSerial = !!capturedSerial || entry.module === "machines" || entry.module === "assets";
  // The destination's native-field PRESENTATION. A bundle can relabel a native
  // field per kind (manufacturer -> "Make", serial_number -> "VIN"); every other
  // entity form reads this, but the confirm form hardcoded its labels, so a
  // bundle's relabels stopped at its door. You could install Vehicles and still be
  // asked for a "Serial number" on a card whose subtitle was a VIN.
  const presentation = useFieldPresentation(entry.kind ?? "");
  const fieldLabel = (nativeName: string, fallback: string) =>
    presentation.label(nativeName, fallback);
  const aiStatus = useAiStatus();
  // Quantity: the matchmaker's pack-count read ("1 Pack Of 9 Skein" -> 9)
  // beats the row's default 1; an explicitly-set row quantity beats both.
  const initialQty = (() => {
    const cand = candidates.find((c) => entryKey(c.module, c.instance) === hintedKey);
    if ((item.quantity ?? 1) > 1) return item.quantity;
    return cand?.quantity ?? item.quantity ?? 1;
  })();
  const quantityF = useHeldField<number>("quantity", initialQty);
  const quantity = quantityF.value;
  // Pre-fill from the filing bin stamped at scan time (target_location_id), so a
  // deferred triage already knows where it was scanned; the scan_area string-match
  // effect below only fires as a fallback when no bin was set.
  const locationF = useHeldField("location", item.target_location_id ?? "");
  const locationId = locationF.value;
  const setLocationId = locationF.set;
  // Pre-fill the looked-up brand; the table's own fields (colour, fibre…)
  // seed from the lookup metadata, then the matchmaker's extraction wins.
  const manufacturerF = useHeldField("manufacturer", item.suggested_manufacturer ?? "");
  const manufacturer = manufacturerF.value;
  // The CATEGORY, for a table that keeps its own categories (inventory's
  // tree): no custom field carries it, so the form asks it here, by name,
  // and the server files it wherever the table keeps them (#3223). A table
  // whose category is a field asks it among its fields as before.
  const byNameAxis = categoryTravelsByName([entry], entry) ? entry.category_field ?? null : null;
  const entryCand = candidates.find((c) => entryKey(c.module, c.instance) === entryKey(entry.module, entry.instance)) ?? null;
  const categoryF = useHeldField("category_axis", entryCand?.category ?? "");
  const categoryChoice = categoryF.value;
  // Kept on the row as the person types, like the table's own fields, so
  // File all and a reload file what they chose, not the model's read.
  const sentCategory = useRef(entryCand?.category ?? "");
  useEffect(() => {
    if (!byNameAxis || item.status !== "pending") return;
    const next = categoryChoice.trim();
    if (next === sentCategory.current.trim()) return;
    const t = setTimeout(() => {
      sentCategory.current = next;
      api.updateScanItem(activeSlug, item.id, { category: next || null, fields_kind: entry.kind }).catch(() => {
        // Best effort: the form still holds it, and Confirm sends it.
      });
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoryChoice, byNameAxis, entry.kind, item.id, item.status]);
  // What the person types against the table's fields is kept on the ROW, not
  // only in this form: Cancel, collapse, the sheet's previous/next and a
  // reload used to lose it, and "review now, file later" meant reviewing
  // twice. Debounced, only the table's own fields, only what changed since
  // the last write; the served row carries the values back merged over the
  // top candidate's, so the chips and File N read them too.
  const customSeed = ((): Record<string, unknown> => {
    const meta = (item.suggested_metadata as Record<string, unknown> | null) ?? {};
    const seed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (v != null && v !== "" && typeof v !== "object") seed[k] = v;
    }
    // A vendor/URL resolver (a Polar spool QR, …) stows its PARSED FIELDS as a
    // nested `fields` object — size, batch_code, material, … keyed to field-def
    // names. The loop above skips objects, so without this those parsed fields
    // never reach the form (the "all the info is there but nothing's filled in"
    // bug). Spread them in over the flat seed.
    for (const [k, v] of Object.entries(parsedScanFields(meta))) {
      if (v != null && v !== "") seed[k] = v;
    }
    // Layering: raw lookup seed < the matchmaker's extraction for this
    // table < an explicit chip prefill (which IS that extraction when the
    // chip routed here).
    return { ...seed, ...(initialCand?.fields ?? {}), ...(prefill ?? {}) };
  })();
  const sentFields = useRef<Record<string, unknown>>({ ...customSeed });
  // A value the form takes from the server is what the server has: not a
  // change to send back.
  const custom = useHeldRecord(customSeed, (k, v) => {
    sentFields.current[k] = v;
  });
  const customValues = custom.values;

  const locs = useQuery({
    queryKey: ["locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug && hasLocations,
  });

  // Pre-fill the location from the item's scan_area (the camera stamps the
  // location's NAME — match it back to a row). Only while untouched, so a
  // user's explicit pick is never overwritten when the list loads late.
  const [locTouched, setLocTouched] = useState(false);
  // The location chips stay COLLAPSED behind a dropdown-style trigger — a full
  // location tree (every room + every bin) dumped inline swamped the form.
  const [locOpen, setLocOpen] = useState(false);
  useEffect(() => {
    if (locTouched || locationId || !item.scan_area) return;
    const want = item.scan_area.trim().toLowerCase();
    const hit = (locs.data?.items ?? []).find(
      (l) =>
        l.name.trim().toLowerCase() === want ||
        (l.short_name ?? "").trim().toLowerCase() === want,
    );
    if (hit) setLocationId(hit.id);
  }, [locs.data, item.scan_area, locationId, locTouched]);

  // The selected destination is a not-installed bundle when the entry carries a
  // `bundle_external_id` (the will-install "Vehicles" entry). Confirm installs it
  // first, then files into it — so nothing is created until the user confirms.
  const willInstall = (entry as { bundle_external_id?: string }).bundle_external_id ?? null;

  // Picking a location PERSISTS immediately (target_location_id on the inbox item),
  // not only when you Confirm. Two reasons: you shouldn't have to commit the whole
  // item just to say where it goes, and the 8s inbox poll re-renders this card —
  // local-only state was getting reset, so the pick "didn't stick". Persisting +
  // invalidating means the item re-seeds from the saved value, so it survives.
  const persistLocation = useMutation({
    mutationFn: (locId: string | null) =>
      api.updateScanItem(activeSlug, item.id, { target_location_id: locId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  const confirmMut = useMutation({
    mutationFn: async () => {
      // `extras.metadata` (the table's fields the user filled — colorway,
      // fibre, …) is deep-merged server-side (keeps the scan's barcode/sku);
      // manufacturer overrides the lookup's.
      // Only keys the destination DECLARES. A stale extraction (a field
      // retired by a bundle upgrade while this sat in the inbox) would
      // otherwise land as an orphan key in the record's metadata: invisible in
      // every field UI afterwards, and in the reported case contradicting the
      // item's real location for good.
      const cleanMeta = Object.fromEntries(
        Object.entries(fieldsStillOnTable(entry, customValues)).filter(([, v]) => v != null && v !== ""),
      );
      const extras = {
        ...(manufacturer.trim() ? { manufacturer: manufacturer.trim() } : {}),
        // Top-level (not under metadata) so it lands in the destination's NATIVE
        // serial_number column via the confirm handler's restExtras.
        ...(serial.trim() ? { serial_number: serial.trim() } : {}),
        ...(Object.keys(cleanMeta).length ? { metadata: cleanMeta } : {}),
      };
      // A will-install destination is created FIRST (materialize with no item_ids
      // installs the bundle + its table, committing nothing), then we file THIS
      // item into it with the EDITED values — same commit path as any table.
      const entryInstance = await resolveInstanceForFiling(activeSlug, willInstall, entry.instance);
      const confirmed = await api.confirmScanItem(activeSlug, item.id, {
        target_module: entry.module,
        target_kind: baseKind(entry.module),
        instance: entryInstance,
        name: name.trim() || (item.suggested_name ?? "Untitled"),
        quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : undefined,
        location_id: locationId || undefined,
        extras: Object.keys(extras).length ? extras : undefined,
        ...(byNameAxis && categoryChoice.trim() ? { category: categoryChoice.trim() } : {}),
        ...(isAdmin && saveEvalCase
          ? { save_eval_case: true, eval_note: evalNote.trim() || undefined }
          : {}),
      });
      return confirmed;
    },
    onSuccess: () => {
      // No toast: where it went is the filed row's to say (lib/filedRows.ts).
      void qc.invalidateQueries({ queryKey: scanInboxKeys.all(activeSlug) });
      // A will-install commit just added a module/instance/table — refresh nav +
      // menus so everything reflects the new install.
      if (willInstall) {
        void qc.invalidateQueries({ queryKey: ["scan-menu", activeSlug] });
        void qc.invalidateQueries({ queryKey: ["org-modules", activeSlug] });
        void qc.invalidateQueries({ queryKey: ["instances", activeSlug] });
      }
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });

  // dark: fields sit one step LIGHTER (slate-800) than the slate-900 card +
  // a visible border — they were blending into the background (the author).
  // ── the chip field model ────────────────────────────────────────────────
  // One list of {key,label,value}; ChipFields decides the layout. A field is
  // OFFERED rather than shown when the table declares it and nothing filled it,
  // which is what stops a dozen empty boxes from owning the page.
  const [addedFields, setAddedFields] = useState<string[]>([]);
  const selectedLoc = locationId ? (locs.data?.items ?? []).find((l) => l.id === locationId) : null;
  const locLabel = selectedLoc ? (selectedLoc.short_name?.trim() || selectedLoc.name) : locationId ? "…" : "";
  // ONE placement action, beside the field it fills (#3074). It was two
  // apparently different buttons in two regions, "Put here" on a green
  // banner under the source data and "Put it where suggested" under More,
  // and both did exactly this write. The destination and its reason are
  // said here; the same picker above is how to choose otherwise.
  const offered = suggestedPlace(item);
  const suggestedSpot = offered && !item.target_location_id && !locationId ? offered.id : null;
  const suggestedName = offered?.place ?? "";
  const suggestedWhy = offered?.why ?? "";
  const putWhereSuggested = () => {
    if (!suggestedSpot) return;
    setLocTouched(true);
    setLocationId(suggestedSpot);
    persistLocation.mutate(suggestedSpot);
  };
  // The action rides IN the suggestion's line, as a word in it, right after
  // the spot it puts the thing in: a green block on a row of its own spent
  // more of a phone screen than the sentence it answered, and at the END of
  // the line a long reason pushed the chip onto a line of its own. The chip
  // is small; the tap is not: the button around it keeps a 44px target
  // whose negative margin gives the line back its height.
  const suggestedPlacement = suggestedSpot ? (
    <span data-testid="suggested-placement" className="block min-w-0 text-xs leading-5 text-moss-800 dark:text-moss-300">
      <MapPin size={11} className="mr-1 inline-block" />
      Suggested: <span className="font-medium">{suggestedName}</span>{" "}
      <button
        type="button"
        data-testid="suggested-placement-put"
        onClick={(e) => {
          // Exactly one thing: set the spot. Nothing around it (a card, a
          // cell, a label) gets the tap as well.
          e.preventDefault();
          e.stopPropagation();
          putWhereSuggested();
        }}
        disabled={persistLocation.isPending}
        className="group -my-3 inline-flex min-h-11 items-center px-0.5 align-middle disabled:opacity-50"
      >
        <span className="whitespace-nowrap rounded-full border border-moss-600/50 bg-moss-500/10 px-2 py-0.5 text-xs font-medium leading-4 text-moss-800 transition group-hover:bg-moss-500/20 dark:text-moss-300">
          {persistLocation.isPending ? "…" : "Put here"}
        </span>
      </button>
      {suggestedWhy ? <span className="text-muted dark:text-slate-400"> · {suggestedWhy}</span> : null}
    </span>
  ) : null;

  useEffect(() => {
    if (item.status !== "pending") return;
    const tableKeys = new Set((entry.fields ?? []).map((f) => f.name));
    const changed: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(customValues)) {
      if (!tableKeys.has(k)) continue;
      if (sentFields.current[k] === v) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") changed[k] = v;
      else if (v == null || v === "") changed[k] = null;
    }
    if (Object.keys(changed).length === 0) return;
    const t = setTimeout(() => {
      for (const k of Object.keys(changed)) sentFields.current[k] = customValues[k];
      api.updateScanItem(activeSlug, item.id, { fields: changed, fields_kind: entry.kind }).catch(() => {
        // Best effort: the form still holds the value, and Confirm sends it.
      });
    }, 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customValues, entry, item.id, item.status]);

  const setChipValue = (key: string, value: string) => {
    if (key === "name") { nameF.set(value); commitNameEditWith(value); return; }
    if (key === "manufacturer") { manufacturerF.set(value); return; }
    if (key === "category_axis") { categoryF.set(value); return; }
    if (key === "serial_number") { serialF.set(value); return; }
    if (key === "quantity") { quantityF.set(Number(value) || 1); return; }
    custom.set(key, value);
  };

  const builtins: ChipFieldDef[] = [
    { key: "name", label: fieldLabel("name", "Name"), value: name, placeholder: item.suggested_name ?? "" },
    { key: "manufacturer", label: fieldLabel("manufacturer", "Brand"), value: manufacturer },
    ...(showSerial ? [{ key: "serial_number", label: fieldLabel("serial_number", "Serial no."), value: serial }] : []),
    { key: "quantity", label: "Qty", value: String(quantity), type: "number" as const },
    ...(byNameAxis
      ? [{ key: "category_axis", label: byNameAxis.label, value: categoryChoice, choices: byNameAxis.values }]
      : []),
    ...(hasLocations
      ? [{
          key: "location",
          label: "Location",
          value: locLabel,
          emptyHint: "set",
          icon: locLabel ? <MapPin size={12} className="shrink-0 text-accent" /> : null,
          onActivate: () => setLocOpen((o) => !o),
        }]
      : []),
  ];
  // A field of the table's own that clarifies another (a seller beside where
  // it came from, from the contract's ROLE_CLARIFIES): that picker's right
  // half writes there instead of the note (ChoiceField's detailField).
  const clarifierDef = (entry.fields ?? []).find((x) => !!x.field_role && !!ROLE_CLARIFIES[x.field_role as FieldRole]) ?? null;
  const sellerFor = (def: { field_role?: string | null; name: string }) =>
    clarifierDef && def.field_role && def.field_role === ROLE_CLARIFIES[clarifierDef.field_role as FieldRole]
      ? { name: clarifierDef.name, label: clarifierDef.label ?? clarifierDef.name, value: customValues[clarifierDef.name], onChange: (v: unknown) => custom.set(clarifierDef.name, v) }
      : undefined;
  // A value with who it came from beside it reads as one ("3DPrintopia 2026 ·
  // Jai"), as the record page shows it; the chip still commits the value alone.
  const besideOf = (f: { name: string; field_role?: string | null }) => {
    const seller = sellerFor(f);
    const v = seller ? seller.value : customValues[noteKey(f.name)];
    return v == null || String(v).trim() === "" ? null : String(v);
  };
  const customChips: ChipFieldDef[] = (entry.fields ?? []).map((f) => ({
    key: f.name,
    label: f.label ?? f.name,
    value: String(customValues[f.name] ?? ""),
    ...(besideOf(f) ? { display: `${String(customValues[f.name] ?? "")} · ${besideOf(f)}` } : {}),
    type: (f.type === "select" ? "select" : f.type === "date" ? "date" : f.type === "number" ? "number" : "text") as ChipFieldType,
    choices: f.choices ?? null,
  }));
  const all = [...builtins, ...customChips];
  // On the item = it has a value, it is always-on (name / add-to / qty), or the
  // user just asked for it.
  const ALWAYS = new Set(["name", "quantity", "category_axis"]);
  const chipFields = all.filter((f) => f.value || ALWAYS.has(f.key) || addedFields.includes(f.key));
    // Confirm leads, Cancel under it, collapse last: the same primary-first
    // order as the closed state's "Add to Inventory… / collapse", so the corner
    // reads the same way in both states.
  const chipAvailable = all.filter((f) => !chipFields.includes(f));

  const formId = `confirm-${item.id}`;
  const row = actionsLayout === "row";
  const commitActions = (
    // A vertical stack against the right edge, the same shape the closed state
    // uses for "Add to Inventory / collapse", so the
    // action corner looks identical whichever state the card is in. In a
    // footer the pair is one row, Cancel first, the primary at the thumb.
    <div className={row ? "flex flex-row-reverse items-center gap-2" : "flex flex-col items-end gap-1"}>
            <button
              type="submit"
        form={formId}
              disabled={confirmMut.isPending || (!name.trim() && !item.suggested_name)}
              title={willInstall ? `${entry.label} is not set up yet: this turns it on and files the item there` : `Files the item into ${entry.label}`}
              data-testid="form-submit"
              className={row ? `${SHEET_ACTION_CLASS} bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50` : "px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white disabled:opacity-50 inline-flex items-center gap-1"}
            >
              <SheetActionLabel icon={willInstall ? <Download size={14} /> : <CheckCircle size={14} />}>
              {/* The button says what it DOES, in the contract's words: the
                  plain label files the record, the install label sets the
                  table up first. "Confirm" hid the material action, and the
                  note beside it named a button that did not exist (#3068).
                  The table's name is the title, so the label stays short
                  enough to be whole beside Cancel on a phone. */}
              {confirmMut.isPending
                ? willInstall
                  ? `Turning on ${entry.label}…`
                  : "Adding…"
                : willInstall
                  ? actionInstallAdd(entry.label)
                  : ACTION_ADD}
              </SheetActionLabel>
            </button>
            {!row && (
              <button
                type="button"
                onClick={onCancel}
                className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
              >
                Cancel
              </button>
            )}
            {onCollapse && !row && (
              <button
                type="button"
                onClick={onCollapse}
                aria-label="Collapse this item"
                title="Collapse"
                className="shrink-0 rounded-md border border-line dark:border-slate-700 p-1.5 text-faint hover:text-accent hover:border-accent transition"
              >
                <ChevronDown size={14} className="rotate-180" />
              </button>
            )}
    </div>
  );

  const inputCls =
    "w-full px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-800";

  // Rendered ONCE and placed by branch below. The slotted branch (header row)
  // and the inline branch (no slot) used to carry their own copies of both
  // of these, ~60 lines apiece, which is exactly how the two would drift.
  // The destination is a CHIP, not a labelled block. As its own block it read
  // as a separate control sitting apart from the fields, when it is simply the
  // first thing you choose about this item. Same shell, same label treatment.
  const destinationChip = (
    <div className="flex flex-wrap items-center gap-2">
    <NewFromTemplateButton args={{ kind: `${entry.module}:${baseKind(entry.module)}`, instance: entry.instance ?? undefined, scanItemId: item.id, seed: { name, ...(locationId ? { location_id: locationId } : {}) } }} />
    <label className="inline-flex items-baseline gap-1.5 max-w-full rounded-lg border px-2 py-1 cursor-pointer transition border-line/70 dark:border-slate-700/70 bg-subtle/50 dark:bg-slate-800/50 hover:border-cobble-400 dark:hover:border-cobble-600">
      <span className="shrink-0 text-[10px] uppercase tracking-wide text-faint">Add to</span>
      <select
        value={selKey}
        onChange={(e) => {
          const k = e.target.value;
          userPickedDest.current = true;
          setSelKey(k);
          onPickDestination?.(k);
          // Switching to a table the matchmaker already extracted for →
          // merge its field values in (typed values keep winning where
          // the user edited a key the candidate also fills).
          const cand = candidates.find((c) => entryKey(c.module, c.instance) === k);
          if (cand && Object.keys(cand.fields).length) {
            // Only what the table it is being filed into actually has.
            const live = fieldsStillOnTable((menu ?? []).find((m) => entryKey(m.module, m.instance ?? null) === k), cand.fields);
            custom.seedUnder(live);
          }
        }}
        // Full width is a phone constraint, not a desktop one. A destination
        // reads in a few words, so on a wide form it only needs to be as wide
        // as its longest option; stretching it across the form makes it look
        // like the page's main input, which it is not now that the fields
        // beside it are chips.
        className="bg-transparent border-0 p-0 pr-1 text-sm outline-none max-w-[16rem] cursor-pointer"
      >
        {entries.map((m) => {
          const wi = (m as { bundle_external_id?: string }).bundle_external_id;
          return (
            <option key={entryKey(m.module, m.instance)} value={entryKey(m.module, m.instance)}>
              {m.label}
              {m.instance ? "" : ` (${m.noun})`}
              {wi ? " · not set up yet" : ""}
            </option>
          );
        })}
      </select>
    </label>
    </div>
  );
  // The list rendering: every field the table has, as a labelled input. The
  // location keeps its drawer (a picker is not a text box); the builtins and
  // the table's own fields share one grid.
  // Every dropdown on the form grows through the field's own door; a role
  // the server would refuse sees no entry (#2982).
  const choiceDoor = { slug: activeSlug, entityKind: entry.kind ?? null, canAdd: canGrowChoices(activeOrg?.role) };
  // A server change to a field the person is on, held and offered (#2982).
  const held: Array<{ key: string; label: string; theirs: string; useTheirs: () => void; keepMine: () => void }> = [];
  if (nameF.theirs !== null) held.push({ key: "name", label: fieldLabel("name", "Name"), theirs: nameF.theirs, useTheirs: takeTheirName, keepMine: nameF.keepMine });
  if (categoryF.theirs !== null && byNameAxis) held.push({ key: "category_axis", label: byNameAxis.label, theirs: categoryF.theirs, useTheirs: categoryF.useTheirs, keepMine: categoryF.keepMine });
  if (manufacturerF.theirs !== null) held.push({ key: "manufacturer", label: fieldLabel("manufacturer", "Brand"), theirs: manufacturerF.theirs, useTheirs: manufacturerF.useTheirs, keepMine: manufacturerF.keepMine });
  if (serialF.theirs !== null) held.push({ key: "serial_number", label: fieldLabel("serial_number", "Serial no."), theirs: serialF.theirs, useTheirs: serialF.useTheirs, keepMine: serialF.keepMine });
  if (quantityF.theirs !== null) held.push({ key: "quantity", label: "Qty", theirs: String(quantityF.theirs), useTheirs: quantityF.useTheirs, keepMine: quantityF.keepMine });
  for (const [k, v] of Object.entries(custom.theirs)) {
    held.push({ key: k, label: (entry.fields ?? []).find((x) => x.name === k)?.label ?? k, theirs: v == null ? "" : String(v), useTheirs: () => custom.useTheirs(k), keepMine: () => custom.keepMine(k) });
  }
  const heldNote = (h: (typeof held)[number], withLabel: boolean) => (
    <div key={h.key} data-held={h.key} className="flex flex-wrap items-baseline gap-x-2 text-xs text-amber-800 dark:text-amber-200">
      <span>
        {withLabel ? `${h.label} updated` : "Updated"} underneath: &ldquo;{h.theirs || "empty"}&rdquo;
      </span>
      <button type="button" onClick={h.useTheirs} className="font-medium underline underline-offset-2">Use theirs</button>
      <button type="button" onClick={h.keepMine} className="font-medium underline underline-offset-2">Keep mine</button>
    </div>
  );
  // The list layout says it under the field itself; the chips say it under the row.
  const heldUnder = (key: string) => {
    const h = held.find((x) => x.key === key);
    return h ? heldNote(h, false) : null;
  };
  const heldNotes = held.length ? <div data-testid="held-notes" className="space-y-1">{held.map((h) => heldNote(h, true))}</div> : null;
  // Every field on the list, built in and the table's own, laid out by the
  // one packer from what each needs (field-pack.ts, #3067): a date gets a
  // column it fits, two short selects share a row, the name and the
  // location picker take the row. A hand-rolled two-column grid put an
  // iOS date input in a column it overran ("Opened" off the right edge,
  // "Best before" under "Acquired from").
  const fieldList = (
    <FieldPack
      className="gap-y-2.5"
      testId="scan-field-pack"
      items={all.map((f) => {
        const def = (entry.fields ?? []).find((x) => x.name === f.key);
        const need = fieldNeed(f.key, {
          control:
            f.key === "location" ? "location"
            : f.key === "name" ? "text"
            : def ? fieldControl({ type: def.type as FieldType, choices: def.choices ?? null })
            : f.type === "number" ? "number" : "text",
          label: f.label,
          choices: def?.choices ?? null,
          valueLength: f.key === "name" ? Math.max(41, String(f.value ?? "").length) : String(f.value ?? "").length,
        });
        return { need, node: (
          // A cell, not a <label>: the location cell holds the picker's
          // trigger, the picker and the suggestion's Put here, and a label
          // hands a tap inside it to its first control, so Put here also
          // threw the picker open (#3712). Each title labels its own control
          // by id instead.
          <div className="flex min-w-0 flex-col gap-1">
            {/* A table field's input carries its own label; the builtins get one here. */}
            {!def && (
              <label id={`scan-${item.id}-${f.key}-label`} htmlFor={f.key === "location" ? undefined : `scan-${item.id}-${f.key}`} className="text-[10px] font-medium uppercase tracking-wide text-faint">
                {f.label}
              </label>
            )}
            {f.key === "location" ? (
              <>
                <button
                  type="button"
                  onClick={() => setLocOpen((o) => !o)}
                  aria-expanded={locOpen}
                  aria-labelledby={`scan-${item.id}-${f.key}-label scan-${item.id}-${f.key}-value`}
                  className="inline-flex min-h-10 items-center gap-1.5 rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-800 px-2.5 text-left text-sm text-content dark:text-mortar-100"
                >
                  <MapPin size={13} className="shrink-0 text-accent" />
                  <span id={`scan-${item.id}-${f.key}-value`} className="truncate">{locLabel || "Choose a spot…"}</span>
                </button>
                {/* The choices open HERE, under the control that asked, not at
                    the end of the form after every other field (#2982:
                    the first choice began at y=702 in a 660px viewport). */}
                {locOpen && (
                  <div className="rounded-md border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 p-2 max-h-72 overflow-y-auto">
                    <LocationChipPicker
                      value={locationId || null}
                      onChange={(v) => {
                        setLocTouched(true);
                        setLocationId(v ?? "");
                        persistLocation.mutate(v);
                        if (v) setLocOpen(false);
                      }}
                    />
                  </div>
                )}
                {suggestedPlacement}
              </>
            ) : def ? (
              // No help paragraph under a phone input: the label says what
              // the field is, and eight paragraphs made a form a page.
              <ScanFieldInput
                def={{ name: def.name, display_label: def.label ?? def.name, type: def.type,
                       help: null, choices: def.choices ?? null, field_role: def.field_role ?? null, learns: def.learns ?? null }}
                value={customValues[def.name]}
                onChange={(v) => custom.set(def.name, v)}
                choiceDoor={choiceDoor}
                note={customValues[noteKey(def.name)]}
                onNoteChange={(v) => custom.set(noteKey(def.name), v)}
                seller={sellerFor(def)}
              />
            ) : f.key === "category_axis" && f.choices?.length ? (
              // Inventory's category is its own tree, not a field def, so it has
              // no ScanFieldInput/choiceDoor above - yet it is the ONE field a
              // scan most often needs a NEW value for (a filament spool came
              // back "Hair Color" with no visible way to coin "Filament";
              // reported 2026-09-28). The same picker table fields get, in
              // by-name mode: a typed name is the value and the confirm creates
              // it on file.
              <ScanChoiceSelect
                id={`scan-${item.id}-${f.key}`}
                slug={activeSlug}
                entityKind={entry.kind ?? null}
                fieldName="category"
                label={f.label}
                choices={f.choices}
                value={f.value}
                onChange={(v) => setChipValue("category_axis", v ?? "")}
                canAdd
                createByName
                dataField={f.key}
                className="min-h-10 w-full min-w-0 max-w-full appearance-none rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-800 px-2.5 text-sm text-content dark:text-mortar-100"
              />
            ) : (
              <input
                id={`scan-${item.id}-${f.key}`}
                type={f.type === "number" ? "number" : "text"}
                inputMode={f.type === "number" ? "numeric" : undefined}
                min={f.type === "number" ? 1 : undefined}
                data-field={f.key}
                value={f.value}
                placeholder={f.placeholder ?? ""}
                list={f.choices?.length ? `field-choices-${item.id}-${f.key}` : undefined}
                onChange={(e) => setChipValue(f.key, e.target.value)}
                onBlur={f.key === "name" ? flushName : undefined}
                className="min-h-10 w-full min-w-0 max-w-full appearance-none rounded-md border border-line dark:border-slate-600 bg-surface dark:bg-slate-800 px-2.5 text-sm text-content dark:text-mortar-100"
              />
            )}
            {!def && f.key !== "location" && f.key !== "category_axis" && f.choices?.length ? (
              <datalist id={`field-choices-${item.id}-${f.key}`}>
                {f.choices.map((c) => <option key={c} value={c} />)}
              </datalist>
            ) : null}
            {heldUnder(f.key)}
          </div>
        ) };
      })}
    />
  );
  const fieldChips = (dense: boolean) => (
    <>
    <ChipFields
      dense={dense}
      fields={chipFields}
      available={chipAvailable}
      onChange={setChipValue}
      renderEditor={(f) => {
        // Inventory's by-name category axis has no field def, but it gets the
        // same picker table fields do - the chip's own datalist could suggest
        // but never announced you could coin one (reported 2026-09-28).
        // By-name mode: the confirm creates it on file.
        if (f.key === "category_axis" && f.choices?.length) {
          return (
            <ScanChoiceSelect
              slug={activeSlug}
              entityKind={entry.kind ?? null}
              fieldName="category"
              label={f.label}
              choices={f.choices}
              value={f.value}
              onChange={(v) => setChipValue("category_axis", v ?? "")}
              canAdd
              createByName
              dataField={f.key}
              className={fieldPackControlClass + " px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-800"}
            />
          );
        }
        const def = (entry.fields ?? []).find((x) => x.name === f.key);
        if (!def) return null;
        // A choice field is hosted too, so the chip edits through the one picker (#2982, #4516).
        const rich = def.type === "boolean" || wantsSwatch({ ...def, display_label: f.label } as never) || !!def.help || (!!def.choices?.length && choiceDoor.canAdd);
        if (!rich) return null;
        return (
          <ScanFieldInput
            def={{ name: def.name, display_label: def.label ?? def.name, type: def.type,
                   help: def.help ?? null, choices: def.choices ?? null, field_role: def.field_role ?? null, learns: def.learns ?? null }}
            value={customValues[def.name]}
            onChange={(v) => custom.set(def.name, v)}
            choiceDoor={choiceDoor}
            note={customValues[noteKey(def.name)]}
            onNoteChange={(v) => custom.set(noteKey(def.name), v)}
            seller={sellerFor(def)}
            hideLabel
          />
        );
      }}
      onAdd={(k) => setAddedFields((prev) => (prev.includes(k) ? prev : [...prev, k]))}
      onDrop={(k) => setAddedFields((prev) => prev.filter((x) => x !== k))}
    />
    {heldNotes}
    </>
  );

  return (
    <>
    <form
      id={formId}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() && !item.suggested_name) return;
        confirmMut.mutate();
      }}
      // With the fields and the commit pair portalled up into the card, what
      // is LEFT in this element is conditional: the install explainer, the AI-off
      // hint, the location drawer, the admin eval box. For most users at most
      // moments that is nothing - and an empty form still spent its spacing
      // (measured: 61px below the strip on a card that showed no such thing).
      // Its children carry their own gap, so it carries none.
      className="empty:hidden [&>*+*]:mt-3"
    >
      {/* The selected destination is a bundle this workspace doesn't have yet
          (a scanned VIN → "Vehicles"). It's the DEFAULT + leads the picker, its
          fields render editable + pre-filled below, and Confirm creates its table
          first. A slim note makes that clear; picking another table opts out. */}
      {willInstall && (
        <div className="flex items-start gap-2 rounded-lg border border-accent/50 bg-accent/[0.06] dark:bg-accent/10 p-3 text-xs text-muted dark:text-slate-400">
          <Sparkles size={14} className="text-accent shrink-0 mt-0.5" />
          <span>
            You don't have <span className="font-semibold text-content dark:text-mortar-100">{entry.label}</span> yet - {" "}
            <strong>{actionInstallAdd(entry.label)}</strong> turns it on (its own table and menu entry) and files this in, with the fields below. Want to
            track it another way? Pick a different table in <em>Add to</em>.
          </span>
        </div>
      )}
      {parentConfig && (
        <ParentTypeCard
          slug={activeSlug}
          menu={menu}
          parent={parentConfig}
          values={{ ...customValues, manufacturer }}
          childNoun={entry.noun}
        />
      )}
      {/* Destination and fields SHARE a row. Stacked, they used about a
          third of a full-width form and left the rest of the panel empty,
          while the card grew taller for content that already had room. It
          WRAPS, which is why this is not the right-rail attempt that was
          reverted: a full-width row can fall back to stacking, a fixed
          rail cannot. */}
      {fieldsLayout === "list" ? (
        <div className="space-y-3">
          <div>{destinationChip}</div>
          {fieldList}
        </div>
      ) : fieldSlot ? createPortal(
        // In the header row the destination is the card's own pill, so only
        // the chips go up - at the pill row's chip scale, no wrapper.
        <div className="contents">{fieldChips(true)}</div>,
        fieldSlot,
      ) : (
        <div className="flex flex-wrap items-start gap-x-5 gap-y-3">
          <div className="shrink-0">{destinationChip}</div>
          <div className="flex-1 min-w-[18rem]">{fieldChips(false)}</div>
        </div>
      )}
      {/* The location DRAWER stays exactly as it was: its chip above is only the
          trigger. A picker is not a text box and forcing it into one would lose
          the rooms-and-bins grid the bulk bar and camera also use. */}
      {/* The AI-off hint the name block used to carry: still the moment it is
          worth saying, since a scan with no name at all is what it explains. */}
      {!item.suggested_name && <AiOffMissHint status={aiStatus} />}
      {hasLocations && locOpen && fieldsLayout !== "list" && (() => {
        const drawer = (
          <div className="rounded-md border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 p-2 max-h-72 overflow-y-auto">
            <LocationChipPicker
              value={locationId || null}
              onChange={(v) => {
                setLocTouched(true);
                setLocationId(v ?? "");
                persistLocation.mutate(v);
                if (v) setLocOpen(false);
              }}
            />
          </div>
        );
        // Under the chip that opened it. Portalled rather than moved, because the
        // form owns the picker's state and its submission; only where it draws
        // changes.
        return locSlot
          ? createPortal(<div className="px-3 pb-3">{drawer}</div>, locSlot)
          : drawer;
      })()}
      {fieldsLayout !== "list" && suggestedPlacement && !locOpen && (locSlot ? createPortal(<div className="px-3 pb-2">{suggestedPlacement}</div>, locSlot) : suggestedPlacement)}
      {isAdmin && fieldsLayout !== "list" && (
        <div className="rounded border border-dashed border-line dark:border-slate-700 p-2 space-y-2">
          <label className="flex items-center gap-2 text-sm text-content cursor-pointer">
            <input
              type="checkbox"
              checked={saveEvalCase}
              onChange={(e) => setSaveEvalCase(e.target.checked)}
            />
            Save as matchmaker eval case
          </label>
          {saveEvalCase && (
            <input
              type="text"
              value={evalNote}
              onChange={(e) => setEvalNote(e.target.value)}
              placeholder="Note / hard-case label (optional)"
              className={inputCls}
            />
          )}
          <p className="text-[10px] text-muted dark:text-slate-400">
            Records this corrected commit (input + menu + your route/fields) as a golden case
            for the prompt-eval harness.
          </p>
        </div>
      )}
    </form>
      {actionSlot ? createPortal(commitActions, actionSlot) : (
        <div className="flex justify-end pt-1">{commitActions}</div>
      )}
    </>
  );
}

/** The minimal field-def shape the input renderer needs — satisfied by
 *  both platform field defs and the scan menu's trimmed fields. */

/** The minimal field-def shape the input renderer needs — satisfied by
 *  both platform field defs and the scan menu's trimmed fields. */
interface FieldDefLike {
  name: string;
  display_label: string;
  type: string;
  help?: string | null;
  choices?: string[] | null;
  field_role?: string | null;
  learns?: boolean | null;
}

// `wantsSwatch` (is this field a colour swatch field?) now lives in
// @cobblr/platform-web, shared with EntityThumb. Imported at the top.

/** One custom-field input on the scan-confirm form, by the field def's type
 *  (dropdown for choices, checkbox/number/date/text otherwise) + its help. */

/** One custom-field input on the scan-confirm form, by the field def's type
 *  (dropdown for choices, checkbox/number/date/text otherwise) + its help. */
function ScanFieldInput({
  def,
  value,
  onChange,
  choiceDoor,
  note,
  onNoteChange,
  seller,
  hideLabel,
}: {
  def: FieldDefLike;
  value: unknown;
  onChange: (v: unknown) => void;
  /** A dropdown grows from the form: "New <field>…" appends to the field's
   *  definition and selects it (#2982). Absent: a plain select. */
  choiceDoor?: { slug: string; entityKind: string | null; canAdd: boolean };
  /** The value's clarifier ("eBay · detroitaxle") and how to change it. */
  note?: unknown;
  onNoteChange?: (v: unknown) => void;
  /** The table's own seller field, which takes the detail over the note. */
  seller?: { name: string; label: string; value: unknown; onChange: (v: unknown) => void };
  /** The host already shows the field's name (a chip does). */
  hideLabel?: boolean;
}) {
  // A title labels ONE control by id; it never wraps the field. A label
  // around two controls (the swatch and its hex box, a dropdown that grows
  // a "new choice" box) hands a tap anywhere inside it to its first one.
  const inputId = useId();
  const s = value == null ? "" : String(value);
  if (wantsSwatch(def)) {
    return (
      <div className="block">
        <label htmlFor={inputId} className="block text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1">
          {def.display_label}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <ColourInput value={s} onPreview={onChange} onCommit={onChange} label={def.display_label} compact />
          <input
            id={inputId}
            type="text"
            data-field={def.name}
            value={s}
            onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
            placeholder="#6F8FAF"
            className="flex-1 min-w-0 px-2 py-1.5 text-sm font-mono border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-800"
          />
        </div>
        {def.help ? (
          <p className="text-[11px] text-faint dark:text-slate-500 leading-snug mt-1">{def.help}</p>
        ) : null}
      </div>
    );
  }
  const help = def.help ? (
    <p className="text-[11px] text-faint dark:text-slate-500 leading-snug mt-1">{def.help}</p>
  ) : null;
  if (def.type === "boolean") {
    return (
      <div>
        <label className="flex items-center gap-2 text-sm text-content dark:text-mortar-200 cursor-pointer">
          <input
            type="checkbox"
            data-field={def.name}
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
            className="accent-cobble-500"
          />
          {def.display_label}
        </label>
        {help}
      </div>
    );
  }
  const noteText = note == null || note === "" ? null : String(note);
  // Where a thing came from: the record page's own two-column picker, the
  // value on the left and who from on the right (#4516, #4593).
  const twoColumn = !!def.choices?.length && !!choiceDoor && (!!seller || (!!onNoteChange && offersClarifier({ ...def, type: def.type }, noteText)));
  return (
    <div className="block">
      {!hideLabel && (
        <label htmlFor={inputId} className="block text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 mb-1">
          {def.display_label}
        </label>
      )}
      {twoColumn && choiceDoor ? (
        <ChoiceField
          def={{ name: def.name, display_label: def.display_label, type: def.type, choices: def.choices ?? null, entity_kind: choiceDoor.entityKind ?? "", field_role: def.field_role ?? null, learns: def.learns ?? null }}
          kind={choiceDoor.entityKind ?? undefined}
          value={s || null}
          onCommit={(v) => onChange(v)}
          note={noteText}
          onCommitNote={onNoteChange ? (v) => onNoteChange(v) : undefined}
          detailField={seller ? { name: seller.name, label: seller.label, value: seller.value == null || seller.value === "" ? null : String(seller.value), onCommit: (v) => seller.onChange(v) } : undefined}
          className={fieldPackControlClass + " text-sm"}
        />
      ) : def.choices && def.choices.length > 0 && choiceDoor ? (
        <ScanChoiceSelect
          id={inputId}
          slug={choiceDoor.slug}
          entityKind={choiceDoor.entityKind}
          fieldName={def.name}
          label={def.display_label}
          choices={def.choices}
          value={s}
          onChange={onChange}
          canAdd={choiceDoor.canAdd}
          dataField={def.name}
          className={fieldPackControlClass + " px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-800"}
        />
      ) : def.choices && def.choices.length > 0 ? (
        <ChoiceCombobox
          id={inputId}
          dataField={def.name}
          label={def.display_label}
          value={s || null}
          options={def.choices.map((c) => ({ value: c }))}
          onCommit={(v) => onChange(v)}
          className={fieldPackControlClass + " text-sm"}
        />
      ) : (
        <input
          id={inputId}
          data-field={def.name}
          type={def.type === "number" ? "number" : def.type === "date" ? "date" : def.type === "url" ? "url" : "text"}
          step={def.type === "number" ? "any" : undefined}
          value={s}
          onChange={(e) => onChange(valueFromInput(def, e.target.value))}
          className={fieldPackControlClass + " px-2 py-1.5 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-800"}
        />
      )}
      {help}
    </div>
  );
}

/** "Awaiting lookup…", and after a few seconds why it is still waiting and
 *  the two ways out (awaitingLookup.ts). Ticks itself; nothing else on the
 *  card re-renders for it. */
function AwaitingLookupLine({
  words,
  identifyAvailable,
  onTryAgain,
  onNameIt,
  retrying,
}: {
  words: AwaitingWords;
  identifyAvailable?: boolean;
  onTryAgain: () => void;
  onNameIt: () => void;
  retrying: boolean;
}) {
  if (!words.offerWaysOut) return <span className="text-faint italic" data-testid="awaiting-lookup">{words.line}</span>;
  return (
    <span className="text-muted" data-testid="awaiting-lookup">
      {words.line}{" "}
      {identifyAvailable !== false && (
        <>
          <button
            type="button"
            className="underline hover:text-content"
            disabled={retrying}
            onClick={(e) => {
              e.stopPropagation();
              onTryAgain();
            }}
            data-testid="awaiting-try-again"
          >
            Try again
          </button>{" "}
          or{" "}
        </>
      )}
      <button
        type="button"
        className="underline hover:text-content"
        onClick={(e) => {
          e.stopPropagation();
          onNameIt();
        }}
        data-testid="awaiting-name-it"
      >
        {identifyAvailable !== false ? "name it yourself" : "Name it yourself"}
      </button>
    </span>
  );
}
