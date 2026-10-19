import type { ReceiptReadFailure } from "@cobblr/platform-contract/scan-session";
import type { AiFallback } from "@cobblr/platform-contract/scan-fallback";
import type { ProviderReason } from "@cobblr/platform-contract/provider-reason";
import type { ScanToolHints } from "@cobblr/platform-contract/scan-tools";
import type { SourceConflict } from "@cobblr/platform-contract/acquisition-source";
import { filed, idsThatFitAUrl, lookupInBody, request, upload } from "./client";
import type { PersonalDocumentRead } from "@cobblr/platform-contract/personal-documents";
import type { StationActionRun, StationLookup, StationMove, StationRecordNow, StationSettings, StationStockOp } from "@cobblr/platform-contract/station-screen";
import type { ScanCountReason } from "@cobblr/platform-contract/scan-count";
import { scopeForResolve } from "../scanScope";

/** One value a document filled on a record. */
export interface PaperworkFill {
  field: string;
  label: string;
  native: boolean;
  value: string | number;
  shown: string;
}
/** A field where the document and the record disagree; nothing was written. */
export interface PaperworkConflict {
  field: string;
  label: string;
  native: boolean;
  document: string | number;
  current: unknown;
  shown_document: string;
  shown_current: string;
}
/** A value the paper read that failed its check: shown under "Please
 *  check", written nowhere (#4633). `field` is null when no field takes it. */
export interface PaperworkHeld {
  field: string | null;
  label: string;
  native: boolean;
  check: string;
  document: string | number;
  shown_document: string;
}

export type PaperworkResult =
  | {
      read: true;
      document: "bill-of-sale" | "receipt";
      from: string | null;
      total: number | null;
      order_id: string | null;
      purchases_off: boolean;
      filled: PaperworkFill[];
      conflicts: PaperworkConflict[];
      held?: PaperworkHeld[];
      /** The document AI could not read it now: busy, or its limit is used up. */
      waiting?: "busy" | "limit" | null;
    }
  | { read: false; reason: string };

export interface OrderLineSlots {
  line_id: string;
  name: string | null;
  count: number;
  mode: "same" | "different";
  received: number;
  sentence: string;
  units: Array<{ id: string; name: string | null; image_file_id: string | null }>;
}

/** A scan session (batch) as the inbox list reports it beside its rows. */
export interface ScanBatchMeta {
  label: string | null;
  origin: string | null;
  /** Who an emailed receipt came from, and the shop the read found
   *  (platform-contract scan-source: the document's name and the header's
   *  "Emailed from"). */
  origin_from?: string | null;
  vendor?: string | null;
  source_file_id: string | null;
  order_ref: string | null;
  /** The purchase this session's order was filed on. */
  purchases_order_id?: string | null;
  tracking_number: string | null;
  shipment_state: string | null;
  shipment_description: string | null;
  shipment_location: string | null;
  /** The receipt read as a state on the session (platform-contract scan-session). */
  read_state?: "in_flight" | "read" | "failed" | null;
  read_failure?: ReceiptReadFailure | null;
  read_started_at?: string | null;
  created_at?: string | null;
  /** Which way round the receipt's numeric date was read, and by what
   *  (core-scan receipt-date.ts, #2917). */
  date_convention?: "mdy" | "dmy" | null;
  date_decided_by?: "unambiguous" | "receipt" | "workspace" | "nearest-past" | "model" | null;
  date_printed?: string | null;
  /** The session's lines over every row, not the loaded page (#3638). */
  lines?: { pending: number; ever: number };
  /** A receipt read while Purchases was off, not yet kept as a purchase
   *  (#3869): the session offers to turn Purchases on and record it. */
  purchase_pending?: boolean;
}

/** A bill of sale filed from the personal path (#5331). */
export interface BillOfSaleFiled {
  /** Who read it: code, a local model, or the cloud connection the workspace's owner chose. */
  read_by: "code" | "local-ai" | "cloud-ai";
  sent_to?: string;
  batch_id?: string | null;
  items?: Array<{ id: string }>;
  purchase?: { recorded: boolean; purchases_off: boolean } | null;
  /** Where the original went: the Vault folder of whoever filed it, or why not. */
  vault?: { kept: true; folder: string } | { kept: false; why: string };
}

/** One web-image candidate (the universal photo-picker strip). */
/** A picture suggested for a record made without one (#3818). */
export interface PhotoSuggestion {
  entity_kind: string;
  entity_id: string;
  /** "queued" while it is still being looked for; "none" when it was looked
   *  for and nothing was found. */
  status: "queued" | "suggested" | "none";
  image_path: string | null;
  query: string | null;
}

export interface ImageOption {
  url: string;
  thumb: string;
  title: string;
  source: string;
}

export interface ScanCandidate {
  module: string;
  instance: string | null;
  kind: string;
  label: string;
  confidence: number;
  name: string;
  fields: Record<string, string | number | boolean>;
  /** The grouping-axis value, snapped onto the table's existing vocabulary when
   *  one matched. `category_is_new` means the model proposed a label the table
   *  does not have yet - nothing is created until the item is filed. */
  category?: string;
  category_is_new?: boolean;
  /** Top candidate only: terse reconciliation of all the item data. */
  notes?: string;
  /** Unit count when the item data implies one ("1 Pack Of 9 Skein"). */
  quantity?: number;
  /** Field names in `fields` completed from the model's knowledge of a confident
   *  known entity (a book's ISBN/publisher/year), not read off the photo — so the
   *  UI can flag them for a double-check. */
  inferred?: string[];
  /** Capture-first: set when this routes to a not-yet-installed flagship
   *  bundle — the bundle to materialize. */
  bundle_external_id?: string;
  /** Produced without a model call (the keyword floor) — rendered honestly. */
  heuristic?: true;
  /** How a non-AI candidate earned its route: "noun" (names what the item is),
   *  "keywords" (corroborating hits only — tentative, no one-tap Add, skipped
   *  by File all), "fallback" (the honest catch-all + category). */
  basis?: "noun" | "keywords" | "fallback";
  /** Why the keyword floor routed this instead of the model (the router's own
   *  answer, scan-fallback): the chip says the matching sentence. */
  ai_fallback?: AiFallback;
  /** On a provider error, the provider's own reason (the card says what to do). */
  ai_fallback_reason?: ProviderReason;
}

/** One field on a scan-menu table (a trimmed field def). */
/** What Ran out did (#6526): it is at none, and whether it reached the list. */
export interface ScanRanOutAnswer {
  took: boolean;
  on_list: boolean;
  /** The list asked which list it goes on (none chosen yet). */
  needs_list: boolean;
  note: string | null;
}

export interface ScanMenuField {
  name: string;
  label: string;
  type: string;
  help?: string;
  choices?: string[];
  /** What the field means, when the table says (acquired-from, seller). */
  field_role?: string;
  /** A typed value becomes a choice for next time (#4516). */
  learns?: boolean;
}

/** One routable destination in the workspace scan menu — an enabled
 *  instance ("Yarn") or a module's default table. Mirrors core-scan's
 *  ScanMenuEntry (services/matchmaker.ts). */
export interface ScanMenuEntry {
  module: string;
  instance: string | null;
  kind: string;
  noun: string;
  label: string;
  fields: ScanMenuField[];
  /** This table's declared GROUPING AXIS (`field_role: "category"`) and the
   *  workspace's existing vocabulary for it. Declared, so the UI never has to
   *  guess which field is the category by matching values. */
  category_field?: {
    /** The custom field the category is written under. ABSENT for a table
     *  whose module keeps its own categories (inventory's tree): there the
     *  category travels by name as the confirm body's `category`. */
    name?: string;
    label: string;
    values: string[];
  };
  /** Domain routing terms a bundle declared for this table. */
  scan_keywords?: string[];
  /** This kind is tracked ONE BY ONE (its declared traits include `unique` — a
   *  vehicle, a machine). Two captures of it combine as a detail-merge, never a
   *  quantity sum. */
  unique?: boolean;
}

/** A rule in the external-QR resolver redirect table. See
 *  docs/design-decisions/external-qr-resolver.md. */
export interface ScanQrRule {
  id: string;
  name: string;
  enabled: boolean;
  position: number;
  match: { type: "url_prefix" | "url_base" | "regex" | "bare"; value?: string };
  extract: {
    source?: "path_segment_after_prefix" | "capture_group" | "whole_value";
    group?: string | number;
    type_from?: string | number;
    transform?: Array<"trim" | "strip_leading_zeros" | "lowercase">;
  };
  resolve: { target_kind?: string; type_map?: Record<string, string>; key_field: string };
  /** The last 30 days: scans this rule matched, and how many of them named
   *  more than one thing (#6892). */
  stats_30d?: { scans: number; ambiguous: number };
  created_at: string;
  updated_at: string;
}

/** Outcome of resolving a foreign scan against the redirect table. */
export interface ScanResolveCandidate {
  entity_kind: string;
  entity_id: string;
  entity_label: string;
  detail_path: string;
  rule_id: string;
  rule_name: string;
  /** The record this candidate is a unit of: the picker's "only this from
   *  now on" (#6892). */
  scope?: { within?: { kind: string; id: string; title: string } };
}

/** How the session's scan scope decided a resolve: `outside` when nothing
 *  it holds matched, so every match is shown. */
export interface ScanResolveScopeNote {
  applied: boolean;
  outside: boolean;
}

export type ScanResolveOutcome = ({ scope?: ScanResolveScopeNote }) & (
  | {
      outcome: "resolved";
      rule_id: string;
      rule_name: string;
      entity_kind: string;
      entity_id: string;
      entity_label: string;
      detail_path: string;
    }
  | {
      /** The key names several entities; the resolver refuses to pick. */
      outcome: "ambiguous";
      key: string;
      candidates: ScanResolveCandidate[];
      truncated: boolean;
    }
  | {
      outcome: "recognized_no_match";
      rule_id: string;
      rule_name: string;
      key: string;
      target_kind: string | null;
    }
  | { outcome: "no_rule" });

/** A session theme (core-scan services/session-theme.ts): the items it is
 *  about, and each change with the ids it would touch. */
export interface ScanSessionThemeAnswer {
  items: Array<{ id: string; name: string | null }>;
  tag: string | null;
  tag_item_ids: string[];
  category: { value: string; item_ids: string[] } | null;
}

