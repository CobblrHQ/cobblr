// Per-unit consumption logic — pure, framework-free, unit-testable.
//
// The model of record: a consumable is a MODEL (Big Twist Cream, 182 m/skein)
// with UNIT children (individual skeins). You never consume "the model"; you
// consume one open skein at a time. See
// docs/design-decisions/consumption-ledger.md — this file is the P1 spine:
//
//   • the new → open → empty unit state machine (§1)
//   • per-unit capacity as a DIRECT field read, never a product (§6)
//   • the running balance DERIVED on read over the existing ledger (§7.2)
//   • the simple by-state COUNT face — never a total across units (§4.1)
//
// Deliberately generic: a "skein" here is any consumable unit (a filament
// spool's grams, a tape roll's metres, a box's count). Nothing is yarn-shaped;
// the domain is carried entirely by the model's declared per-unit capacity
// field and its unit. Proven by tests against filament + screws.

/** A consumption ledger row, as returned by `GET /parts/:id/consumption`
 *  (newest first). `delta` is a signed string ("-40" used, "+546" added). */
export interface LedgerRow {
  id: string;
  delta: string | number;
  reason?: string | null;
  source_kind?: string | null;
  at: string;
}

/** The three states a unit of a consumable can be in (§1). `new` is not a child
 *  row at all — new/unopened skeins are FUNGIBLE, so they are just a count on
 *  the model. Only `open` and `empty` are real unit rows (they carry a balance
 *  and a ledger). */
export type UnitState = "new" | "open" | "empty";

/** A per-unit record (an opened or emptied skein). In P1 this is a child part
 *  under the model, linked by an `instance-of` pairing and marked in metadata.
 *  `qty` is the metres/grams/count REMAINING in this one unit; `capacity` is
 *  what it started full at (the model's per-unit capacity, inherited). */
export interface UnitRecord {
  id: string;
  name: string;
  qty: number;
  capacity: number | null;
  state: UnitState;
}

// ── State machine ────────────────────────────────────────────────────────────

/** A unit's live state, derived from its remaining quantity. An open skein that
 *  hits 0 (or below) is `empty` and drops off the active view; anything with a
 *  positive balance is still `open`. `new` is never derived here — an unopened
 *  skein has no unit row, it is part of the model's fungible count. Deriving
 *  (rather than trusting a stored flag) is robust to a hand-edited qty. */
export function deriveUnitState(qty: number): Exclude<UnitState, "new"> {
  return qty > 0 ? "open" : "empty";
}

/** Whether a unit is still being pulled from (open, non-empty). */
export function isOpen(u: { qty: number }): boolean {
  return u.qty > 0;
}

// ── Per-unit capacity (§6) — a DIRECT read, never a product ───────────────────

/** Resolve the capacity a unit is gauged against, by the spec's precedence:
 *    1. the model's DERIVED capacity (the computed `{{ length_per_skein }}`
 *       field, resolved server-side) — authoritative, so a declared per-skein
 *       length always wins and the user never fights a stale typed number;
 *    2. a legacy manually-typed `metadata.capacity` — back-compat;
 *    3. null → the opt-in / prompt state (§8.4).
 *  No arithmetic: the common per-unit case is one field read. */
export function resolveUnitCapacity(opts: {
  resolvedCapacity?: number | null;
  metadataCapacity?: number | null;
}): number | null {
  const { resolvedCapacity, metadataCapacity } = opts;
  if (resolvedCapacity != null && Number.isFinite(resolvedCapacity) && resolvedCapacity > 0) {
    return resolvedCapacity;
  }
  if (metadataCapacity != null && Number.isFinite(metadataCapacity) && metadataCapacity > 0) {
    return metadataCapacity;
  }
  return null;
}

/** A gauge percentage for one unit (0–100, clamped). Null when there is no
 *  capacity to gauge against. Clamped at 100 so a topped-up unit that briefly
 *  exceeds full doesn't overflow the bar (open question #4 → default clamp). */
export function gaugePct(qty: number, capacity: number | null): number | null {
  if (capacity == null || capacity <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((qty / capacity) * 100)));
}