/** The scanner queue over every pending scan (core-scan
 *  services/scanner-queue.ts): the counts the dashboard reads and the exact
 *  ids each group's button files. */
export interface ScannerQueueSummary {
  scanned_total: number;
  groups: Array<{
    key: string;
    label: string;
    bundle_external_id?: string;
    target?: { module: string; kind: string; instance?: string };
    item_ids: string[];
    /** The scans that add to a record already in this table, by item id. */
    updates?: Record<string, { kind: string; id: string; instance: string | null }>;
  }>;
  residual: number;
  /** Scans with a home the Inbox holds for a person: never in an Add all. */
  held?: number;
  offered: number;
}

/** The Scan Inbox's counts over EVERY pending row (core-scan
 *  services/inbox-counts.ts), optionally one session's. The header, the
 *  filters and their captions read these, never the length of a loaded page
 *  (#3598, #3638). */
export interface ScanInboxCounts {
  pending: number;
  unfiled: number;
  ready: number;
  ready_to_file?: number;
  needs_review?: number;
  waiting?: number;
  loose_ids?: string[];
  failed_reads?: number;
  failed_sessions?: number;
}

/** A catalog entry a scan could be (core-scan services/catalog-match.ts). */
export interface ScanCatalogCandidate {
  id: string;
  title: string;
  subtitle: string | null;
  image: string | null;
  catalog: string;
  external_id: string;
  basis: "part-number" | "name" | "ai";
}