// ── Running balance, per unit, DERIVED on read (§7.2) ─────────────────────────

export interface BalancedRow {
  row: LedgerRow;
  /** The unit's balance right AFTER this row posted. */
  balanceAfter: number;
}

/** Walk a single open unit's ledger and attach the balance true right after
 *  each line. Anchored at the unit's authoritative present remaining (its
 *  `currentQty`), NOT summed from zero — so the newest line's balance always
 *  equals the gauge, and any un-ledgered opening discrepancy lands on the
 *  OLDEST line ("before this skein's record starts") instead of smearing across
 *  every line.
 *
 *    rows                   = this unit's ledger, newest → oldest
 *    balanceAfter(rows[0])  = currentQty
 *    balanceAfter(rows[i])  = balanceAfter(rows[i-1]) − delta(rows[i-1])
 *
 *  Balance is never stored — a stored balance goes stale the moment a row is
 *  inserted, edited, or backfilled out of order. Re-derive every render. */
export function runningBalances(rows: LedgerRow[], currentQty: number): BalancedRow[] {
  const out: BalancedRow[] = [];
  let balance = currentQty;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (i > 0) balance -= Number(rows[i - 1]!.delta);
    out.push({ row, balanceAfter: round(balance) });
  }
  return out;
}

// ── The simple by-state count face (§4.1) — NEVER a total across units ────────

export interface PoolSummary {
  /** Unopened, fungible spares (the model's own quantity). */
  newCount: number;
  /** How many units are currently open (being pulled from). */
  openCount: number;
  /** newCount + openCount — an honest COUNT of skeins on hand. This is the ONLY
   *  aggregate ever shown; it is a count, not a blended metres total. */
  totalCount: number;
  /** The open units, for the subtle per-open remaining (one at a time in the
   *  simple face; a small list only once there are genuinely several). */
  open: UnitRecord[];
}

/** Build the by-state pool summary from the model's fungible `new` count and its
 *  live unit rows. Empty units are dropped from the active view (their ledger is
 *  retained as history elsewhere). This produces the headline "3 skeins · 2 new
 *  · 1 open" numbers — and, by construction, no metres total: the metres live on
 *  each open unit, never blended (the governing rule of §0). */
export function summarizePool(newCount: number, units: UnitRecord[]): PoolSummary {
  const open = units.filter(isOpen);
  const safeNew = Math.max(0, Math.floor(newCount));
  return {
    newCount: safeNew,
    openCount: open.length,
    totalCount: safeNew + open.length,
    open,
  };
}

/** The by-state count as words, in the model's own unit noun, e.g.
 *  "3 skeins · 2 new · 1 open" (yarn) or "5 spools · 4 new · 1 open" (filament).
 *  Segments with a zero count are dropped so a new-only item collapses to just
 *  "5 skeins" (§4.2 — nothing being consumed yet). Never contains a metres/grams
 *  total. `nounSingular`/`nounPlural` come from the model's qty-unit vocabulary
 *  (e.g. skein/skeins); a plain "s" plural is a safe default caller-side. */
export function poolCountLabel(
  s: PoolSummary,
  nounSingular: string,
  nounPlural: string,
): string {
  const noun = s.totalCount === 1 ? nounSingular : nounPlural;
  const head = `${s.totalCount} ${noun}`;
  const parts: string[] = [];
  if (s.newCount > 0) parts.push(`${s.newCount} new`);
  if (s.openCount > 0) parts.push(`${s.openCount} open`);
  // A pure new-only pool needs no breakdown (head already says it all); an
  // all-open or mixed pool shows the split.
  if (parts.length === 0 || (s.newCount > 0 && s.openCount === 0)) return head;
  return `${head} · ${parts.join(" · ")}`;
}

// ── Provenance (§8.3) — is the capacity derived or typed? ─────────────────────

/** Parse a computed capacity template like "{{ length_per_skein }}" back to the
 *  single source field name it reads, so the panel can label the provenance
 *  chip with that field's own display label ("full skein from Length / skein").
 *  Returns null for a template that isn't a single bare substitution (e.g. one
 *  using a filter or arithmetic — not the P1 direct-read shape). */
export function capacitySourceField(template: string | null | undefined): string | null {
  if (!template) return null;
  const m = template.trim().match(/^\{\{\s*([a-zA-Z0-9_]+)\s*\}\}$/);
  return m ? (m[1] ?? null) : null;
}

function round(n: number): number {
  // Trim float noise from repeated subtraction (546 - 0.1 - 0.2 …) without
  // forcing integers — consumables can be fractional (12.5 m).
  return Math.round(n * 1e6) / 1e6;
}

// ── Opt-in gate + unit metadata (§9, additive/self-healing) ───────────────────
//
// Per-skein tracking is OPT-IN PER ITEM. Until the user turns it on, a
// consumable renders EXACTLY as it does today (a single flat gauge over the
// model's own qty). Turning it on only flips a metadata flag on the model — it
// creates no unit rows, moves no data, and can be turned back off. This is the
// self-healing guarantee: an existing yarn part with `qty 3` and no flag is
// untouched and behaves identically. See consumption-ledger.md §9.

/** The model-part metadata key that opts THIS item into per-unit tracking. */
export const PER_UNIT_TRACKING_KEY = "per_unit_tracking";
/** On a unit (child) row: the model part it is a unit OF. */
export const UNIT_OF_KEY = "unit_of";
/** On a unit (child) row: its `open` / `empty` state (also derivable from qty). */
export const UNIT_STATE_KEY = "unit_state";

type Meta = Record<string, unknown> | null | undefined;

/** Whether the model item has opted into per-unit (per-skein) tracking.
 *  Absent / falsy → today's flat consumption face (the additive default). */
export function isPerUnitTracking(metadata: Meta): boolean {
  return !!(metadata && (metadata as Record<string, unknown>)[PER_UNIT_TRACKING_KEY] === true);
}

/** Whether a part row is a per-unit child (a skein), i.e. it points back at a
 *  model via `metadata.unit_of`. Used to recognise a unit independently of the
 *  pairing, and to keep unit rows from being mistaken for models. */
export function isUnitRow(metadata: Meta): boolean {
  return !!(metadata && typeof (metadata as Record<string, unknown>)[UNIT_OF_KEY] === "string");
}

/** Build the metadata stamped on a newly-opened unit (child) row. */
export function buildUnitMetadata(modelId: string, capacity: number | null): Record<string, unknown> {
  return {
    [UNIT_OF_KEY]: modelId,
    [UNIT_STATE_KEY]: "open",
    ...(capacity != null ? { capacity } : {}),
  };
}

/** Project a fetched child part row into a `UnitRecord`. State is DERIVED from
 *  the live remaining qty (robust to a hand-edited number), falling back to the
 *  stored `unit_state` only when qty is absent. Capacity prefers an inherited/
 *  resolved value, else the unit's own stored `metadata.capacity`. */
export function parseUnitRecord(
  part: { id: string; name: string; qty: number | string; metadata?: Meta },
  resolvedCapacity?: number | null,
): UnitRecord {
  const qty = Number(part.qty);
  const metaCap = numOrNull((part.metadata as Record<string, unknown> | undefined)?.capacity);
  return {
    id: part.id,
    name: part.name,
    qty: Number.isFinite(qty) ? qty : 0,
    capacity: resolveUnitCapacity({ resolvedCapacity, metadataCapacity: metaCap }),
    state: deriveUnitState(Number.isFinite(qty) ? qty : 0),
  };
}

function numOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── P2: project binding + close-out (§3, §1.1, §4.2) ──────────────────────────
//
// An open unit can be BOUND to a project via an allocation on the unit's own
// part id — the exact reserve→consume primitive inventory already has, pointed
// at the unit (consumption-ledger.md §3). Multiple units bind to different
// projects in PARALLEL; each project pulls from ITS skein; there is never a
// blend across them. All of this is pure/derived so it is unit-testable and the
// panel stays a thin renderer.