export interface ScanInboxItem {
  /** Where the row goes, as its card says: the server's one destination
   *  (core-scan services/destination.ts). Read this, never the raw top
   *  candidate, for the table a surface names or files into (#3618). */
  resolved_destination?: { module: string; instance: string | null; kind: string | null; label: string | null; bundle_external_id: string | null } | null;
  id: string;
  status: "pending" | "enriching" | "resolved" | "discarded";
  source_kind: "barcode" | "photo" | "url" | "receipt" | "note";
  barcode_text: string | null;
  source_url: string | null;
  image_file_id: string | null;
  catalog_image_file_id: string | null;
  /** A split child's group shot (the parent's own photo), served on the child
   *  so the pictures resolver lists it beside the crop (#3046). */
  group_image_file_id?: string | null;
  catalog_image_url: string | null;
  suggested_name: string | null;
  suggested_manufacturer: string | null;
  suggested_sku: string | null;
  suggested_metadata: Record<string, unknown>;
  /** Ranked matchmaker routing candidates (which table + filled fields). */
  suggested_candidates: ScanCandidate[];
  ai_notes: string | null;
  ai_confidence: string | null;
  /** Which item tools this row could need, with the reason each is folded
   *  (the contract's scan-tools rule, served on every row; #3006). */
  tool_hints?: ScanToolHints;
  /** Where the row says it was acquired against what its purchase evidence
   *  says, when the two disagree (acquisition-source.ts, #3008). Null when
   *  nothing to compare or the two agree. */
  source_conflict?: SourceConflict | null;
  ai_suggested_at: string | null;
  target_module: string | null;
  target_kind: string | null;
  target_entity_id: string | null;
  target_location_id: string | null;
  /** Suggested home from where similar items live; the review UI offers a one-tap accept. */
  suggested_location_id: string | null;
  suggested_location_note: string | null;
  scan_batch_id: string | null;
  scan_area: string | null;
  quantity: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

/** Guided Organize (docs/product/guided-organize.md): a batch put-away plan. */
export type OrganizeDestination =
  | { kind: "existing"; location_id: string; location_name: string; location_path: string }
  | { kind: "new"; name: string; parent_id: string | null; parent_name: string | null }
  | { kind: "unassigned" };

export interface OrganizeGroup {
  id: string;
  label: string;
  rationale: string;
  item_ids: string[];
  destination: OrganizeDestination;
  evidence?: { sibling_count: number; sample_names: string[] };
  /** Size check (declared dims only): a member's longest declared dimension
   *  exceeds the destination's max interior axis. A warning — never a
   *  silent reroute. */
  size_warning?: string;
  /** AI picked this existing bin with NO computed evidence — render as the
   *  model's suggestion (amber), never as a finding. */
  ai_guess?: boolean;
  /** Pre-filed items ("already set — just put them away"): born applied,
   *  walkable immediately, no Accept needed. */
  ready?: boolean;
}

export interface OrganizePlanResponse {
  plan_id: string;
  expires_at: string;
  /** This plan was produced with a user hint (provenance for the plan line). */
  draft_hinted?: boolean;
  /** The carried session hint's text (visible + clearable on the plan line). */
  hint_text?: string;
  /** Groups pre-accepted at plan time (ready groups). */
  applied_group_ids?: string[];
  groups: OrganizeGroup[];
  already_filed_item_ids: string[];
  needs_review_item_ids: string[];
  census_truncated: boolean;
  source: "ai" | "heuristic";
  /** "inbox" (pending scans) or "entities" (Phase 3: unplaced committed things). */
  subject?: "inbox" | "entities";
  /** Display names by item id — the render fallback when the inbox no longer
   *  holds the item (entity plans, or a scan committed mid-walk). */
  item_names?: Record<string, string>;
  /** The plan's own thumbnails, so a row still shows a picture once its
   *  item has left the caller's inbox query. See planItemPhotos. */
  item_photos?: Record<string, { image_file_id?: string; catalog_image_file_id?: string }>;
  /** Barcodes by item id (entity plans) — powers scan-to-confirm in the walk. */
  item_barcodes?: Record<string, string>;
}

/** The stored plan as GET /organize/plan/latest returns it (walk resume). */
export type LiveSortDirective =
  | {
      kind: "bin";
      location_id: string;
      location_name: string;
      location_path: string;
      sibling_count: number;
      sample_names: string[];
      via: "census" | "session" | "sticky";
    }
  | { kind: "catch-all"; location_id: string | null; location_name: string | null }
  | { kind: "bind-offer"; location_id: string; location_name: string; proposed_name: string };

export interface LiveSortEntry {
  id: string;
  inbox_item_id: string;
  name: string | null;
  quantity: number;
  directive: LiveSortDirective;
  status: "proposed" | "confirmed";
  confirmed_location_id?: string;
  confirmed_location_name?: string;
  /** Set when it went inside a thing that holds things, not a place. */
  confirmed_container?: { kind: string; id: string };
  bind?: { prior_name: string };
}

export interface OrganizeStoredPlan {
  plan_id: string;
  groups: OrganizeGroup[];
  already_filed_item_ids: string[];
  needs_review_item_ids: string[];
  census_truncated: boolean;
  source: "ai" | "heuristic";
  subject?: "inbox" | "entities";
  item_names?: Record<string, string>;
  /** The plan's own thumbnails, so a row still shows a picture once its
   *  item has left the caller's inbox query. See planItemPhotos. */
  item_photos?: Record<string, { image_file_id?: string; catalog_image_file_id?: string }>;
  item_barcodes?: Record<string, string>;
  applied_group_ids: string[];
  walk_state: { placed_item_ids?: string[] };
  /** The active put-away session backing walk_state (null = none started). */
  putaway_session_id?: string | null;
  /** The latest walk over this plan ended (Done was pressed). */
  walk_ended?: boolean;
  expires_at: string;
}

export interface OrganizeApplyResponse {
  applied_group_ids: string[];
  /** Items whose record now exists (the api filed them through the confirm door). */
  filed_item_ids: string[];
  /** Items given the destination by this apply, filed or not. */
  assigned_item_ids?: string[];
  /** The filing's own result, per item: the record that now exists. */
  filed?: Array<{ item_id: string; name: string; entity_id: string | null; entity_kind: string | null }>;
  /** Items that got their destination but could not be filed, and why. */
  assigned_only?: Array<{ item_id: string; name: string | null; reason: string }>;
  created_locations: Array<{ id: string; name: string; group_id: string }>;
  skipped: Array<{ group_id: string; reason: string }>;
}

/** One bin of a put-away walk, as the api assembled it from every plan in play. */
export interface PutawayWalkGroup {
  plan_id: string;
  group_id: string;
  label: string;
  item_ids: string[];
  location_id: string;
  location_name: string;
  location_path: string;
}
export interface PutawayLeftOut {
  plan_id: string;
  group_id: string;
  label: string;
  reason: string;
}

/** "Already tracked" — an existing entity matching a scan (by barcode or name). */
/** One line of the File everything plan, as the route returns it. */
export type AutofilePlanLine =
  | { action: "attach"; itemId: string; name: string | null; to: { kind: string; id: string; title: string; instance?: string | null; matched_by?: string | null; qty?: number | null }; qty: number; why: string }
  | { action: "create"; itemId: string; name: string | null; destination: string | null; installs?: string | null; qty: number; why: string }
  | { action: "skip"; itemId: string; name: string | null; why: string };
export interface AutofileSummary {
  attached: number;
  created: number;
  skipped: number;
  reasons: Record<string, number>;
}
export interface AutofileDryRun {
  dry_run: true;
  plans: AutofilePlanLine[];
  total: number;
  /** More rows wait beyond the page it planned; run again for the rest. */
  more?: boolean;
  summary: AutofileSummary;
  message: string;
}
export interface AutofileResult {
  dry_run: false;
  summary: AutofileSummary;
  message: string;
  failures: Array<{ itemId: string; error: string }>;
  changed: Array<{ itemId: string; name: string | null; was: string; now: string }>;
  /** The items it acted on, for per-line undo. */
  filed: string[];
  /** Tables installed on the way, because a line needed one the workspace did not have. */
  installed?: Array<{ bundle_external_id: string; label: string }>;
}

export interface TrackedMatch {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
  image_path: string | null;
  detail_url: string | null;
  instance: string | null;
  noun: string;
  qty: number | null;
  /** The unit its amount is kept in ("m", "each"), when the record says. */
  unit?: string | null;
  location_id: string | null;
  /** The stock you already have is past its expiry date, per this kind's
   *  expiry-role field. Lets a re-purchase be recorded as waste instead of
   *  consumption without asking. */
  expired: boolean;
  matched_by: "barcode" | "name" | "bin" | "identifier";
  /** For an identifier match, the field's label ("ISBN"). */
  matched_label?: string | null;
  /** The thing this record is a place of (its own id when kept in one place). */
  card_id?: string;
}

/** One place the matched thing is kept, for "which one does this go to". */
export interface TrackedPlace {
  id: string;
  location_id: string | null;
  location_name: string | null;
  qty: number | null;
}

/** A record action a Station offers on a known thing (#4640). */
/** A scanned code's record in this workspace, answered from its own records. */
export interface ScanKnownCode {
  title: string;
  kind: string;
  id: string;
  instance: string | null;
  qty: number | null;
  unit: string | null;
  image_path: string | null;
}

export interface StationRecordAction {
  id: string;
  label: string;
  icon: string | null;
  description: string | null;
  args_schema: Record<string, import("@cobblr/platform-contract/action-args").ActionArgSpec> | null;
  group: string | null;
  primary: boolean;
}

export const scanApi = {
  /** Auto-fetch a web image for an entity (e.g. a 3D printer) and set its
   *  image_path. Pass `image_url` to store a SPECIFIC user-picked image instead
   *  of auto-searching. Returns the resolved image_path. */
  /** Fetch + store an image for an entity. OMIT `query` and the server derives
   *  the phrase from the entity itself (same derivation as the picker) — hand-
   *  built phrases are how Auto and the web search drifted apart. */
  enrichEntityImage: (
    slug: string,
    body: {
      entity_kind: string;
      entity_id: string;
      query?: string;
      instance?: string | null;
      image_url?: string;
      shown_url?: string;
      file_id?: string;
      /** A picked image_url: chosen by the person or by AI Pick, where it was found, and why. */
      source?: "web" | "ai_pick";
      source_page?: string;
      searched?: string;
      reason?: string;
    },
  ) =>
    // `reason` says why, in words, when no picture was kept. A picture made
    // the main photo says what the record had (`previous_image_path`, for
    // Undo); that one stays in the record's photos.
    request<{ image_path: string | null; previous_image_path?: string | null; file_id?: string; reason?: string }>("POST", `/orgs/${slug}/modules/core-scan/entity-image`, body),
  /** Make one of a record's photos its main photo, or put back the one it had
   *  (Undo). The photo it replaces stays in the record's photos. */
  setMainPhoto: (slug: string, body: { entity_kind: string; entity_id: string; instance?: string | null; file_id?: string; image_path?: string | null }) =>
    request<{ image_path: string | null; previous_image_path: string | null }>("POST", `/orgs/${slug}/modules/core-scan/entity-image/main`, body),
  /** The scan inbox's Pick best, for a record: the AI chooses among the
   *  pictures on screen that show the record. Runs only when pressed. */
  rankRecordPhotoAi: (slug: string, body: { entity_kind: string; entity_id: string; candidates: ImageOption[] }) =>
    request<{ chosen_url: string | null; reason: string }>("POST", `/orgs/${slug}/modules/core-scan/entity-image/rank-ai`, body),
  /** Pictures the platform suggested for records made without one (#3818):
   *  the ones waiting for an answer, still being looked for, or not found. */
  photoSuggestions: (slug: string, kind: string | null, ids?: string[]) =>
    lookupInBody<{ items: PhotoSuggestion[] }>(
      `/orgs/${slug}/modules/core-scan/photo-suggestions/lookup`,
      { ...(kind ? { kind } : {}), ...(ids?.length ? { ids } : {}) },
      () => {
        const p = new URLSearchParams();
        if (kind) p.set("kind", kind);
        // id-list-in-url: the older api's door only, trimmed to fit by idsThatFitAUrl.
        if (ids?.length) p.set("ids", idsThatFitAUrl(ids).join(","));
        return `/orgs/${slug}/modules/core-scan/photo-suggestions?${p.toString()}`;
      },
    ),
  usePhotoSuggestion: (slug: string, kind: string, id: string) =>
    request<{ ok: true; image_path: string }>("POST", `/orgs/${slug}/modules/core-scan/photo-suggestions/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/use`),
  searchPhotoFor: (slug: string, kind: string, id: string) =>
    request<{ ok: true }>("POST", `/orgs/${slug}/modules/core-scan/photo-suggestions/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/search`),
  declinePhotoSuggestion: (slug: string, kind: string, id: string) =>
    request<{ ok: true }>("POST", `/orgs/${slug}/modules/core-scan/photo-suggestions/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/decline`),
  /** Whether this workspace looks up photos for its records at all (off until
   *  it turns it on, #7447), and whether the top match is put on the record. */
  photoSuggestConfig: (slug: string) => request<{ suggest_on: boolean; auto_apply: boolean }>("GET", `/orgs/${slug}/modules/core-scan/photo-suggest-config`),
  setPhotoSuggestConfig: (slug: string, patch: { suggest_on?: boolean; auto_apply?: boolean }) =>
    request<{ suggest_on: boolean; auto_apply: boolean }>("PUT", `/orgs/${slug}/modules/core-scan/photo-suggest-config`, patch),
  /** Fill in the missing pictures across a whole collection in one press — the
   *  same derived auto-fetch a single record's "Auto" runs, for every record
   *  with no image. Idempotent (a record that has one is never touched) and
   *  bounded, so pressing it again continues where it stopped. */
  backfillEntityImages: (
    slug: string,
    body: { entity_kind: string; instance?: string | null; limit?: number },
  ) =>
    request<{
      missing: number;
      started: number;
      remaining: number;
      /** Resolved, but had nothing searchable (a blank/junk name). */
      unnamed: number;
      /** Couldn't be read at all — a module wiring gap, not a data problem. */
      unresolved: number;
    }>("POST", `/orgs/${slug}/modules/core-scan/entity-image/backfill`, body),
  /** Web-image candidates for the universal photo-picker strip. Prefer `entity`:
   *  the SERVER derives the search phrase from that thing's own name/brand/fields,
   *  the same derivation the scan inbox uses, so one thing searches one way
   *  everywhere. `q` is a literal override (a user-typed term). Echoes back the
   *  phrase it actually searched. */
  imageOptions: (
    slug: string,
    opts: { q?: string; brand?: string; entity?: { kind: string; id: string } | null; fresh?: boolean },
  ) => {
    const p = new URLSearchParams();
    if (opts.q?.trim()) p.set("q", opts.q.trim());
    if (opts.brand) p.set("brand", opts.brand);
    if (opts.entity) {
      p.set("entity_kind", opts.entity.kind);
      p.set("entity_id", opts.entity.id);
    }
    if (opts.fresh) p.set("fresh", "1");
    // For a record: its last results come back remembered (no new search),
    // with the result its photo came from (`in_use_url`) and AI Pick's choice.
    return request<{ items: ImageOption[]; query?: string; throttled?: boolean; remembered?: boolean; in_use_url?: string | null; ai_url?: string | null; ai_reason?: string | null }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/image-options?${p.toString()}`,
    );
  },
  /** Make one line of a purchase (a bill of sale's add-on) an inbox item, in
   *  its receipt's session; filing it claims the line. Once per line. */
  orderLineToInbox: (slug: string, body: { order_id: string; order_item_id: string; description: string; qty: number; unit_cost: number | null }) =>
    request<{ id: string; existed: boolean }>("POST", `/orgs/${slug}/modules/core-scan/inbox/from-order-line`, body),
  /** Which lines of one purchase are already scan-inbox items. */
  orderLinesInInbox: (slug: string, orderId: string) =>
    request<{ items: Array<{ order_item_id: string; id: string }> }>("GET", `/orgs/${slug}/modules/core-scan/inbox/order-lines?order_id=${encodeURIComponent(orderId)}`),
  /** Read a document put on a record and fill the record's empty fields from
   *  it; conflicts come back to decide, fills come back to undo. */
  attachPaperwork: (slug: string, body: { file_id: string; kind: string; id: string }) =>
    request<PaperworkResult>("POST", `/orgs/${slug}/modules/core-scan/scan/paperwork`, body),
  undoPaperwork: (slug: string, body: { kind: string; id: string; fills: PaperworkFill[] }) =>
    request<{ undone: string[] }>("POST", `/orgs/${slug}/modules/core-scan/scan/paperwork/undo`, body),
  takePaperworkValue: (slug: string, body: { kind: string; id: string; field: string; native: boolean; value: string | number }) =>
    request<{ ok: true }>("POST", `/orgs/${slug}/modules/core-scan/scan/paperwork/take`, body),
  /** "It's this one": an inbox card's paper belongs to a record already here. */
  inboxItemIsThisOne: (slug: string, itemId: string, body: { kind: string; id: string }) =>
    request<PaperworkResult>("POST", `/orgs/${slug}/modules/core-scan/inbox/${itemId}/its-this-one`, body),
  /** Switch one ON: creates the fields it is missing, and only those. */
  /** Move what past receipts recorded into the preset's fresh fields. Owner/
   *  admin, same audience as the preset switch that calls it. */
  backfillReceiptFields: (slug: string) =>
    request<{ scanned: number; filled: number; dropped_facts?: number; capped_kinds?: string[] }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/receipts/backfill-fields`,
    ),

  // ─── scan-drives-screen (Phase 1) ─────────────────────────────────
  // A scan is a driver: a Cobblr QR navigates the designated tab to that
  // entity; a product barcode intakes it + surfaces the Scan inbox; nothing
  // designated → it lands in triage (driven:false). See
  // docs/design-decisions/scan-drives-screen.md.
  scanDrive: (
    slug: string,
    code: string,
    scan_batch_id?: string,
    disposition?: "navigate" | "print",
  ) =>
    request<{
      driven: boolean;
      kind: "qr" | "barcode";
      action?: "navigate" | "print";
      path?: string;
      item_id?: string;
      /** For action:"print" — the label was queued (auto-flush policy, if any, ran). */
      queued?: boolean;
    }>("POST", `/orgs/${slug}/scan-drive`, {
      code,
      ...(scan_batch_id ? { scan_batch_id } : {}),
      ...(disposition ? { disposition } : {}),
    }),
  /** `folder_id` puts it in a folder. `onDuplicate: "skip"` keeps the copy
   *  already here when the same bytes are uploaded again (`duplicate: true`
   *  and the existing file come back); otherwise a second copy is stored and
   *  `duplicate_of` names the first. */
  readPersonalDocument: (slug: string, file: File) => {
    const form = new FormData(); form.set("file", file);
    return upload<PersonalDocumentRead>(`/api/v1/orgs/${slug}/modules/core-scan/personal-documents/read`, form, file);
  },
  /** File a bill of sale's vehicle purchase from the personal path (#5331):
   *  read again on the server, filed, never stored. With `record`, it fills
   *  that vehicle instead of making an inbox item. */
  /** `vin`: the VIN the person typed when the page's would not read
   *  (#5921); the server files only on a VIN that passes its check digit. */
  fileBillOfSale: (slug: string, file: File, record?: { kind: string; id: string }, opts: { vin?: string } = {}) => {
    const form = new FormData(); form.set("file", file);
    if (record) { form.set("kind", record.kind); form.set("id", record.id); }
    if (opts.vin) form.set("vin", opts.vin);
    return upload<BillOfSaleFiled>(`/api/v1/orgs/${slug}/modules/core-scan/personal-documents/bill-of-sale`, form, file);
  },
  /** Answer a thing offered into the scan inbox. In a shared workspace,
   *  taking it moves it to `into`, a workspace of your own. */
  decideScanOffer: (slug: string, inboxId: string, decision: "taken" | "passed" | "maybe", into?: string | null) =>
    request<{ ok: true; landed?: { orgId: string; inboxId: string } }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${inboxId}/offer`, { decision, ...(into ? { into } : {}) }),
  /** In a shared workspace: offer these scans to the person who shared it. */
  offerScansToSharer: (slug: string, ids: string[]) => request<{ ok: true; offered: number }>("POST", `/orgs/${slug}/modules/core-scan/inbox/offer-to-sharer`, { ids }),

  // core-scan — the identifier-decoder registry. Hand it a typed/scanned
  // identifier (a VIN today; any registered decoder tomorrow); it dispatches by
  // the code's shape, decodes against the external source, and returns a flat
  // semantic field bag to map onto a record by role. Powers the guarded-auto
  // VIN fill on the entity form. See docs/design-decisions/vin-decode.md.
  decodeIdentifier: (slug: string, code: string) =>
    request<{
      outcome: "hit" | "partial" | "miss" | "unavailable";
      fields: Record<string, string | number>;
      provenance: string | null;
      note?: string;
    }>("POST", `/orgs/${slug}/modules/core-scan/decode`, { code }),
  lookupBarcode: (slug: string, code: string) =>
    request<import("@cobblr/platform-web").BarcodeLookup>("POST", `/orgs/${slug}/modules/core-scan/barcode-lookup`, { code }),
  scanBarcode: (
    slug: string,
    body: {
      purpose?: import("@cobblr/platform-contract/scan-triage").ScanPurpose;
      barcode?: string;
      source_kind?: "barcode" | "photo" | "url" | "receipt";
      source_url?: string;
      /** The title shared or pasted with the link: kept as the item's name. */
      shared_title?: string;
      image_file_id?: string;
      scan_batch_id?: string;
      scan_area?: string;
      target_location_id?: string;
      target_container_kind?: string;
      target_container_id?: string;
      enrich_ms?: number;
      /** Add this picture again although it was just added (#3852). */
      allow_duplicate?: boolean;
    },
  ) =>
    request<ScanInboxItem & { duplicate_of_recent?: boolean }>("POST", `/orgs/${slug}/modules/core-scan/scan`, body),
  // External QR resolver (the redirect table for foreign labels). The camera
  // reads the rules once to know whether to bother resolving; resolveExternal is
  // the synchronous "is this a known foreign QR? where does it go?" call on a
  // non-native scan. See docs/design-decisions/external-qr-resolver.md.
  scanQrRules: (slug: string) =>
    request<{ rules: ScanQrRule[] }>("GET", `/orgs/${slug}/modules/core-scan/qr-rules`),
  createScanQrRule: (slug: string, body: Omit<ScanQrRule, "id" | "created_at" | "updated_at">) =>
    request<{ rule: ScanQrRule }>("POST", `/orgs/${slug}/modules/core-scan/qr-rules`, body),
  updateScanQrRule: (slug: string, id: string, body: Partial<ScanQrRule>) =>
    request<{ rule: ScanQrRule }>("PATCH", `/orgs/${slug}/modules/core-scan/qr-rules/${id}`, body),
  deleteScanQrRule: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-scan/qr-rules/${id}`),
  reorderScanQrRules: (slug: string, ids: string[]) =>
    request<{ ok: true }>("POST", `/orgs/${slug}/modules/core-scan/qr-rules/reorder`, { ids }),
  /** Every scanning surface resolves through here, so the session's scan
   *  scope (lib/scanScope.ts, #6892) rides on every resolve without a caller
   *  having to remember it. `unscoped` is the rules page's tester, which asks
   *  about the whole workspace. */
  scanResolveExternal: (slug: string, value: string, opts: { unscoped?: boolean } = {}) => {
    const scope = opts.unscoped ? undefined : scopeForResolve(slug);
    return request<ScanResolveOutcome>("POST", `/orgs/${slug}/modules/core-scan/resolve-external`, { value, ...(scope ? { scope } : {}) });
  },
  /** The live feed: the last few CAPTURES, for a screen that is not the
   *  scanner (a watch, a bench display, a second monitor). `after` is the
   *  cursor a display holds so it can tell "nothing happened" from "I missed
   *  three"; `missed` counts what did not fit in the page. */
  scanFeed: (slug: string, q: { after?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (q.after) params.set("after", q.after);
    if (q.limit) params.set("limit", String(q.limit));
    const qs = params.toString();
    return request<{ scans: ScanInboxItem[]; cursor: string; missed: number }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/feed${qs ? `?${qs}` : ""}`,
    );
  },
  listScanInbox: (
    slug: string,
    q: {
      status?: "pending" | "enriching" | "resolved" | "discarded";
      batch_id?: string;
      limit?: number;
      cursor?: string;
      /** Ask for one FACET of the pending queue (needs_review, waiting,
       *  unfiled, ready, photo_wanted) instead of paginating the whole thing.
       *  Answered in a single capped read — see platform-contract/scan-triage. */
      triage?: string;
      /** Waiting rows whose name (as the card shows it), code or maker
       *  contains this; each carries `resolved_destination`. */
      q?: string;
      /** With `q`: only rows headed for this table (an instance's name, or a
       *  module's for its default table). */
      destination?: string;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (q.q) params.set("q", q.q);
    if (q.destination) params.set("destination", q.destination);
    if (q.status) params.set("status", q.status);
    if (q.triage) params.set("triage", q.triage);
    if (q.batch_id) params.set("batch_id", q.batch_id);
    if (q.limit) params.set("limit", String(q.limit));
    if (q.cursor) params.set("cursor", q.cursor);
    const qs = params.toString();
    return request<{
      items: ScanInboxItem[];
      /** Session labels keyed by scan_batch_id — the inbox group header + the
       *  receipt's stored original (for View original / Re-parse). */
      batches?: Record<string, ScanBatchMeta>;
      /** Receipt sessions with no rows on any page: a failed or in-flight read
       *  (the failure is a state on the session, never an item). */
      sessions?: Record<string, ScanBatchMeta>;
      /** The lines this page's parts were split from (#6067), each with how
       *  it came apart: the parent the parts sit under. */
      split_parents?: Record<string, import("../splitLayout").SplitParent>;
      next_cursor?: string | null;
      total?: number;
    }>("GET", `/orgs/${slug}/modules/core-scan/inbox${qs ? "?" + qs : ""}`);
  },
  stationScreen: (slug: string, address: string) =>
    request<{ address: string; label: string; settings: StationSettings; has_pin: boolean; device: boolean }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/stations/screens/${address}`,
    ),
  saveStationScreen: (slug: string, address: string, body: { label?: string; settings?: Partial<StationSettings>; pin?: string; new_pin?: string | null }) =>
    request<{ address: string; label: string; settings: StationSettings; has_pin: boolean }>("PUT", `/orgs/${slug}/modules/core-scan/stations/screens/${address}`, body),
  stationLookup: (slug: string, address: string, body: { code: string } | { record: { kind: string; id: string } }) =>
    request<StationLookup>("POST", `/orgs/${slug}/modules/core-scan/stations/screens/${address}/lookup`, body),
  /** A scan into the recount this station is set to (#6302): counted, new, or a question. */
  stationRecount: (slug: string, address: string, body: { code?: string; text?: string; record_id?: string; type_id?: string; new?: boolean }) =>
    request<import("@cobblr/platform-contract/station-screen").StationRecountAnswer>("POST", `/orgs/${slug}/modules/core-scan/stations/screens/${address}/recount`, body),
  /** What a decoded code already is in this workspace, from its own records
   *  only (#6436): asked the instant a code decodes, so a thing you have shows
   *  at once while the photo and the scan are still being sent. */
  scanKnown: (slug: string, code: string, purpose?: string) =>
    request<{ known: ScanKnownCode | null; inbox_row?: ScanInboxItem | null }>("GET", `/orgs/${slug}/modules/core-scan/scan/known?code=${encodeURIComponent(code)}${purpose ? `&purpose=${encodeURIComponent(purpose)}` : ""}`),
  stationCount: (slug: string, address: string, body: { request_id: string; kind: string; entity_id: string; op: StationStockOp; value?: number }) =>
    request<StationMove & { replayed?: boolean }>("POST", `/orgs/${slug}/modules/core-scan/stations/screens/${address}/count`, body),
  stationUndo: (slug: string, address: string, requestId: string) =>
    request<{ ok: true; qty: number | null }>("POST", `/orgs/${slug}/modules/core-scan/stations/screens/${address}/undo`, { request_id: requestId }),
  /** A known thing's own record actions a station offers (#4640): ones Undo can take back, on a record it keeps. */
  stationActions: (slug: string, address: string, kind: string) =>
    request<{ items: StationRecordAction[] }>("GET", `/orgs/${slug}/modules/core-scan/stations/screens/${address}/actions?kind=${encodeURIComponent(kind)}`),
  stationActionRun: (slug: string, address: string, body: { request_id: string; action_id: string; kind: string; entity_id: string; args?: Record<string, unknown> }) =>
    request<StationActionRun>("POST", `/orgs/${slug}/modules/core-scan/stations/screens/${address}/actions/run`, body),
  stationActionUndo: (slug: string, address: string, requestId: string) =>
    request<{ ok: true; now: StationRecordNow | null }>("POST", `/orgs/${slug}/modules/core-scan/stations/screens/${address}/actions/undo`, { request_id: requestId }),
  stationMove: (slug: string, address: string, body: { kind: string; entity_id: string; location_id: string }) =>
    request<{ ok: true }>("POST", `/orgs/${slug}/modules/core-scan/stations/screens/${address}/move`, body),
  stationNextScan: (slug: string, address: string) =>
    request<{ code: string | null }>("POST", `/orgs/${slug}/modules/core-scan/stations/screens/${address}/scans/next`, {}),
  getScanItem: (slug: string, id: string) =>
    request<ScanInboxItem>("GET", `/orgs/${slug}/modules/core-scan/inbox/${id}`),
  /** Re-run the receipt parser on a session's stored original, replacing its
   *  still-pending lines with a fresh parse. */
  reparseReceipt: (slug: string, batchId: string) =>
    request<{
      receipt: { item_count: number; vendor: string | null };
      items: Array<{ id: string }>;
      /** The purchase its lines are on, when there is one. */
      purchase: { recorded: boolean; purchases_off: boolean; order_number?: string | null } | null;
    }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/scan/receipt/reparse`,
      { batch_id: batchId },
    ),
  /** Set/clear a receipt session's order (invoice) number — recomputes its label. */
  setReceiptOrderRef: (slug: string, batchId: string, orderRef: string | null) =>
    request<{ id: string; label: string | null; order_ref: string | null }>(
      "PATCH",
      `/orgs/${slug}/modules/core-scan/scan/receipt/${batchId}/order-ref`,
      { order_ref: orderRef },
    ),
  /** Set/clear the tracking number for the parcel a receipt session describes.
   *  Filing a receipt that carries one records the order as still in transit,
   *  so it gets followed instead of being closed on arrival at the doorstep. */
  setReceiptTracking: (slug: string, batchId: string, trackingNumber: string | null) =>
    request<{ id: string; tracking_number: string | null }>(
      "PATCH",
      `/orgs/${slug}/modules/core-scan/scan/receipt/${batchId}/tracking`,
      { tracking_number: trackingNumber },
    ),
  /** Light in-the-moment edits the camera modal makes — quantity, name. */
  updateScanItem: (
    slug: string,
    id: string,
    body: {
      send_drop_unmapped?: boolean;
      send_unplaced?: boolean;
      quantity?: number;
      name?: string;
      target_location_id?: string | null;
      box_state?: "item-in-box" | "empty-box" | null;
      reviewed?: boolean;
      /** "Not right": the shown name is turned down for good (#3724). */
      reject_name?: true;
      /** "Not the same, keep separate": this scan is not the record the
       *  matchmaker found; it files as a new item. false withdraws it. */
      keep_separate?: boolean;
      /** Answer to "this photo has N different things — keep them together, or
       *  split?" true = one record; the offer stops asking. */
      keep_grouped?: boolean;
      /** "Treat it as one item": a receipt whose read failed stops asking to be read again (#3581). */
      read_as_item?: boolean;
      /** "I will photograph this myself." Survives an AI re-run — only the
       *  person, or the photo arriving, clears it. */
      photo_wanted?: boolean;
      /** Where the person said this goes: kept on the row as theirs, never
       *  replaced by a system suggestion (#3062). null clears the choice. */
      destination?: { module: string; instance?: string | null; kind?: string | null; label?: string | null } | null;
      /** Values typed against the destination's fields, kept on the row
       *  without filing it; null clears one. The served row carries them
       *  merged over the top candidate's fields. */
      fields?: Record<string, string | number | boolean | null>;
      /** The table the fields were typed for ("yarn:item"); absent means the
       *  top candidate's table at the time of the write. */
      fields_kind?: string;
      /** The category the person chose, by name, for a table that keeps its
       *  own categories (no field to type it into). Served back as the top
       *  candidate's `category`; null clears it. */
      category?: string | null;
    },
  ) => request<ScanInboxItem>("PATCH", `/orgs/${slug}/modules/core-scan/inbox/${id}`, body),
  /** Get the pending put-away plan ready before anyone asks for it, when
   *  there is one to make: nothing identified yet answers 204, not a refusal
   *  (#6702). */
  warmOrganizePlan: (slug: string) =>
    request<void>("POST", `/orgs/${slug}/modules/core-scan/organize/plan`, { scope: "pending", warm: true }),
  /** Guided Organize: propose a grouped put-away plan — for a selection of
   *  inbox items, or (scope:"unplaced") for committed entities with no home. */
  organizePlan: (
    slug: string,
    body: {
      item_ids?: string[];
      scan_batch_id?: string;
      scope?: "unplaced" | "pending" | "refs";
      /** For scope:"refs" — the "<kind>::<uuid>" refs to plan (a specific pile,
       *  e.g. the parts a disassemble just spawned). */
      refs?: string[];
      /** Ground truth typed by the human — folded into the AI plan call. */
      hint?: string;
      /** Bypass the draft cache (the explicit Re-plan button). */
      fresh?: boolean;
      /** Stop carrying the session hint forward. */
      clear_hint?: boolean;
    },
  ) => request<OrganizePlanResponse>("POST", `/orgs/${slug}/modules/core-scan/organize/plan`, body),
  /** Cheap inbox counts for the put-away front door (dashboard card / scan
   *  strip): pending captures, and how many still have no home. */
  getScanStats: (slug: string, batchId?: string | null) =>
    request<ScanInboxCounts>("GET", `/orgs/${slug}/modules/core-scan/inbox/stats${batchId ? `?batch_id=${encodeURIComponent(batchId)}` : ""}`),
  /** Receipt sessions imported but not yet confirmed into a purchase order. */
  getPendingReceiptGroups: (slug: string) =>
    request<{
      groups: Array<{
        groupId: string;
        vendor: string | null;
        /** Order / invoice number when the receipt stated one - what tells two
         *  receipts from the same vendor apart. */
        orderRef: string | null;
        /** The parcel's tracking number, when one has been recorded. Its
         *  presence is what files the receipt as still in transit. */
        trackingNumber: string | null;
        /** Where the parcel is, per the last carrier answer. Null when nothing
         *  has asked yet, which is not the same as "no information". */
        shipmentState: string | null;
        shipmentDescription: string | null;
        shipmentLocation: string | null;
        /** The scan session, so a caller can deep-link to this receipt. */
        batchId: string | null;
        /** The single line's name, when the receipt has exactly one. Null for a
         *  multi-line receipt, where no one item is "the parcel". */
        onlyItemName: string | null;
        count: number;
      }>;
      total_items: number;
    }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/inbox/receipt-groups/pending`,
    ),
  /** Guided Organize: accept groups (optionally overriding destinations). */
  organizeApply: (
    slug: string,
    body: {
      plan_id: string;
      group_ids: string[];
      overrides?: Array<{
        group_id: string;
        location_id?: string;
        new_location?: { name: string; parent_id?: string | null };
        /** Items split out of the group ("not related") — not filed. */
        exclude_item_ids?: string[];
      }>;
    },
  ) => request<OrganizeApplyResponse>("POST", `/orgs/${slug}/modules/core-scan/organize/apply`, body),
  /** Guided Organize: the most recent unexpired plan (put-away-walk resume). */
  /** planId set = pin that exact plan (the put-away walk asks for the plan it
   *  just applied, so a warm re-plan cannot shadow it); absent = the newest. */
  getLatestOrganizePlan: (slug: string, planId?: string) =>
    request<{ plan: OrganizeStoredPlan | null }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/organize/plan/latest${planId ? `?plan_id=${encodeURIComponent(planId)}` : ""}`,
    ),
  /** Put-away sessions (the shared execution engine): start/resume one.
   *  plan_id set = plan mode (the walk; idempotent per plan, returns the
   *  authoritative placed list). plan_id absent = LIVE mode (Live Sort;
   *  idempotent per user, returns the session's entries). */
  startPutaway: (
    slug: string,
    body: { plan_id?: string; catch_all_location_id?: string | null },
  ) =>
    request<{
      session_id: string;
      mode: "plan" | "live";
      plan_id?: string;
      catch_all_location_id?: string | null;
      placed_item_ids?: string[];
      entries?: LiveSortEntry[];
      resumed: boolean;
      /** Plan mode: the walk's queue, every accepted group still to place
       *  from every plan in play, and what was left out with the reason. */
      groups?: PutawayWalkGroup[];
      left_out?: PutawayLeftOut[];
      remaining?: number;
      item_names?: Record<string, string>;
      item_quantities?: Record<string, number>;
      item_barcodes?: Record<string, string>;
    }>("POST", `/orgs/${slug}/modules/core-scan/putaway/start`, body),
  /** What is accepted and still to be put away, across every plan in play:
   *  the resume chip's one source. */
  getPutawayQueue: (slug: string) =>
    request<{
      remaining: number;
      groups: number;
      plan_id: string | null;
      session_id: string | null;
      left_out: PutawayLeftOut[];
    }>("GET", `/orgs/${slug}/modules/core-scan/putaway/queue`),
  /** Live Sort: route an intaken inbox item → a destination directive. */
  putawayScan: (slug: string, sessionId: string, body: { inbox_item_id: string }) =>
    request<{
      entry?: LiveSortEntry;
      already_confirmed?: boolean;
      already_placed?: { location_id: string; location_name: string | null; name: string | null };
    }>("POST", `/orgs/${slug}/modules/core-scan/putaway/${sessionId}/scan`, body),
  /** Live Sort: the one confirm gesture (override location wins). */
  putawayConfirm: (
    slug: string,
    sessionId: string,
    body: { entry_id: string; location_id?: string; container?: { kind: string; id: string } },
  ) =>
    request<{ entry: LiveSortEntry }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/putaway/${sessionId}/confirm`,
      body,
    ),
  /** Live Sort: create numbered "Bin N" locations as the session's bind
   *  pool (+ optionally an "Unsorted" catch-all). Zero-hardware on-ramp. */
  setupPutawayBins: (
    slug: string,
    sessionId: string,
    body: { count: number; include_catch_all?: boolean; parent_id?: string | null },
  ) =>
    request<{
      created: Array<{ id: string; name: string }>;
      catch_all_location_id: string | null;
      bind_pool_size: number;
    }>("POST", `/orgs/${slug}/modules/core-scan/putaway/${sessionId}/setup-bins`, body),
  /** Live Sort: revert a confirm. */
  putawayUndo: (slug: string, sessionId: string, body: { entry_id: string }) =>
    request<{ entry: LiveSortEntry }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/putaway/${sessionId}/undo`,
      body,
    ),
  /** The caller's active put-away session (resume chips). */
  getPutawayCurrent: (slug: string) =>
    request<{
      session: {
        session_id: string;
        mode: "plan" | "live";
        plan_id: string | null;
        catch_all_location_id: string | null;
        entries?: LiveSortEntry[];
        placed_item_ids?: string[];
        created_at: string;
      } | null;
    }>("GET", `/orgs/${slug}/modules/core-scan/putaway/current`),
  /** Put-away sessions: persist walk progress (idempotent replace). */
  setPutawayState: (slug: string, sessionId: string, body: { placed_item_ids: string[] }) =>
    request<{ placed_item_ids: string[] }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/putaway/${sessionId}/state`,
      body,
    ),
  /** Put-away sessions: close one (fires the summary event; live sessions
   *  return the sorted/by-bin/straggler summary). */
  endPutaway: (slug: string, sessionId: string) =>
    request<{
      ended: boolean;
      placed_count?: number;
      sorted?: number;
      stragglers?: number;
      by_bin?: Array<{ location_id: string; location_name: string; count: number }>;
    }>("POST", `/orgs/${slug}/modules/core-scan/putaway/${sessionId}/end`),
  /** Fold one scan session into another (batch merge). */
  mergeScanBatches: (slug: string, fromBatchId: string, intoBatchId: string) =>
    request<{ moved: number }>("POST", `/orgs/${slug}/modules/core-scan/inbox/merge-batches`, {
      from_batch_id: fromBatchId,
      into_batch_id: intoBatchId,
    }),
  /** Move specific items into a batch — the Undo path for a merge. */
  reassignScanBatch: (slug: string, itemIds: string[], batchId: string) =>
    request<{ moved: number }>("POST", `/orgs/${slug}/modules/core-scan/inbox/reassign-batch`, {
      item_ids: itemIds,
      batch_id: batchId,
    }),
  /** Fill catalog images for pending items with no art (search by name), AND
   *  localize any item stuck on a catalog URL with no local file. */
  backfillScanCatalogPhotos: (slug: string) =>
    request<{ queued: number; localized: number }>("POST", `/orgs/${slug}/modules/core-scan/inbox/backfill-catalog-photos`),
  /** Bulk import (inbox-export interop + generic CSV). `file` is the picked File;
   *  mapping only matters for plain CSVs. */
  listScanImportRuns: (slug: string) =>
    request<{ items: Array<{ id: string; created_at: string; source_label: string | null; item_count: number; created_count: number; replaced_count: number; undone_at: string | null }> }>("GET", `/orgs/${slug}/modules/core-scan/import/runs`),
  undoScanImport: (slug: string, id: string) =>
    request<{ undone: true; run_id: string; items_removed: number; items_restored: number }>("POST", `/orgs/${slug}/modules/core-scan/import/runs/${id}/undo`, {}),

  scanImportPreview: async (slug: string, file: File, mapping?: Record<string, string>) => {
    const form = new FormData();
    form.set("file", file);
    if (mapping) form.set("mapping", JSON.stringify(mapping));
    return upload<{
      source: string | null;
      source_instance: string | null;
      count: number;
      columns: Array<{ header: string; field: string | null }> | null;
      errors: Array<{ row: number; field: string; message: string }>;
      rows: Array<{ row: number; name: string | null; barcode: string | null; status: string; source_kind: string; quantity: number; scan_area: string | null; hint_category: unknown; has_photo: boolean }>;
    }>(`/api/v1/orgs/${slug}/modules/core-scan/import/preview`, form, file);
  },
  scanImport: async (
    slug: string,
    file: File,
    opts: { dryRun?: boolean; duplicatePolicy?: "skip" | "append" | "replace"; fetchPhotos?: boolean; mapping?: Record<string, string> },
  ) => {
    const form = new FormData();
    form.set("file", file);
    if (opts.mapping) form.set("mapping", JSON.stringify(opts.mapping));
    const qs = new URLSearchParams();
    if (opts.dryRun) qs.set("dry_run", "true");
    if (opts.duplicatePolicy) qs.set("duplicate_policy", opts.duplicatePolicy);
    if (opts.fetchPhotos === false) qs.set("fetch_photos", "false");
    return upload<{
      imported_count: number;
      skipped_count: number;
      errors: Array<{ row: number; field: string; message: string }>;
      created_ids: string[];
      photos_fetched: number;
      photos_failed: number;
      run_id?: string;
      dry_run?: boolean;
    }>(`/api/v1/orgs/${slug}/modules/core-scan/import?${qs.toString()}`, form, file);
  },

  fileScanItems: (slug: string, ids: string[], target: { target_module?: string; target_kind?: string; instance?: string }) =>
    filed(slug, request<{
      filed: Array<{ item_id: string; entity_id: string; entity_kind: string; name: string; item: ScanInboxItem }>;
      failed: Array<{ item_id: string; reason: string }>;
    }>("POST", `/orgs/${slug}/modules/core-scan/inbox/file-selected`, { ids, ...target }), r => ({ filed: r.filed.map(it => ({ item: it.item, createdId: it.entity_id })) })),

  /** The catalog entries a scan could be, for its confirm (#6888). */
  scanCatalogCandidates: (slug: string, id: string, kind: string) =>
    request<{ candidates: ScanCatalogCandidate[]; asked_ai: boolean }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/catalog-candidates?kind=${encodeURIComponent(kind)}`,
    ),
  confirmScanItem: (
    slug: string,
    id: string,
    body: {
      target_module?: string;
      target_kind?: string;
      /** Commit into a module INSTANCE (e.g. the "yarn" inventory instance)
       *  instead of the default — the backend routes the create to
       *  /instances/:name/items, scoping the new entity to that instance. */
      instance?: string;
      name?: string;
      location_id?: string;
      quantity?: number;
      /** Tags to attach to the created entity (union'd with pending_tags). */
      tags?: string[];
      extras?: Record<string, unknown>;
      /** The category to file under, by NAME, whatever store the table keeps
       *  it in. The only way to reach a table whose module owns its categories
       *  (no custom field carries the name there). */
      category?: string;
      /** Platform-admin only: also record this commit as a matchmaker eval
       *  case (the corrected answer = ground truth). Ignored for non-admins. */
      save_eval_case?: boolean;
      eval_note?: string;
      /** "I just ran out of this" (#6526): filed with none on hand, and onto
       *  the shopping list (services/ran-out.ts). */
      ran_out?: boolean;
      /** A catalog entry picked at confirm (#6888): filed bound to it. */
      catalog_entry_id?: string;
    },
  ) =>
    filed(
      slug,
      request<{ item: ScanInboxItem; created: { id: string }; ran_out?: ScanRanOutAnswer }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/confirm`, body),
      (r) => ({ filed: [{ item: r.item, createdId: r.created?.id ?? null }] }),
    ),
  /** Paired-scan: the scanned product IS the active bin itself — write the
   *  product identity onto that core-locations record instead of creating a
   *  new entity. location_id overrides the bin the scan was filed into. */
  confirmScanIntoLocation: (slug: string, id: string, location_id?: string) =>
    filed(
      slug,
      request<{ item: ScanInboxItem; location_id: string }>(
        "POST",
        `/orgs/${slug}/modules/core-scan/inbox/${id}/confirm-into-location`,
        location_id ? { location_id } : {},
      ),
    ),
  /** "Turn into a bin" in one tap (#6891): a new container location (the
   *  next free "Bin N" unless named) made from this scan, with its product
   *  identity on it. Undo (unconfirmScanItem) takes the new bin away. */
  newBinFromScan: (slug: string, id: string, opts: { name?: string; parent_id?: string } = {}) =>
    filed(
      slug,
      request<{ item: ScanInboxItem; location_id: string; location_name: string }>(
        "POST",
        `/orgs/${slug}/modules/core-scan/inbox/${id}/confirm-into-location`,
        { new_bin: true, ...opts },
      ),
    ),
  discardScanItem: (slug: string, id: string) =>
    request<ScanInboxItem>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/discard`,
    ),
  /** Revert a commit: send a resolved scan back to the pending inbox
   *  (deletes the CREATED entity through its module; never touches a
   *  pre-existing entity the scan merely attached to). */
  /** File everything: a dry run returns the plan (three piles); `confirm`
   *  with the item ids and plans the sheet SHOWED acts on exactly those. A
   *  bulk write, deliberately not reachable by an agent (AI-REACH exempt on
   *  the route); the sheet is its only door. */
  autofileScan: (
    slug: string,
    body: {
      confirm?: boolean;
      batch_id?: string;
      timezone?: string;
      item_ids?: string[];
      seen?: Array<{ item_id: string; action: "attach" | "create" | "skip"; to_id?: string | null }>;
      location_id?: string | null;
      /** Or a thing that holds things (a Backpack): new ones go inside it. */
      container?: { kind: string; id: string } | null;
    },
  ) => {
    const r = request<AutofileDryRun | AutofileResult>("POST", `/orgs/${slug}/modules/core-scan/inbox/autofile`, body);
    return body.confirm ? filed(slug, r) : r;
  },
  /** The thing this scan matched is broken (#6889): a repair entry in its
   *  service log, no new thing, the scan settled. Undo is unconfirmScanItem. */
  markScanBroken: (slug: string, id: string, note?: string | null) =>
    filed(
      slug,
      request<{ item: ScanInboxItem; entry_id: string; record: { kind: string; id: string; instance: string | null; title: string } }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/broken`, note ? { note } : {}),
      (r) => ({ filed: [{ item: r.item, createdId: null }] }),
    ),
  unconfirmScanItem: (slug: string, id: string) =>
    filed(
      slug,
      request<{ item: ScanInboxItem; entity_deleted: boolean; note: string | null }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/unconfirm`),
      (r) => ({ unfiled: [r.item?.id ?? id] }),
    ),
  restoreScanItem: (slug: string, id: string) =>
    request<ScanInboxItem>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/restore`,
    ),
  // Capture-first "write something down": free text → a note capture the
  // matchmaker identifies against the flagship bundle menu.
  scanNote: (slug: string, text: string) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/scan/note`, { text }),
  // Parse an uploaded receipt (CSV / PDF / photo) into one inbox row per line
  // item — each then triages into a part via the normal confirm flow. CSV and
  // text-PDF tables parse deterministically (no AI); everything else falls to AI.
  /** `target_item_id` attaches the receipt to an item that already exists:
   *  the order is recorded in full, the item is linked to it, and nothing
   *  lands in the inbox because nothing needs triaging. */
  scanReceipt: (
    slug: string,
    file_id: string,
    opts?: { force?: boolean; origin?: "email" | "upload"; target_item_id?: string },
  ) =>
    request<
      | {
          receipt: {
            vendor: string | null;
            date: string | null;
            currency: string | null;
            total: number | null;
            item_count: number;
            /** What the parsed lines add up to, and whether that matches the
             *  total charged. False means the receipt is only mostly read. */
            lines_total: number;
            lines_reconcile: boolean | null;
            method: "csv" | "pdf-table" | "text-lines" | "ocr-lines" | "ocr-form" | "ai-chat" | "ai-vision" | "ai-document" | "order-page" | "order-email";
          };
          items: ScanInboxItem[];
          /** The session the lines went into. */
          batch_id?: string | null;
          /** Whether the receipt was kept as a purchase; when not, whether
           *  Purchases being off is why (#3869). Null with no session. */
          purchase?: { recorded: boolean; purchases_off: boolean } | null;
          duplicate?: undefined;
        }
      | {
          duplicate: true;
          existing: { batch_id: string; label: string | null; vendor: string | null; order_ref: string | null; item_count: number };
        }
    >("POST", `/orgs/${slug}/modules/core-scan/scan/receipt`, {
      file_id,
      ...(opts?.force ? { force: true } : {}),
      ...(opts?.origin ? { origin: opts.origin } : {}),
      ...(opts?.target_item_id ? { target_item_id: opts.target_item_id } : {}),
    }),
  /** Re-run the scan pipeline on one inbox item.
   *
   *  `noAi` REPLAYS it instead: every model stage is served from the AI cache,
   *  and a stage with no cached reply degrades (the matchmaker drops to keyword
   *  routing) rather than calling out — free, instant, and it re-runs all our
   *  DETERMINISTIC code (reply parsers, pack-size, the split derivation, keyword
   *  routing, decoder role-fill, field mapping) against the model's previous
   *  answers. It cannot test a PROMPT change: the cache is keyed on the input
   *  (the image), not the prompt, so a cached reply answers the prompt that was
   *  live when it was bought. */
  /** "That is a receipt": the photo on this item goes to the receipt parser
   *  (the same route the dedicated upload uses) and the photo row is retired
   *  once its lines land. The intake's identify verdict does this on its own;
   *  this is the one-tap correction when it missed. */
  readScanItemAsReceipt: (slug: string, id: string, opts: { force?: boolean } = {}) =>
    request<{ ok: true; receipt: true; items: number }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/as-receipt`,
      opts.force ? { force: true } : {},
    ),
  rerunScanAi: (
    slug: string,
    id: string,
    opts: {
      hint?: string | undefined;
      wrong?: boolean | undefined;
      enrich?: boolean | undefined;
      imageFileId?: string | undefined;
      /** The corrected barcode - replaces barcode_text and re-runs the lookup. */
      barcode?: string | undefined;
      noAi?: boolean | undefined;
    } = {},
  ) =>
    request<ScanInboxItem>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/rerun-ai`,
      {
        ...(opts.hint ? { hint: opts.hint } : {}),
        ...(opts.wrong ? { wrong: true } : {}),
        ...(opts.enrich ? { enrich: true } : {}),
        ...(opts.imageFileId ? { image_file_id: opts.imageFileId } : {}),
        ...(opts.barcode ? { barcode: opts.barcode } : {}),
        ...(opts.noAi ? { no_ai: true } : {}),
      },
    ),
  // "This listing is good — lock it in": verify the current name/brand/category/
  // photo into the shared barcode database for every future scan of this UPC.
  confirmScanBarcode: (slug: string, id: string) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/confirm-barcode`),
  // "Already tracked?" — entities the workspace already has matching this scan
  // (exact barcode / name overlap), and attach-to-existing instead of duplicating.
  scanTrackedMatches: (slug: string, id: string) =>
    request<{ barcode_matches: TrackedMatch[]; name_matches: TrackedMatch[]; places?: TrackedPlace[]; place_choice?: string | null }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/tracked-matches`,
    ),
  /** Which place of the matched thing this scan goes to, when it is kept in
   *  several: stored on the row, and the row's match re-stamped there. */
  scanPickPlace: (slug: string, id: string, recordId: string) =>
    request<{ ok: true }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/place`, { record_id: recordId }),
  /** Put back the answer the last re-run overwrote (restores metadata.pre_rerun). */
  scanUndoRerun: (slug: string, id: string) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/undo-rerun`),
  /** Put a scan row back as one of its History entries found it (#6100):
   *  every field the step rewrote, from the before-state it recorded. */
  restoreScanRevision: (slug: string, id: string, revision: string) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/revisions/${revision}/restore`),
  /** Single-SKU bin: what lives in this bin + direct qty adjust off its QR. */
  binContents: (slug: string, locationId: string) =>
    request<{ items: TrackedMatch[]; single: boolean }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/bin/${locationId}/contents`,
    ),
  binAdjust: (
    slug: string,
    locationId: string,
    body: { kind: string; entity_id: string; instance?: string; delta?: number; set?: number },
  ) =>
    request<{ entity_title: string; old_qty: number; new_qty: number }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/bin/${locationId}/adjust`,
      body,
    ),
  /** Records that look like the same thing twice - the pairs prevention cannot
   *  remove, because they were created before it existed. */
  scanDuplicates: (slug: string) =>
    request<{
      pairs: Array<{
        kind: string;
        noun: string;
        a: { id: string; title: string; qty: number | null; location_id: string | null };
        b: { id: string; title: string; qty: number | null; location_id: string | null };
        shared: string[];
      }>;
      truncated: boolean;
    }>("GET", `/orgs/${slug}/modules/core-scan/duplicates`),
  /** Make two records one. `keep_id` survives with its id, links and history;
   *  `drop_id` is absorbed and removed. */
  scanMergeDuplicate: (slug: string, body: { kind: string; keep_id: string; drop_id: string }) =>
    request<{
      kept: { id: string; title: string };
      dropped: { id: string; title: string };
      new_qty: number | null;
      prior_qty: number | null;
      filled: string[];
    }>("POST", `/orgs/${slug}/modules/core-scan/duplicates/merge`, body),
  scanAttach: (
    slug: string,
    id: string,
    body: {
      kind: string;
      entity_id: string;
      instance?: string;
      /** `replace`: the one you had ran out and this is the new one. The
       *  count is set to what was scanned, the old one is recorded as
       *  consumed (or discarded via `resolution`), the new one as bought. */
      /** `add-place`: keep these at the scan's place as another place of the
       *  same item (one item, a row per place). */
      mode: "add-qty" | "replace" | "link-barcode" | "move" | "merge-fields" | "count" | "add-place";
      location_id?: string;
      /** `count`: what is in your hands, signed; or the total as it really
       *  is (a correction). Exactly one (scanCountBody). */
      change?: number;
      total?: number;
      reason?: ScanCountReason;
      /** Only meaningful on add-qty / replace, the modes that are a purchase.
       *  `context` keeps a party-sized or stock-up buy from training the rate
       *  like a normal shop; `resolution` says what became of the stock you
       *  still had, which nothing but a person can know. */
      cadence?: {
        context?: "normal" | "faster" | "bulk" | "one_off";
        resolution?: "over_buy" | "consumed" | "discarded";
      };
      /** How many were bought (add-qty / replace); the row's own when absent. */
      qty?: number;
      /** With `count`: all of it was used up (#6526), and it goes on the
       *  shopping list. No change or total needed. */
      ran_out?: boolean;
    },
  ) =>
    request<{
      ran_out?: ScanRanOutAnswer;
      item: ScanInboxItem;
      entity_title: string;
      new_qty: number | null;
      prev_location_id: string | null;
      merged_fields: string[];
      cadence_recorded?: string[];
      /** The scan was a new place of the item: the row added for it. */
      added_place?: { id: string; card_id: string; location_id: string; location_name: string | null; qty: number };
      /** `count`: the take left it at its minimum or empty. */
      low?: boolean;
    }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/attach`, body),
  // Merge several similar pending items (same product, different barcodes) into one
  // line with the summed quantity; keepId's name/photo wins, others are discarded.
  combineScanItems: (slug: string, ids: string[], keepId?: string) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/combine`, {
      ids,
      ...(keepId ? { keep_id: keepId } : {}),
    }),
  /** Session theme: derive a shared tag + category across the pending inbox. */
  /** A theme is a question about ONE session, asked when somebody asks it. */
  /** Asked about exactly `itemIds` (the rows the group shows); the answer
   *  names the set it was about, and every id it would change is in it. */
  scanSessionTheme: (slug: string, batchId: string, itemIds: readonly string[]) =>
    lookupInBody<ScanSessionThemeAnswer>(
      `/orgs/${slug}/modules/core-scan/inbox/session-theme`,
      { batch_id: batchId, ids: [...itemIds] },
      // id-list-in-url: the older api's door only, trimmed to fit by idsThatFitAUrl.
      () => `/orgs/${slug}/modules/core-scan/inbox/session-theme?batch_id=${encodeURIComponent(batchId)}&ids=${encodeURIComponent(idsThatFitAUrl(itemIds).join(","))}`,
    ),
  /** Every pending scan, grouped by where it could go (the dashboard queue). */
  scanScannerQueue: (slug: string) => request<ScannerQueueSummary>("GET", `/orgs/${slug}/modules/core-scan/inbox/scanner-queue`),
  /** Stash the accepted theme onto the pending items (tag + category hint). */
  applyScanTheme: (
    slug: string,
    body: { tag?: string; tag_item_ids?: string[]; category?: { value: string; item_ids: string[] } },
  ) =>
    request<{ tagged: number; categorized: number }>("POST", `/orgs/${slug}/modules/core-scan/inbox/apply-theme`, body),
  // Alternative catalog photos (DDG image search on the resolved name) +
  // pick-one-as-catalog. The "OTHER PHOTO OPTIONS" strip.
  scanPhotoOptions: (slug: string, id: string, q?: string) =>
    request<{ items: ImageOption[]; query?: string; color?: string | null; throttled?: boolean }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/photo-options${q && q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`,
    ),
  /** Apply a URL as the catalog image. Pass `aiPick` when the URL came from
   *  "✨ Pick best (AI)", so Revert can step back TO the ranker's choice instead
   *  of past it to the raw first web result. */
  setScanCatalogImage: (
    slug: string,
    id: string,
    url: string,
    opts?: { aiPick?: boolean; thumbUrl?: string },
  ) =>
    request<ScanInboxItem>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/catalog-image`,
      {
        url,
        ...(opts?.aiPick ? { ai_pick: true } : {}),
        // The picture the user is actually looking at. Sent so a hotlink-blocked
        // original can fall back to it rather than refusing a visible image.
        ...(opts?.thumbUrl && opts.thumbUrl !== url ? { thumb_url: opts.thumbUrl } : {}),
      },
    ),
  /** "✨ Pick best (AI)" — a vision model ranks the photo options and picks the
   *  cleanest catalog shot (product-only, correct colour, no people). Read-only:
   *  returns the chosen URL + reason; the caller applies it via setScanCatalogImage.
   *  Pass the DISPLAYED candidates + any applied search term so the model ranks
   *  exactly what the user is looking at (the pick is always a visible tile);
   *  with none, the server searches fresh. `chosen_url` is null when nothing was
   *  rankable (no name, no options, no vision provider) — `reason` says why. */
  rankScanPhotoAi: (
    slug: string,
    id: string,
    opts?: { q?: string; candidates?: ImageOption[] },
  ) =>
    request<{ chosen_url: string | null; reason: string; color_seen?: string | null; ranked_over?: number }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/rank-photo-ai`,
      {
        ...(opts?.q?.trim() ? { q: opts.q.trim() } : {}),
        ...(opts?.candidates?.length ? { candidates: opts.candidates } : {}),
      },
    ),
  /** The workspace opt-in for ranking catalog photos automatically on every
   *  enriched scan (instead of only when someone presses ✨ Pick best). Reading
   *  is member-level; flipping it commits the workspace to per-scan AI spend, so
   *  the PUT is owner/admin. No stored row means off. */
  getScanPhotoRankConfig: (slug: string) =>
    request<{ enabled: boolean }>("GET", `/orgs/${slug}/modules/core-scan/photo-rank-config`),
  setScanPhotoRankConfig: (slug: string, enabled: boolean) =>
    request<{ enabled: boolean }>("PUT", `/orgs/${slug}/modules/core-scan/photo-rank-config`, { enabled }),
  /** The first-look question on the camera (see services/glance.ts). */
  getScanGlanceConfig: (slug: string) =>
    request<{ enabled: boolean }>("GET", `/orgs/${slug}/modules/core-scan/glance-config`),
  setScanGlanceConfig: (slug: string, enabled: boolean) =>
    request<{ enabled: boolean }>("PUT", `/orgs/${slug}/modules/core-scan/glance-config`, { enabled }),
  /** Answer "we think it's X" on a card. `hint` rides with a "no". */
  answerScanGlance: (slug: string, id: string, body: { answer: "yes" | "no"; hint?: string }) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/glance-answer`, body),
  /** Revert the catalog image to the original, or use the user's own scan photo. */
  scanCatalogAction: (slug: string, id: string, action: "revert" | "use_own_photo" | "use_screenshot_crop") =>
    request<ScanInboxItem>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/catalog-image`,
      { action },
    ),
  /** "Take a nice picture" — a fresh upload becomes the display/catalog image. */
  setScanCatalogFile: (slug: string, id: string, fileId: string) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/catalog-image`, {
      file_id: fileId,
    }),
  /** Crop the item's OWN photo into the catalog image. `box` is fractions of
   *  the source (0-1), the same shape the split feature's segmentation yields.
   *  Always crops the identify photo, so cropping twice starts from the
   *  original rather than compounding a crop of a crop. Revertable like any
   *  other catalog pick. */
  cropScanCatalogImage: (
    slug: string,
    id: string,
    box: { x: number; y: number; w: number; h: number },
    /** `source: "group"`: cut a split child's group shot again into its own
     *  picture (#3046); absent, the row's own photo into its catalog picture. */
    opts: { source?: "own" | "group" } = {},
  ) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/catalog-image`, {
      crop: box,
      ...(opts.source ? { source: opts.source } : {}),
    }),
  /** Rotate the item's own photo (writes a new file; the old one is kept). */
  rotateScanPhoto: (slug: string, id: string, deg: 90 | 180 | 270) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/rotate`, { deg }),
  /** Multi-photo gallery: add / make-primary / remove an extra photo. */
  /** `uploaded` marks a picture CHOSEN from the device rather than taken now.
   *  A capture is a photo of the object in front of you; a file off the camera
   *  roll may be a listing screenshot, a spec sheet or a receipt, so it is
   *  attached without being allowed to drive the item's identity. */
  addScanPhoto: (slug: string, id: string, fileId: string, opts: { uploaded?: boolean } = {}) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/photos`, {
      file_id: fileId,
      ...(opts.uploaded ? { uploaded: true } : {}),
    }),
  setScanPrimaryPhoto: (slug: string, id: string, fileId: string) =>
    request<ScanInboxItem>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/photos/primary`, {
      file_id: fileId,
    }),
  removeScanPhoto: (slug: string, id: string, fileId: string) =>
    request<ScanInboxItem>("DELETE", `/orgs/${slug}/modules/core-scan/inbox/${id}/photos/${fileId}`),
  /** Split a photo into the things a person named (#6342): each name a row
   *  with its own crop, one group with Undo split. 409 count_mismatch says
   *  what the photo shows when it disagrees, and adds nothing. */
  splitScanItemByNames: (slug: string, id: string, names: string[]) =>
    request<{ group: { item_id: string; check: string | null }; items: Array<{ item_id: string; crop: string }> }>("POST", `/orgs/${slug}/modules/core-scan/scan/assistant/photo`, {
      item_id: id,
      items: names.map((name) => ({ name })),
    }),
  /** Split a group photo into separate items (vision segments + crops). */
  splitScanItem: (slug: string, id: string) =>
    request<{ children: ScanInboxItem[] }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/split`),
  /** Undo a split: the group photo comes back as it was, its pieces are
   *  discarded. Works from the parent or from any of its pieces. */
  // An order line's units (#5734): same or different, split off, rejoin,
  // a scan counted as one of them, and the line's slots.
  setLineUnits: (slug: string, id: string, mode: "same" | "different") =>
    request<{ items: ScanInboxItem[] }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/units`, { mode }),
  splitOffUnits: (slug: string, id: string, count: number, name?: string) =>
    request<{ items: ScanInboxItem[] }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/split-off`, { count, ...(name ? { name } : {}) }),
  rejoinOrderLine: (slug: string, id: string) => request<{ items: ScanInboxItem[] }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/rejoin`),
  fillOrderLine: (slug: string, id: string, lineId: string) =>
    request<{ received: number; count: number; items: ScanInboxItem[] }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/fill-line`, { line_id: lineId }),
  unfillOrderLine: (slug: string, id: string) => request<{ received: number; items: ScanInboxItem[] }>("DELETE", `/orgs/${slug}/modules/core-scan/inbox/${id}/fill-line`),
  declineLineOffer: (slug: string, id: string) => request<{ items: ScanInboxItem[] }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/line-offer/decline`),
  scanTheItems: (slug: string, lineId: string) =>
    request<{ batch_id: string }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${lineId}/scan-session`),
  /** Whether there is a line to count against (a purchase line's, or a scan
   *  session's), and what it holds: 200 with slots null for none, never a 404
   *  (#6268). For a page that asks routinely; a line known to be there uses
   *  orderLineSlots. */
  orderLineSlotsIfAny: (slug: string, by: { order_item_id: string } | { batch_id: string }) =>
    request<{ slots: OrderLineSlots | null }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/inbox/line-slots?${"batch_id" in by ? `batch_id=${encodeURIComponent(by.batch_id)}` : `order_item_id=${encodeURIComponent(by.order_item_id)}`}&if_any=1`,
    ),
  orderLineSlots: (slug: string, by: { line_id: string } | { order_item_id: string } | { batch_id: string }) =>
    request<OrderLineSlots>(
      "GET",
      `/orgs/${slug}/modules/core-scan/inbox/line-slots?${"line_id" in by ? `line_id=${encodeURIComponent(by.line_id)}` : "batch_id" in by ? `batch_id=${encodeURIComponent(by.batch_id)}` : `order_item_id=${encodeURIComponent(by.order_item_id)}`}`,
    ),
  unsplitScanItem: (slug: string, id: string) =>
    request<{ parent: ScanInboxItem; discarded: number }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/unsplit`),
  /** Split again: the parts an Undo split took out come back (#6527). */
  redoSplitScanItem: (slug: string, id: string) =>
    request<{ parent: ScanInboxItem; parts: string[] }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/redo-split`),
  /** Undo a combine from either row: the kept one or one it absorbed (#3639). */
  uncombineScanItem: (slug: string, id: string) =>
    request<{ kept: ScanInboxItem; restored: string[] }>("POST", `/orgs/${slug}/modules/core-scan/inbox/${id}/uncombine`),
  /** Turn Purchases on and keep a receipt read while it was off as the
   *  purchase it would have been (#3869). */
  recordReceiptPurchase: (slug: string, batchId: string) =>
    request<{ order_id: string; already?: boolean }>("POST", `/orgs/${slug}/modules/core-scan/batches/${batchId}/record-purchase`, {}),
  createScanBatch: (slug: string) =>
    request<{ id: string }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/batches`,
      {},
    ),
  // Matchmaker — route a scanned item to the best workspace table(s) + fill
  // each table's fields. Run after identify; returns + persists ranked chips.
  matchScanItem: (slug: string, id: string) =>
    request<{ candidates: ScanCandidate[] }>(
      "POST",
      `/orgs/${slug}/modules/core-scan/inbox/${id}/match`,
      {},
    ),
  // The workspace "scan menu" — every routable table (instances + module
  // defaults) with its field defs. The SAME menu the matchmaker prompts
  // with; drives the confirm form's target picker so the UI reflects the
  // workspace's actual tables instead of hardcoding module names.
  scanMenu: (slug: string) =>
    request<{ items: ScanMenuEntry[] }>(
      "GET",
      `/orgs/${slug}/modules/core-scan/menu`,
    ),
};