/** The minimal shape of an allocation row the binding logic reads. Matches the
 *  UI `Allocation` type (and the API's list rows) without importing it, so this
 *  file stays framework- and api-free. */
export interface AllocationLike {
  id: string;
  status: string;
  target_module: string;
  target_entity_type: string;
  target_entity_id: string;
  reason: string | null;
}

/** A project binding on an open unit, derived from its RESERVED allocation.
 *  `label` is what the card + statement line show (the project's name when the
 *  binding carried a reason, else the raw target id). */
export interface UnitBinding {
  allocationId: string;
  label: string;
  targetModule: string;
  targetEntityType: string;
  targetEntityId: string;
}

/** The reserved allocation (if any) that binds a unit to a project. A unit is
 *  bound to at most one project at a time — opening "for the scarf" is a single
 *  reservation; the newest reserved one wins if somehow several exist. Consumed
 *  / released allocations are history, not a live binding. Callers pass the
 *  unit's allocations newest-first (the list endpoint's default order). */
export function bindingOf(allocations: AllocationLike[]): UnitBinding | null {
  const a = allocations.find((x) => x.status === "reserved");
  if (!a) return null;
  return {
    allocationId: a.id,
    label: (a.reason && a.reason.trim()) || a.target_entity_id,
    targetModule: a.target_module,
    targetEntityType: a.target_entity_type,
    targetEntityId: a.target_entity_id,
  };
}

/** The model-part metadata key that TUNES the reusable-vs-scrap close-out
 *  threshold (a 0–1 fraction of a unit's capacity). Absent → the default. */
export const REUSABLE_THRESHOLD_KEY = "reusable_threshold_pct";

/** Default fraction of a unit's capacity below which a leftover is "small /
 *  ambiguous" and the close-out prompt appears (§1.1 / §12). At or ABOVE it, the
 *  leftover is clearly reusable and returns to the pool silently — no prompt.
 *  15%: the value the spec brackets at 10–15%; a percentage self-scales across
 *  metres / grams / each from the one capacity the model already declares.
 *  TUNABLE per model via `metadata.reusable_threshold_pct`, never hardcoded at a
 *  call site (resolveThresholdPct is the only reader). */
export const DEFAULT_REUSABLE_THRESHOLD_PCT = 0.15;

/** Resolve the reusable-threshold fraction for a model: its own
 *  `metadata.reusable_threshold_pct` override when a sane 0–1 number, else the
 *  default. Keeps the threshold configurable with no schema column. */
export function resolveThresholdPct(metadata: Meta): number {
  const raw = metadata && (metadata as Record<string, unknown>)[REUSABLE_THRESHOLD_KEY];
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : DEFAULT_REUSABLE_THRESHOLD_PCT;
}

/** How a bound project's close-out is handled when its open skein still has
 *  `remaining` on it (§1.1):
 *    • remaining ≤ 0         → "none"        (already empty — nothing to keep)
 *    • remaining ≥ threshold → "silent-keep" (obviously reusable — no prompt)
 *    • otherwise             → "prompt"      (small/ambiguous — one-tap keep vs write-off)
 *  A unit with no capacity to gauge against can't be measured as a %, so it
 *  prompts (let the user decide) rather than silently keeping an unknown amount.
 *  `pct` comes from resolveThresholdPct — never a literal here. */
export type CloseOutGate = "none" | "silent-keep" | "prompt";
export function closeOutGate(remaining: number, capacity: number | null, pct: number): CloseOutGate {
  if (!(remaining > 0)) return "none";
  if (capacity == null || capacity <= 0) return "prompt";
  return remaining >= capacity * pct ? "silent-keep" : "prompt";
}

/** The expanded per-unit face is disclosed ONLY when the item's own state
 *  contains real parallelism or bindings — derived, never a mode the user
 *  toggles (§4.2). Two-or-more open units, OR any bound unit, earns it; a lone
 *  unbound open skein stays the simple face. */
export function isExpandedFace(openCount: number, boundCount: number): boolean {
  return openCount > 1 || boundCount > 0;
}
