// Part detail — fields inline-editable, allocations panel below.
// Stock adjustments are explicit (a button) so accidental qty edits
// don't silently rewrite history.

import { useEffect, useState, type FocusEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowRightLeft, Copy, Library, Minus, Plus, Printer, ShieldCheck, Trash2 } from "lucide-react";
import { AssortmentCard, ContentsPanel, ContributedDetailPanels, CustomFieldsPanel, EntityActionsBar, EntityThumb, Modal, MoveToInstanceModal, UnitInput, useConfirm, usePageTitle, useToast, useUnits } from "@cobblr/platform-web";
import { useInventory } from "./context";
import { QtyStepper } from "./QtyStepper";
import { isAssorted } from "./assorted";
import { NewPartDialog } from "./NewPartDialog";
import { ParentPicker } from "./ParentPicker";
import { useMatchedCatalogEntry } from "./useMatchedCatalogEntry";
import { AllocationsPanel, EntityPicker, type PickedEntity } from "./AllocationsPanel";
import { UnitsPanel } from "./UnitsPanel";
import { PartGallery } from "./PartGallery";
import { MaintenancePanel } from "./MaintenancePanel";
import { useFieldPresentation } from "./useFieldPresentation";
import { useDisclosure } from "./useDisclosure";
import { adoptUnitsAdjustment } from "../reconcile";
import type { Part } from "./api";
import {
  PER_UNIT_TRACKING_KEY,
  isPerUnitTracking,
  resolveUnitCapacity,
  gaugePct,
  runningBalances,
  summarizePool,
  capacitySourceField,
  buildUnitMetadata,
  parseUnitRecord,
  bindingOf,
  closeOutGate,
  resolveThresholdPct,
  isExpandedFace,
  type UnitRecord,
  type UnitBinding,
  type AllocationLike,
} from "./consumption/perUnit";

// The part-detail body. Rendered inside PartDetailModal (below) — the
// detail view is a modal over the list now (consistent with machines),
// not a separate full page. Takes the part id + an onClose from the
// list route, instead of reading the route param itself.
/** The reconciliation prompt: the model's two numbers disagree, so ASK.
 *
 *  Deliberately quiet and deliberately dumb. It states both numbers, marks
 *  neither as the wrong one (we do not know which is), and never resolves
 *  itself — no number moves and no unit is minted or retired unless the user
 *  picks it. Inventing a physical fact is the failure the whole design rejected;
 *  a card that "helpfully" corrected the count would smuggle it straight back
 *  in. See docs/design-decisions/serialized-rollup-and-stock-adjust.md.
 *
 *  Rendering it performs no write. Only a click does. */
function ReconcileCard({
  part,
  noun,
  onAdopt,
  onDismiss,
  busy,
}: {
  part: Part;
  noun: string;
  onAdopt: () => void;
  onDismiss: () => void;
  busy: boolean;
}) {
  const r = part.reconcile;
  if (!r || !r.stable || r.dismissed) return null;
  const under = r.direction === "under";
  return (
    <div className="rounded-xl border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800/50 p-4 space-y-3">
      <div className="text-sm text-content dark:text-mortar-100">
        {under ? (
          <>
            You have <strong>{r.qty}</strong> counted, and{" "}
            <strong>{r.units_count}</strong> serial{r.units_count === 1 ? "" : "s"} on file.
          </>
        ) : (
          <>
            You have <strong>{r.qty}</strong> counted, but{" "}
            <strong>{r.units_count}</strong> units on file.
          </>
        )}
      </div>
      <div className="text-xs text-muted dark:text-slate-400">
        {under
          ? `Either ${r.qty - r.units_count} ${r.qty - r.units_count === 1 ? "is" : "are"} not scanned yet, or the count is out of date.`
          : "Either the count is out of date, or a unit was recorded twice."}
      </div>
      <div className="flex flex-wrap gap-2">
        {under && (
          <button
            type="button"
            disabled={busy}
            onClick={onDismiss}
            className="rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-xs font-medium text-content dark:text-mortar-100 hover:bg-surface dark:hover:bg-slate-900 transition disabled:opacity-50"
          >
            The count is right
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onAdopt}
          className="rounded-md bg-cobble-600 hover:bg-cobble-500 text-white px-3 py-1.5 text-xs font-medium transition disabled:opacity-50"
        >
          {busy ? "Saving…" : `Use the ${under ? "serials" : "units"} (${r.units_count})`}
        </button>
        {!under && (
          // The prompt LINKS to the units; it never retires one itself.
          <a
            href="#units"
            className="rounded-md border border-line dark:border-slate-600 px-3 py-1.5 text-xs font-medium text-content dark:text-mortar-100 hover:bg-surface dark:hover:bg-slate-900 transition"
          >
            Review units
          </a>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          className="rounded-md px-3 py-1.5 text-xs text-muted hover:text-content dark:hover:text-mortar-100 transition disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
      <div className="text-[11px] text-faint">
        Nothing changes to your {noun} unless you pick one.
      </div>
    </div>
  );
}

export function PartDetailPage({ id, onClose }: { id: string; onClose: () => void }) {
  const { api, orgSlug, getToken, entityKind, instance, itemNoun, parent } = useInventory();
  const fp = useFieldPresentation(entityKind);
  const disclosure = useDisclosure();
  const units = useUnits();
  const qc = useQueryClient();
  // A native field is hidden if the workspace explicitly hid it OR it's part of
  // the stock face and this instance is a lean catalog. See one-record-substrate.md.
  const hide = (name: string): boolean => fp.hidden(name) || disclosure.hides(name);

  const part = useQuery({
    queryKey: ["inventory-part", id],
    queryFn: () => api.getPart(id!),
    enabled: !!id,
  });

  const cats = useQuery({ queryKey: ["inventory-categories"], queryFn: () => api.listCategories() });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });
  const matched = useMatchedCatalogEntry(id);

  const toast = useToast();
  const confirm = useConfirm();
  const [dup, setDup] = useState(false);
  const [moving, setMoving] = useState(false);
  const [counting, setCounting] = useState(false);
  const [addingKind, setAddingKind] = useState(false);

  // The current parent "type" of this unit (the `instance-of` pairing target),
  // resolved to {id, name}. Only fetched on instances that declare a parent.
  // Re-linking deletes the old pairing(s) and writes a new one.
  const parentQ = useQuery({
    queryKey: ["inventory-parent", id],
    enabled: !!id && !!parent,
    queryFn: async () => {
      const rows = (await api.listParentPairings(id!)).items;
      const first = rows[0];
      if (!first) return null;
      const target = await api.getPart(first.target_id);
      return { id: first.target_id, name: target.name };
    },
  });
  const setParent = useMutation({
    mutationFn: async (next: { id: string; name: string } | null) => {
      const rows = (await api.listParentPairings(id!)).items;
      for (const r of rows) await api.deletePairing(r.id);
      if (next) await api.createParentPairing(id!, next.id);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-parent", id] });
      void qc.invalidateQueries({ queryKey: ["inventory-part", id] });
    },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  // The kinds inside this assortment. Fetched unconditionally (the id is always
  // known) and simply empty for an ordinary part, because a hook cannot be
  // called conditionally.
  const kinds = useQuery({
    queryKey: ["assortment-kinds", orgSlug, id],
    queryFn: () => api.assortmentKinds(id),
    enabled: Boolean(id),
  });

  const addKind = useMutation({
    mutationFn: ({ name, approx }: { name: string; approx: number }) =>
      api.addAssortmentKind(id, name, approx),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["assortment-kinds", orgSlug, id] });
      setAddingKind(false);
    },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  const update = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.updatePart(id!, patch),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-part", id] });
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
    },
  });

  // "Use the serials/units" — a stock MOVEMENT, not a silent column write, so
  // the consumption ledger can explain it and every wire fires exactly as it
  // would for any other adjustment. A correction nobody can trace is how a
  // number stops being trusted. Stated side effect: a downward correction that
  // lands at/below min_qty fires inventory.stock.low and its wires, because you
  // genuinely are low.
  const adoptUnits = useMutation({
    mutationFn: async () => {
      const r = part.data?.reconcile;
      if (!r) return;
      const adj = adoptUnitsAdjustment(r);
      await api.stockAdjust(id!, adj.delta, adj.reason, { source_kind: adj.source_kind });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-part", id] });
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
    },
  });

  // Dismissal is keyed on the PAIR of numbers, not the model: the same stable
  // disagreement never re-asks, but a genuinely new one does. A plain metadata
  // key, written through the normal read-merge-write.
  const dismissReconcile = useMutation({
    mutationFn: async () => {
      const r = part.data?.reconcile;
      if (!r) return;
      await api.updatePart(id!, {
        metadata: {
          ...(part.data?.metadata ?? {}),
          reconcile_dismissed: { qty: r.qty, units_count: r.units_count },
        },
      });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["inventory-part", id] }),
  });

  const remove = useMutation({
    mutationFn: () => api.deletePart(id!),
    onSuccess: () => {
      toast.success(`${itemNoun.charAt(0).toUpperCase() + itemNoun.slice(1)} deleted.`);
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
      onClose();
    },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  // usePageTitle MUST run on every render — calling a hook after an
  // early return violates the Rules of Hooks. When the part query
  // transitions from isLoading=true to isLoading=false the hook
  // count would change between renders and React silently fails the
  // component (the page renders blank, no error in the console).
  usePageTitle(part.data?.name ?? itemNoun.charAt(0).toUpperCase() + itemNoun.slice(1));
  if (part.isLoading) return <div className="text-sm text-faint dark:text-slate-500">loading…</div>;
  if (part.error) {
    return <div className="text-sm text-ember-500">{(part.error as Error).message}</div>;
  }
  if (!part.data) return null;
  const p = part.data;

  // "Disassemble into parts" only makes sense for a KIT — a part
  // matched to a catalog set, still sealed/built (not yet parted out).
  // The platform's action `appliesTo` matches at the entity-KIND level
  // (every inventory:part looks alike), so this per-instance decision
  // lives here and is passed to EntityActionsBar. Hide it on plain
  // bricks (unmatched), explicitly-loose parts, and already-parted-out
  // kits — which is what a beta tester saw it wrongly offered on.
  const pmeta = (p.metadata as Record<string, unknown> | null) ?? {};
  const lifecycle = String(pmeta.lifecycle ?? pmeta.state ?? "");
  const looseOrDone = ["loose", "bulk", "spare", "parted-out"].includes(lifecycle);
  const canDisassemble = !!matched.data && !looseOrDone;
  // Keep the detail-page action bar to actions that act ON this item.
  // create-item / create-items are gone from here for good: they are declared
  // `scope: "workspace"` now, so the platform never offers them on a record.
  // They were listed here by hand, which fixed this page and left every other
  // detail page showing them.
  // update-item is a genuine per-page choice - it DOES act on this item, it
  // just duplicates the inline editing right here.
  // (The Lego kit→parts action also moved to the bricklink-connector module.)
  const excludeActionIds = [
    "inventory:update-item",
    ...(canDisassemble ? [] : ["bricklink:disassemble-kit"]),
    // "Split one off" only makes sense for a lot (qty > 1) — hide it on a
    // single item (splitting would have to leave 0).
    ...(Number(p.qty) > 1 ? [] : ["inventory:split-lot"]),
    // A lean catalog instance (films, books) shows no stock actions — using
    // one / using up / restocking a film is nonsensical. These match on the
    // global kind traits (stock-material), so exclude them here per-instance
    // until traits are derived per-instance. See one-record-substrate.md.
    ...(disclosure.stock
      ? []
      : [
          "inventory:use-one",
          "inventory:use-up",
          "inventory:replaced",
          "inventory:adjust-stock",
          "inventory:set-stock",
          "inventory:split-lot",
        ]),
  ];

  return (
    <div className="space-y-5">

      <ReconcileCard
        part={p}
        noun={itemNoun}
        busy={adoptUnits.isPending || dismissReconcile.isPending}
        onAdopt={() => adoptUnits.mutate()}
        onDismiss={() => dismissReconcile.mutate()}
      />

      {/* An assortment leads with what it actually is: a photo of a jumble and
          an estimate. Rendering it as a stock row makes a bin of fifty things
          look empty, which is the complaint this whole feature answers. The
          stock panels below still apply; this sits above them rather than
          replacing them, because a record can be part known. */}
      <AddKindModal
        open={addingKind}
        onClose={() => setAddingKind(false)}
        busy={addKind.isPending}
        onAdd={(name, approx) => addKind.mutate({ name, approx })}
        canSuggest={Boolean(p.image_path)}
        onSuggest={async () => {
          const r = await api.suggestKinds(id);
          return r.kinds;
        }}
        onAcceptAll={async (list) => {
          // Sequential on purpose: each is a create plus a placement, and firing
          // twelve at once at a fresh workspace is how you find the pool limit.
          for (const k of list) await api.addAssortmentKind(id, k.name, k.approximate_qty);
          void qc.invalidateQueries({ queryKey: ["assortment-kinds", orgSlug, id] });
          setAddingKind(false);
          toast.success(`Added ${list.length} ${list.length === 1 ? "kind" : "kinds"}`);
        }}
      />

      <CountAssortmentModal
        open={counting}
        onClose={() => setCounting(false)}
        noun={itemNoun}
        suggested={Number(p.approximate_qty ?? 0)}
        busy={update.isPending}
        onCount={(qty) => {
          // The graduation: a real quantity, and the estimate goes. SAME record,
          // same id, so its history and any printed label survive.
          update.mutate(
            { qty, approximate_qty: null },
            { onSuccess: () => setCounting(false) },
          );
        }}
      />

      {p.approximate_qty != null && (
        <AssortmentCard
          title={p.name}
          approximateQty={Number(p.approximate_qty)}
          note={p.description}
          imagePath={p.image_path ?? matched.data?.image_path ?? null}
          kinds={(kinds.data?.items ?? []).map((k) => ({
            id: k.id,
            name: k.title,
            approximate_qty:
              k.fields.approximate_qty == null ? null : Number(k.fields.approximate_qty),
            qty: k.fields.qty == null ? null : Number(k.fields.qty),
          }))}
          actions={
            <>
              <button
                type="button"
                onClick={() => setAddingKind(true)}
                className="rounded-lg bg-cobble-600 hover:bg-cobble-500 px-3 py-1.5 text-xs font-medium text-white transition"
              >
                Break into kinds
              </button>
              <button
                type="button"
                onClick={() => setCounting(true)}
                className="rounded-lg border border-line dark:border-slate-600 px-3 py-1.5 text-xs font-medium text-content dark:text-mortar-100 transition"
              >
                Count these
              </button>
            </>
          }
        />
      )}

      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
        <div className="flex items-start gap-4">
          <EntityThumb
            src={p.image_path ?? matched.data?.image_path ?? null}
            alt={p.name}
            size={96}
            color={(p.metadata as Record<string, unknown> | null)?.color as string | undefined}
            values={p.metadata as Record<string, unknown> | null}
            className="ring-1 ring-line dark:ring-slate-700"
          />
          <div className="flex-1 min-w-0">
            <div className="min-w-0">
              <EditableTitle
                value={p.name}
                onCommit={(v) => update.mutate({ name: v })}
                className="font-display text-xl sm:text-2xl font-bold text-content dark:text-mortar-100"
              />
              <div className="flex flex-wrap items-center gap-2 mt-1">
                {p.asset_id != null && (
                  <span className="text-[11px] font-mono uppercase tracking-widest text-muted dark:text-slate-400 bg-mortar-100 dark:bg-slate-800 rounded px-2 py-0.5">
                    #{String(p.asset_id).padStart(3, "0")}
                  </span>
                )}
                {matched.data && (
                  <span
                    className="text-[10px] inline-flex items-center gap-1 text-accent dark:text-cobble-300 bg-cobble-50 dark:bg-cobble-900/40 border border-cobble-200 dark:border-cobble-800 rounded px-1.5 py-0.5"
                    title={`Matched to ${matched.data.title} in ${matched.data.subtitle ?? "a catalog"}`}
                  >
                    <Library size={10} />
                    matched: {matched.data.title}
                  </span>
                )}
                <PrintQrButton partId={p.id} orgSlug={orgSlug} getToken={getToken} />
                {p.lifetime_warranty && (
                  <span className="text-[10px] inline-flex items-center gap-1 text-moss-600 border border-moss-200 dark:border-moss-800 rounded px-1.5 py-0.5">
                    lifetime warranty
                  </span>
                )}
                {p.insured && (
                  <span className="text-[10px] inline-flex items-center gap-1 text-accent border border-cobble-200 dark:border-cobble-800 rounded px-1.5 py-0.5">
                    <ShieldCheck size={10} /> insured
                  </span>
                )}
                {p.archived && (
                  <span className="text-[10px] inline-flex items-center gap-1 text-muted border border-line dark:border-slate-600 rounded px-1.5 py-0.5">
                    <Archive size={10} /> archived
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
        {/* Actions on their own full-width row so a long button row never
            crushes the title (the bar wraps internally). */}
        <EntityActionsBar
          entityKind="inventory:part"
          entityId={p.id}
          excludeActionIds={excludeActionIds}
        />
        <div className="grid grid-cols-2 gap-3">
          {/* Quantity + unit read as ONE control: an inline +/- stepper sits
              flush against the unit ("[-] 1 [+] skein") so it's clear they
              belong together. The stepper writes through the same signed
              stock-adjust API as before — no modal hop. */}
          {(!hide("qty") || !hide("unit")) && (
          <Field label="Qty" className="col-span-2">
            <div className="flex items-center gap-2">
              {!hide("qty") &&
                // An uncounted assortment showed "[-] 0 [+]" directly under a
                // card reading "~50 estimated, not counted" — the page
                // contradicting itself, and one click on + silently turning a
                // guess into a count of 1. Counting is the deliberate act on
                // the card ("Count these"), so say what is true instead.
                // A record carrying BOTH a count and an estimate still shows
                // the count: hiding a real number would be the worse lie.
                (isAssorted(p) && Number(p.qty) === 0 ? (
                  <span className="text-muted text-sm" data-qty-uncounted="true">
                    not counted
                  </span>
                ) : (
                  <QtyStepper partId={p.id} qty={Number(p.qty)} />
                ))}
              {!hide("unit") && (
                // Changing the unit auto-converts the quantity when the two are
                // interconvertible (1000 g → kg = 1); otherwise just the unit
                // changes. (e55169b1)
                <UnitInput
                  className="w-32"
                  value={p.unit}
                  onCommit={(v) => {
                    const n = Number(p.qty);
                    const c = Number.isFinite(n) ? units.convert(n, p.unit, v) : null;
                    update.mutate(c != null ? { unit: v, qty: c } : { unit: v });
                  }}
                />
              )}
            </div>
          </Field>
          )}
          {!hide("min_qty") && (
          <Field label={fp.label("min_qty", "Min qty")}>
            <InlineText
              value={p.min_qty ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ min_qty: v === "" ? null : Number(v) })}
              numeric
            />
          </Field>
          )}
          {!hide("cost") && (
          <Field label={fp.label("cost", "Cost")}>
            <InlineText
              value={p.cost ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ cost: v === "" ? null : Number(v) })}
              numeric
            />
          </Field>
          )}
          {!hide("category") && (
          <Field label={fp.label("category", "Category")}>
            <select
              value={p.category_id ?? ""}
              onChange={(e) => update.mutate({ category_id: e.target.value || null })}
              className="input"
            >
              <option value=""> - none - </option>
              {cats.data?.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          )}
          {!hide("location") && (
          <Field label={fp.label("location", "Location")}>
            <select
              value={p.location_id ?? ""}
              onChange={(e) => update.mutate({ location_id: e.target.value || null })}
              className="input"
            >
              <option value=""> - none - </option>
              {locs.data?.items.map((l) => (
                <option key={l.id} value={l.id}>
                  {"  ".repeat(l.depth)}
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          )}
          {!hide("manufacturer") && (
          <Field label={fp.label("manufacturer", "Manufacturer")}>
            <InlineText
              value={p.manufacturer ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ manufacturer: v || null })}
            />
          </Field>
          )}
          {!hide("supplier_url") && (
          <Field label={fp.label("supplier_url", "Supplier URL")}>
            <InlineText
              value={p.supplier_url ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ supplier_url: v || null })}
            />
          </Field>
          )}
          {!hide("serial_number") && (
          <Field label={fp.label("serial_number", "Serial number")}>
            <InlineText
              value={p.serial_number ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ serial_number: v || null })}
            />
          </Field>
          )}
          {!hide("model_number") && (
          <Field label={fp.label("model_number", "Model number")}>
            <InlineText
              value={p.model_number ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ model_number: v || null })}
            />
          </Field>
          )}
          {/* The individual's holder. Generic + relabelable (a library calls it
              "Borrower", IT "Assigned to"); see per-unit-assignment.md. */}
          {!hide("assigned_to") && (
          <Field label={fp.label("assigned_to", "Assigned to")}>
            <InlineText
              value={p.assigned_to ?? ""}
              placeholder="—"
              onCommit={(v) => update.mutate({ assigned_to: v || null })}
            />
          </Field>
          )}
          {/* The individual face's number, shown only once this model actually
              has serials on file. Read-only by construction: it counts unit
              rows, so the way to change it is to add or retire a unit. */}
          {(p.units_count ?? 0) > 0 && (
            <Field label="Units on file">
              <span className="text-sm text-content dark:text-mortar-100">
                {p.units_count} {p.units_count === 1 ? "unit" : "units"}
                {Number(p.qty) > (p.units_count ?? 0) && (
                  <span className="ml-2 text-xs text-muted dark:text-slate-400">
                    ({Number(p.qty) - (p.units_count ?? 0)} not yet scanned)
                  </span>
                )}
              </span>
            </Field>
          )}
        </div>
        <Field label="Notes">
          <InlineTextarea
            value={p.notes ?? ""}
            onCommit={(v) => update.mutate({ notes: v || null })}
          />
        </Field>
      </div>

      {/* Parent / "type" link — the unit's type lives in another instance
          (Spool → Filament type). Editable: re-picking re-links the pairing. */}
      {parent && (
        <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4">
          <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1.5">
            {parent.label ?? "Type"}
          </div>
          <ParentPicker
            instance={parent.instance}
            value={parentQ.data ?? null}
            onChange={(v) => setParent.mutate(v)}
            placeholder={`Search ${parent.label?.toLowerCase() ?? "type"}…`}
          />
        </div>
      )}

      {/* The instance's own fields, promoted to the top (right under the
          identity card) — the point of a skinned instance is that THESE are
          the fields that matter, not the generic inventory ones below. */}
      <CustomFieldsPanel
        entityKind={entityKind}
        entityId={p.id}
        values={(p.metadata as Record<string, unknown> | null) ?? {}}
        fallbackValues={matched.data?.fields}
        fallbackLabel={matched.data ? `catalog (${matched.data.title})` : undefined}
        onCommit={(name, value) =>
          update.mutate({
            metadata: {
              ...((p.metadata as Record<string, unknown> | null) ?? {}),
              [name]: value,
            },
          })
        }
      />

      {!hide("warranty") && (
      <div className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-5 space-y-3">
        <h3 className="text-[10px] font-mono uppercase tracking-widest text-muted dark:text-slate-400">
          warranty & status
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Warranty expires">
            <InlineText
              value={
                p.warranty_expires
                  ? new Date(p.warranty_expires).toISOString().slice(0, 10)
                  : ""
              }
              placeholder="YYYY-MM-DD"
              onCommit={(v) =>
                update.mutate({ warranty_expires: v.trim() === "" ? null : v.trim() })
              }
            />
          </Field>
          <Field label="Lifetime warranty">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={p.lifetime_warranty}
                onChange={(e) => update.mutate({ lifetime_warranty: e.target.checked })}
                className="accent-cobble-500"
              />
              <span className="text-muted dark:text-slate-400">no expiry</span>
            </label>
          </Field>
        </div>
        <Field label="Warranty details">
          <InlineTextarea
            value={p.warranty_details ?? ""}
            onCommit={(v) => update.mutate({ warranty_details: v || null })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3 pt-2">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={p.insured}
              onChange={(e) => update.mutate({ insured: e.target.checked })}
              className="accent-cobble-500"
            />
            <span className="text-content dark:text-mortar-200 inline-flex items-center gap-1">
              <ShieldCheck size={12} /> Insured
            </span>
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={p.archived}
              onChange={(e) => update.mutate({ archived: e.target.checked })}
              className="accent-cobble-500"
            />
            <span className="text-content dark:text-mortar-200 inline-flex items-center gap-1">
              <Archive size={12} /> Archived
              <span className="text-[10px] text-faint">(hidden from default list)</span>
            </span>
          </label>
        </div>
      </div>
      )}

      <PartGallery
        partId={p.id}
        coverImagePath={p.image_path}
        onSetCover={(imagePath) => update.mutate({ image_path: imagePath })}
      />

      {!hide("maintenance") && (
        <MaintenancePanel entityModule="inventory" entityType="part" entityId={p.id} />
      )}

      {!hide("consumable") && (
        <ConsumptionPanel
          partId={p.id}
          partName={p.name}
          qty={Number(p.qty)}
          unit={p.unit}
          capacity={pmeta.capacity != null ? Number(pmeta.capacity) : null}
          metadata={pmeta}
          trackedBy={typeof pmeta.tracked_by === "string" ? pmeta.tracked_by : null}
          // Instances whose bundle declares the `consumable` section (e.g. Yarn)
          // present consumption tracking as active by default, rather than an
          // opt-in link. Generic — driven by the per-instance override, no
          // per-bundle branch here.
          defaultOn={fp.configured("consumable")}
          onSetCapacity={(c) => update.mutate({ metadata: { ...pmeta, capacity: c } })}
        />
      )}

      {!hide("allocations") && <AllocationsPanel partId={p.id} />}

      <div id="units">
        <UnitsPanel partId={p.id} />
      </div>

      {/* Contents — anything physically placed INSIDE this item. Any physical
          record can be a container (a box, a bag, a kit, a case), so an opaque
          "box of mugs" tracked as one item can be itemized later: open it and add
          the individual mugs inside. Same generic panel the machines/assets pages
          use; the placement primitive gates what can actually go in. */}
      <ContentsPanel
        slug={orgSlug}
        getToken={getToken}
        container={{ kind: "inventory:part", id: p.id }}
        title="Contents"
        scanIntoHref={`/scan/camera?container_kind=${encodeURIComponent("inventory:part")}&container_id=${encodeURIComponent(p.id)}`}
      />

      {/* Whatever ENABLED modules declare for inventory:part in their manifest
          (contributes.panels) — purchases' price history arrives this way.
          This page names no contributor and imports nothing from one. */}
      <ContributedDetailPanels
        target="inventory:part"
        ctx={{ slug: orgSlug, entityId: p.id, entityTitle: p.name }}
      />

      <div className="flex items-center justify-center gap-4 pt-4">
        <button
          onClick={() => setDup(true)}
          className="text-xs text-faint dark:text-slate-500 hover:text-accent inline-flex items-center gap-1.5"
        >
          <Copy size={12} /> Duplicate
        </button>
        <button
          onClick={() => setMoving(true)}
          className="text-xs text-faint dark:text-slate-500 hover:text-accent inline-flex items-center gap-1.5"
        >
          <ArrowRightLeft size={12} /> Move to…
        </button>
        <button
          onClick={async () => {
            const ok = await confirm({
              title: `Delete "${p.name}"?`,
              message: "This can't be undone. Allocations to other modules' entities are released.",
              confirmLabel: "Delete part",
              destructive: true,
            });
            if (ok) remove.mutate();
          }}
          className="text-xs text-faint dark:text-slate-500 hover:text-ember-500 inline-flex items-center gap-1.5"
        >
          <Trash2 size={12} /> Delete this {itemNoun}
        </button>
      </div>

      <MoveToInstanceModal
        open={moving}
        onClose={() => setMoving(false)}
        slug={orgSlug}
        getToken={getToken}
        moduleName="inventory"
        fromInstance={instance ?? "inventory"}
        ids={[id]}
        noun={itemNoun}
        onMoved={(_n, where) => {
          toast.success(`Moved to ${where}`);
          // Invalidate before closing: the list underneath is cached, and
          // without this the record you just moved is still sitting in the list
          // you moved it out of. The toast says it left, the screen says it did
          // not, and the screen is what people believe.
          void qc.invalidateQueries();
          onClose();
        }}
      />

      {dup && (
        // Seed a fresh create form from this item — the user reviews + saves,
        // so it's a new row, not a silent clone. Custom fields carry over.
        <NewPartDialog
          seed={{
            name: `${p.name} (copy)`,
            qty: p.qty,
            unit: p.unit,
            manufacturer: p.manufacturer,
            cost: p.cost,
            category_id: p.category_id,
            location_id: p.location_id,
            fields: (p.metadata as Record<string, unknown> | null) ?? undefined,
            parent: parentQ.data ?? undefined,
          }}
          onClose={() => setDup(false)}
          onCreated={() => {
            setDup(false);
            toast.success(`Duplicated "${p.name}".`);
            void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
          }}
        />
      )}
    </div>
  );
}

// PrintQrButton — mints a QR token bound to this part (if one doesn't
// already exist) then routes the labels module to print a QR label
// for it. The "moment of magic" parity with HomeBox's per-item label
// button.
function PrintQrButton({
  partId,
  orgSlug,
  getToken,
}: {
  partId: string;
  orgSlug: string;
  getToken: () => string | null;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const auth = (): Record<string, string> => {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  };

  async function printQr() {
    setBusy(true);
    try {
      // 1. Reuse an active navigate-mode token, or mint one.
      const list = await fetch(
        `/api/v1/orgs/${orgSlug}/modules/labels/qr/tokens?entity_kind=inventory:part&entity_id=${encodeURIComponent(partId)}`,
        { headers: auth() },
      );
      // scan_url is the full URL to encode, built server-side from the
      // workspace's effective base (custom label base URL, else the serving
      // origin) — never guess window.location.origin here.
      let scanUrl: string | null = null;
      let entityName = "";
      if (list.ok) {
        const data = (await list.json()) as {
          items: Array<{ id: string; scan_url: string; revoked_at: string | null }>;
        };
        const active = data.items.find((t) => !t.revoked_at);
        if (active) scanUrl = active.scan_url;
      }
      if (!scanUrl) {
        const res = await fetch(
          `/api/v1/orgs/${orgSlug}/modules/labels/qr/tokens`,
          {
            method: "POST",
            headers: { ...auth(), "Content-Type": "application/json" },
            body: JSON.stringify({
              entity_kind: "inventory:part",
              entity_id: partId,
              mode: "navigate",
              auth: "session",
            }),
          },
        );
        if (!res.ok) throw new Error(`mint token: ${res.status}`);
        const data = (await res.json()) as { scan_url: string };
        scanUrl = data.scan_url;
      }
      // Fetch the part name for the label description.
      const partRes = await fetch(
        `/api/v1/orgs/${orgSlug}/modules/inventory/parts/${partId}`,
        { headers: auth() },
      );
      if (partRes.ok) {
        const part = (await partRes.json()) as { name?: string; asset_id?: number };
        entityName =
          part.asset_id != null
            ? `#${String(part.asset_id).padStart(3, "0")} ${part.name ?? ""}`.trim()
            : (part.name ?? "");
      }
      // 2. Queue a label-print job. qr_payload is the unauthenticated
      //    resolver URL — any QR reader pointed at it lands on the
      //    workspace's part detail.
      const qrUrl = scanUrl;
      const q = await fetch(
        `/api/v1/orgs/${orgSlug}/modules/labels/queue`,
        {
          method: "POST",
          headers: { ...auth(), "Content-Type": "application/json" },
          body: JSON.stringify({
            module_name: "inventory",
            entity_type: "part",
            entity_id: partId,
            qr_payload: qrUrl,
            description: entityName || "Part",
            qty: 1,
          }),
        },
      );
      if (!q.ok && q.status !== 409) throw new Error(`queue: ${q.status}`);
      toast.success("QR label queued - open Labels → Queue to print.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void printQr()}
      disabled={busy}
      className="text-[11px] font-mono uppercase tracking-widest text-accent hover:text-accent inline-flex items-center gap-1 border border-cobble-200 dark:border-cobble-800 rounded px-1.5 py-0.5 disabled:opacity-50"
      title="Mint a QR token and queue a label print"
    >
      <Printer size={11} /> {busy ? "queueing…" : "QR label"}
    </button>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

/** The part title. A single-line <input> can't wrap, so a long name (e.g.
 *  "Loops & Thread Impeccable") clipped mid-word on a narrow phone. This renders
 *  the name as a WRAPPING heading and only swaps to an input when tapped to
 *  rename — so long names wrap to two lines instead of being cut off. */
function EditableTitle({
  value,
  onCommit,
  className,
}: {
  value: string;
  onCommit: (v: string) => void;
  className: string;
}) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={value}
        onBlur={(e) => {
          setEditing(false);
          if (e.target.value !== value) onCommit(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            (e.target as HTMLInputElement).value = value;
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={`${className} w-full min-w-0`}
      />
    );
  }
  return (
    <h1
      onClick={() => setEditing(true)}
      title="Click to rename"
      className={`${className} w-full min-w-0 break-words cursor-text leading-tight`}
    >
      {value || <span className="text-faint dark:text-slate-500 font-normal">Unnamed</span>}
    </h1>
  );
}

function InlineText({
  value,
  onCommit,
  placeholder,
  numeric,
  className = "input",
}: {
  value: string | number | null;
  onCommit: (v: string) => void;
  placeholder?: string;
  numeric?: boolean;
  className?: string;
}) {
  const initial = value == null ? "" : String(value);
  const [draft, setDraft] = useState(initial);
  function commit(e: FocusEvent<HTMLInputElement>) {
    if (e.target.value !== initial) onCommit(e.target.value);
  }
  return (
    <input
      type={numeric ? "number" : "text"}
      step={numeric ? "any" : undefined}
      defaultValue={initial}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          (e.target as HTMLInputElement).value = initial;
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder={placeholder}
      className={className}
      // suppress 'unused var' linter
      data-draft={draft}
    />
  );
}

function InlineTextarea({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (v: string) => void;
}) {
  return (
    <textarea
      defaultValue={value}
      onBlur={(e) => {
        if (e.target.value !== value) onCommit(e.target.value);
      }}
      rows={3}
      className="input"
    />
  );
}

// Part detail rendered as a MODAL over the list (D4 — consistent with
// machine detail). The list route /inventory/parts/:id keeps the list
// mounted and opens this; the title comes from a light name query
// (deduped with the body's part query by react-query).
export function PartDetailModal({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const { api, itemNoun } = useInventory();
  const part = useQuery({
    queryKey: ["inventory-part", id],
    queryFn: () => api.getPart(id),
    enabled: !!id,
  });
  // While the record loads, title with the instance's own noun ("Film"), never a
  // hardcoded "Part". See one-record-substrate.md (vocabulary is per-instance).
  const loadingTitle = itemNoun.charAt(0).toUpperCase() + itemNoun.slice(1);
  return (
    <Modal open onClose={onClose} title={part.data?.name ?? loadingTitle} size="xl">
      <PartDetailPage id={id} onClose={onClose} />
    </Modal>
  );
}

// Consumption / spool view. `qty` is what's REMAINING; metadata.capacity is the
// full / new amount (a 1kg spool). The ledger (inventory_consumption) is what
// drew it down and how much — the spool's print/usage history. Generic: works
// for filament, yarn, tape, anything you set a capacity on.
//
// Two faces, one section:
//   • FLAT (default, unchanged) — one gauge over the whole item's qty. This is
//     what every consumable shows today and keeps showing until the user opts
//     in per item.
//   • PER-UNIT (opt-in) — models each opened skein/spool/box as its own unit
//     with its own remaining + ledger, and a simple by-state COUNT ("3 skeins ·
//     2 new · 1 open"). NEVER a total across units. See
//     docs/design-decisions/consumption-ledger.md.
// The flag lives on the model's own metadata (per_unit_tracking); flipping it is
// non-destructive and reversible — no data moves, no unit rows are created.
function ConsumptionPanel({
  partId,
  partName,
  qty,
  unit,
  capacity,
  metadata,
  trackedBy,
  defaultOn = false,
  onSetCapacity,
}: {
  partId: string;
  partName: string;
  qty: number;
  unit: string;
  capacity: number | null;
  metadata: Record<string, unknown>;
  trackedBy?: string | null;
  /** The instance treats its items as consumables (bundle-declared), so the
   *  section presents as active instead of a collapsed opt-in link. */
  defaultOn?: boolean;
  onSetCapacity: (c: number | null) => void;
}) {
  const { api } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();

  // Opt-in flag write — merges into the existing metadata (never clobbers other
  // fields) and refreshes the item. Turning it OFF leaves any unit rows in place
  // (archived, harmless): disclosure is never destructive.
  const setPerUnit = useMutation({
    mutationFn: (on: boolean) =>
      api.updatePart(partId, { metadata: { ...metadata, [PER_UNIT_TRACKING_KEY]: on } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["inventory-part", partId] });
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
    },
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  // External tracker (Spoolman) owns the count — per-unit tracking isn't offered
  // there. Otherwise, an opted-in item shows the per-unit face.
  if (!trackedBy && isPerUnitTracking(metadata)) {
    return (
      <PerUnitConsumptionPanel
        partId={partId}
        partName={partName}
        modelQty={qty}
        countUnit={unit}
        legacyCapacity={capacity}
        modelMetadata={metadata}
        onDisable={() => setPerUnit.mutate(false)}
      />
    );
  }

  return (
    <FlatConsumptionPanel
      partId={partId}
      qty={qty}
      unit={unit}
      capacity={capacity}
      trackedBy={trackedBy}
      defaultOn={defaultOn}
      onSetCapacity={onSetCapacity}
      onEnablePerUnit={trackedBy ? undefined : () => setPerUnit.mutate(true)}
    />
  );
}

// The original single-gauge consumption face — unchanged behaviour, plus a
// subtle "track each <unit> separately" link that opts THIS item into the
// per-unit face (only when the section is active and not externally tracked).
function FlatConsumptionPanel({
  partId,
  qty,
  unit,
  capacity,
  trackedBy,
  defaultOn = false,
  onSetCapacity,
  onEnablePerUnit,
}: {
  partId: string;
  qty: number;
  unit: string;
  capacity: number | null;
  trackedBy?: string | null;
  defaultOn?: boolean;
  onSetCapacity: (c: number | null) => void;
  onEnablePerUnit?: () => void;
}) {
  const { api } = useInventory();
  const [editing, setEditing] = useState(false);
  const [cap, setCap] = useState(capacity != null ? String(capacity) : "");
  const log = useQuery({ queryKey: ["inventory-consumption", partId], queryFn: () => api.listConsumption(partId) });
  const rows = log.data?.items ?? [];
  const pct = capacity && capacity > 0 ? Math.max(0, Math.min(100, Math.round((qty / capacity) * 100))) : null;

  // Externally tracked (e.g. a Spoolman spool): Spoolman owns the remaining; we
  // mirror it and don't deduct. Show the source, the gauge, no editor/ledger.
  if (trackedBy) {
    const label = trackedBy.charAt(0).toUpperCase() + trackedBy.slice(1);
    return (
      <section className="rounded-xl border border-line dark:border-slate-700 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-content dark:text-mortar-100">Consumption</h3>
          <span className="text-[10px] font-mono uppercase tracking-wider text-accent dark:text-cobble-300 bg-cobble-50 dark:bg-cobble-900/40 border border-cobble-200 dark:border-cobble-800 rounded px-1.5 py-0.5">
            tracked by {label}
          </span>
        </div>
        <div>
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-content dark:text-mortar-100">
              <b>{qty}</b> {unit} left
            </span>
            {capacity != null && pct != null && (
              <span className="text-faint text-xs">
                of {capacity} {unit} · {pct}%
              </span>
            )}
          </div>
          {capacity != null && pct != null && (
            <div className="mt-1 h-2 rounded bg-line dark:bg-slate-700 overflow-hidden">
              <div className={`h-full ${pct <= 15 ? "bg-ember-500" : "bg-moss-500"}`} style={{ width: `${pct}%` }} />
            </div>
          )}
          <div className="text-[11px] text-faint mt-1">{label} owns this spool's count - Cobblr mirrors it on sync and doesn't deduct.</div>
        </div>
      </section>
    );
  }

  // Not a consumable yet (no capacity, no history). On a generic instance this
  // stays a quiet opt-in link (a screw isn't a consumable). On an instance whose
  // bundle turned consumable-tracking on (defaultOn — e.g. Yarn), skip the link
  // and fall through to the active section so setting a capacity is right there.
  if (capacity == null && rows.length === 0 && !editing && !defaultOn) {
    return (
      <div className="pt-1">
        <button onClick={() => setEditing(true)} className="text-[11px] text-faint hover:text-accent">
          + Track as a consumable (set a full capacity)
        </button>
      </div>
    );
  }

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-content dark:text-mortar-100">Consumption</h3>
        <div className="flex-1" />
        {!editing && (
          <button
            onClick={() => {
              setCap(capacity != null ? String(capacity) : "");
              setEditing(true);
            }}
            className="text-[11px] text-faint hover:text-accent"
          >
            {capacity != null ? "Edit capacity" : "Set capacity"}
          </button>
        )}
      </div>

      {capacity == null && !editing && rows.length === 0 && (
        <p className="text-[11px] text-faint">
          Set a full amount to track how much is left as you use it up.
        </p>
      )}

      {editing ? (
        <div className="flex items-center gap-2">
          <input
            type="number"
            min="0"
            step="any"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            placeholder={`full amount (${unit})`}
            className="w-44 px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            autoFocus
          />
          <button
            onClick={() => {
              onSetCapacity(cap.trim() ? Number(cap) : null);
              setEditing(false);
            }}
            className="text-xs rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2.5 py-1"
          >
            Save
          </button>
          <button onClick={() => setEditing(false)} className="text-xs text-faint hover:text-content">
            Cancel
          </button>
        </div>
      ) : capacity != null && pct != null ? (
        <div>
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-content dark:text-mortar-100">
              <b>{qty}</b> {unit} left
            </span>
            <span className="text-faint text-xs">
              of {capacity} {unit} · {pct}%
            </span>
          </div>
          <div className="mt-1 h-2 rounded bg-line dark:bg-slate-700 overflow-hidden">
            <div className={`h-full ${pct <= 15 ? "bg-ember-500" : "bg-moss-500"}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      ) : null}

      {rows.length > 0 && (
        <div className="space-y-1">
          <div className="text-[11px] font-mono uppercase tracking-wider text-faint">History</div>
          <ul className="divide-y divide-line dark:divide-slate-800">
            {rows.map((r) => {
              const d = Number(r.delta);
              return (
                <li key={r.id} className="py-1.5 flex items-center gap-2 text-[13px]">
                  <span className={"font-medium tabular-nums " + (d < 0 ? "text-ember-600 dark:text-ember-500" : "text-moss-600 dark:text-moss-400")}>
                    {d < 0 ? "" : "+"}
                    {d} {unit}
                  </span>
                  <span className="text-muted dark:text-slate-400 truncate flex-1">{r.reason ?? r.source_kind ?? "adjustment"}</span>
                  <span className="text-[11px] text-faint shrink-0">{new Date(r.at).toLocaleDateString()}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Opt into per-unit tracking (§9). Only when the section is active
          (capacity set or bundle-declared) — a flat gauge with no capacity has
          nothing to break into units yet. Non-destructive + reversible. */}
      {onEnablePerUnit && (capacity != null || defaultOn) && !editing && (
        <button
          onClick={onEnablePerUnit}
          className="text-[11px] text-faint hover:text-accent"
          title={`Track each ${unit} on its own — a by-state count with the open one's remaining`}
        >
          Track each {unit} separately →
        </button>
      )}
    </section>
  );
}

// ── Per-unit (per-skein) consumption face ─────────────────────────────────────
//
// The simple by-state face (consumption-ledger.md §4.1): a by-state COUNT
// ("3 skeins · 2 new · 1 open") with the open unit's remaining shown subtly —
// never a total across units. Each opened unit is a child part under the model
// (linked by an instance-of pairing, kept out of lists via `archived`), so it
// reuses the existing per-part ledger + gauge machinery with no new engine.
function PerUnitConsumptionPanel({
  partId,
  partName,
  modelQty,
  countUnit,
  legacyCapacity,
  modelMetadata,
  onDisable,
}: {
  partId: string;
  partName: string;
  /** The model's own qty = the count of unopened, fungible spares (the "new"). */
  modelQty: number;
  /** The unit the COUNT is in (skein / spool / box). */
  countUnit: string;
  /** Legacy manually-typed capacity, used only as a fallback. */
  legacyCapacity: number | null;
  /** The model's metadata — carries the tunable close-out threshold override. */
  modelMetadata: Record<string, unknown>;
  onDisable: () => void;
}) {
  const { api, entityKind } = useInventory();
  const qc = useQueryClient();
  const toast = useToast();

  // Field defs → detect a DERIVED `capacity` computed def + read its consumed
  // unit ("m") and its source field for the provenance chip.
  const defs = useQuery({
    queryKey: ["inventory-fielddefs", entityKind],
    queryFn: () => api.listFieldDefs(entityKind),
    staleTime: 60_000,
  });
  const capDef = (defs.data?.items ?? []).find((d) => d.name === "capacity" && d.type === "computed");
  const consumedUnit = capDef?.unit || "";
  const sourceField = capacitySourceField(capDef?.template ?? null);
  const sourceLabel = sourceField
    ? (defs.data?.items ?? []).find((d) => d.name === sourceField)?.display_label ?? sourceField
    : null;

  // Resolved model entity → the computed per-unit capacity (e.g. length_per_skein).
  const resolved = useQuery({
    queryKey: ["inventory-resolved", entityKind, partId],
    queryFn: () => api.lookupResolvedEntity(entityKind, partId),
    enabled: !!capDef,
    staleTime: 10_000,
  });
  const resolvedCap = numOr(resolved.data?.fields?.capacity);
  const unitCapacity = resolveUnitCapacity({ resolvedCapacity: resolvedCap, metadataCapacity: legacyCapacity });
  const derived = resolvedCap != null && resolvedCap > 0;

  // The model's open/empty unit children (reverse instance-of lookup → fetch each).
  const unitsQ = useQuery({
    queryKey: ["inventory-units", partId],
    queryFn: async () => {
      const pairs = (await api.listChildPairings(partId)).items;
      const parts = await Promise.all(pairs.map((p) => api.getPart(p.source_id).catch(() => null)));
      return parts
        .filter((p): p is NonNullable<typeof p> => !!p)
        .map((p) => parseUnitRecord(
          { id: p.id, name: p.name, qty: Number(p.qty), metadata: p.metadata as Record<string, unknown> | null },
          unitCapacity,
        ));
    },
    staleTime: 5_000,
  });
  const units = unitsQ.data ?? [];
  const pool = summarizePool(modelQty, units);
  const nounSingular = countUnit || "unit";
  const nounPlural = pluralizeUnit(nounSingular);

  // Project bindings (§3): a reserved allocation whose part_id is an open unit
  // binds that skein to a project. One instance-wide fetch, grouped by unit, so
  // the panel derives the EXPANDED face (§4.2) from real bindings rather than a
  // toggle. Reserved-only — a released/consumed allocation is history.
  const allocsQ = useQuery({
    queryKey: ["inventory-unit-allocs", partId],
    queryFn: () => api.listAllocations({ status: "reserved" }),
    staleTime: 5_000,
  });
  const allByPart = new Map<string, AllocationLike[]>();
  for (const a of allocsQ.data?.items ?? []) {
    const list = allByPart.get(a.part_id) ?? [];
    list.push(a);
    allByPart.set(a.part_id, list);
  }
  const bindingFor = (unitId: string): UnitBinding | null => bindingOf(allByPart.get(unitId) ?? []);
  const boundCount = pool.open.filter((u) => bindingFor(u.id)).length;
  // Skeins that RAN OUT (empty) while still bound — their project may want the
  // next spare. `units` (unlike pool.open) still carries the empties.
  const spentBound = units
    .filter((u) => !(u.qty > 0))
    .map((u) => ({ unit: u, binding: bindingFor(u.id) }))
    .filter((x): x is { unit: UnitRecord; binding: UnitBinding } => x.binding != null);
  // Derived, never a mode toggle: two-or-more open units OR any binding earns
  // the per-unit/per-project card face; a lone unbound skein stays simple.
  const expanded = isExpandedFace(pool.open.length, boundCount);
  const thresholdPct = resolveThresholdPct(modelMetadata);
  // The by-state breakdown ("2 new · 1 open") — a new-only pool shows none, the
  // same rule the tested poolCountLabel encodes. The total + its noun render
  // separately (emphasised) so we don't re-parse the label string.
  const breakdown = [
    pool.newCount > 0 ? `${pool.newCount} new` : null,
    pool.openCount > 0 ? `${pool.openCount} open` : null,
  ].filter(Boolean).join(" · ");
  const showBreakdown = pool.openCount > 0;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["inventory-units", partId] });
    void qc.invalidateQueries({ queryKey: ["inventory-unit-allocs", partId] });
    void qc.invalidateQueries({ queryKey: ["inventory-part", partId] });
    void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
  };

  // Mint one open unit: a child at full capacity, its opening ledger line, the
  // instance-of link to the model, and the model's spare count down by one. If a
  // project target is given, also bind the new skein to it (an allocation) so
  // "open the next spare FOR the scarf" is one call — per-project continuation
  // (§3). Every qty move goes through the shared writer, so each leaves a line.
  const mintOpenUnit = async (bindTo?: PickedEntity) => {
    if (unitCapacity == null) throw new Error(`Set a per-${countUnit || "unit"} amount first.`);
    const child = await api.createPart({
      name: `${partName} (open ${countUnit || "unit"})`,
      unit: consumedUnit || countUnit || "unit",
      qty: 0,
      archived: true,
      metadata: buildUnitMetadata(partId, unitCapacity),
    });
    await api.stockAdjust(child.id, unitCapacity, `Opened ${countUnit || "unit"}`);
    await api.createParentPairing(child.id, partId);
    if (modelQty > 0) await api.stockAdjust(partId, -1, `Opened a ${countUnit || "unit"}`);
    if (bindTo) {
      await api.createAllocation({
        part_id: child.id,
        qty: unitCapacity,
        target_module: bindTo.module,
        target_entity_type: bindTo.type,
        target_entity_id: bindTo.id,
        reason: bindTo.label,
      });
    }
  };

  // Open a spare, unbound.
  const openOne = useMutation({
    mutationFn: () => mintOpenUnit(),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  // Continue a project onto a fresh skein (§3): mint the next open unit bound to
  // the same project. Used when a project's current skein is spent.
  const continueProject = useMutation({
    mutationFn: (target: PickedEntity) => mintOpenUnit(target),
    onSuccess: invalidate,
    onError: (e: unknown) => toast.error((e as Error).message),
  });

  const loading = defs.isLoading || unitsQ.isLoading || (!!capDef && resolved.isLoading);

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-content dark:text-mortar-100">Consumption</h3>
        {/* Provenance chip (§8.3) — is the full amount derived or typed? */}
        {derived && sourceLabel ? (
          <span
            className="text-[10px] font-mono uppercase tracking-wider text-accent dark:text-cobble-300 bg-cobble-50 dark:bg-cobble-900/40 border border-cobble-200 dark:border-cobble-800 rounded px-1.5 py-0.5"
            title={`Each ${countUnit || "unit"}'s full amount comes from “${sourceLabel}”.`}
          >
            full from {sourceLabel}
          </span>
        ) : unitCapacity != null ? (
          <span className="text-[10px] font-mono uppercase tracking-wider text-faint border border-line dark:border-slate-700 rounded px-1.5 py-0.5">
            set manually
          </span>
        ) : null}
        <div className="flex-1" />
        <button onClick={onDisable} className="text-[11px] text-faint hover:text-accent" title="Go back to a single gauge over the whole item">
          simple view
        </button>
      </div>

      {/* The headline: a by-state count, never a metres total. */}
      <div className="text-content dark:text-mortar-100">
        <span className="text-base font-semibold">{pool.totalCount}</span>{" "}
        <span className="text-sm">{pool.totalCount === 1 ? nounSingular : nounPlural}</span>
        {showBreakdown && (
          <span className="text-sm text-faint">{"  ·  "}{breakdown}</span>
        )}
      </div>

      {/* No derived/typed capacity yet → point at the source field (§8.4). */}
      {unitCapacity == null && !loading && (
        <p className="text-[11px] text-faint">
          {sourceLabel
            ? `Add a ${sourceLabel} above to derive each ${countUnit || "unit"}'s full amount.`
            : `Set a full amount per ${countUnit || "unit"} to track what's left as you use it.`}
        </p>
      )}

      {/* The open unit(s): subtle remaining + gauge + its own statement. One at a
          time (simple face) in the common case; the expanded per-project card
          face (bindings + finish/continue) only once state contains real
          parallelism or a binding (§4.2), derived not toggled. */}
      {pool.open.map((u) => (
        <OpenUnitCard
          key={u.id}
          unit={u}
          consumedUnit={consumedUnit}
          countUnit={countUnit || "unit"}
          binding={bindingFor(u.id)}
          expanded={expanded}
          thresholdPct={thresholdPct}
          onChanged={invalidate}
        />
      ))}

      {/* Per-project continuation (§3). A bound skein that ran OUT drops off the
          open cards (it's empty), but its project may want the next spare — so
          surface each spent-but-still-bound skein here: roll onto a fresh unit
          bound to the same project, or mark the project done (clear the binding).
          Reached only when a real binding outlived its skein — derived, not a mode. */}
      {spentBound.map(({ unit: u, binding: b }) => (
        <div key={u.id} className="rounded-lg border border-dashed border-line dark:border-slate-700 p-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
          <span className="text-faint">{b.label}'s {countUnit || "unit"} ran out</span>
          {modelQty > 0 ? (
            <button
              onClick={() => {
                api.setAllocationStatus(b.allocationId, "released").catch(() => {});
                continueProject.mutate({ module: b.targetModule, type: b.targetEntityType, id: b.targetEntityId, label: b.label });
              }}
              className="text-accent hover:text-cobble-800"
              title={`Open the next ${countUnit || "unit"} for ${b.label}`}
            >
              Continue on a fresh {countUnit || "unit"} →
            </button>
          ) : (
            <span className="text-faint italic">no new {nounPlural} left</span>
          )}
          <span className="text-line dark:text-slate-700">·</span>
          <button
            onClick={() => api.setAllocationStatus(b.allocationId, "released").then(invalidate).catch((e: unknown) => toast.error((e as Error).message))}
            className="text-faint hover:text-content"
          >
            done
          </button>
        </div>
      ))}

      {pool.open.length === 0 && pool.newCount > 0 && unitCapacity != null && !loading && (
        <p className="text-[11px] text-faint">Nothing open yet - open a {countUnit || "unit"} to start tracking what's left.</p>
      )}

      <div className="flex items-center gap-3 pt-1">
        <button
          onClick={() => openOne.mutate()}
          disabled={openOne.isPending || modelQty <= 0 || unitCapacity == null}
          className="inline-flex items-center gap-1 text-xs rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-40 disabled:cursor-not-allowed text-white px-2.5 py-1"
          title={modelQty <= 0 ? `No new ${nounPlural} to open` : `Open a ${countUnit || "unit"} (uses one spare)`}
        >
          <Plus size={12} /> Open a {countUnit || "unit"}
        </button>
        {modelQty <= 0 && pool.open.length > 0 && (
          <span className="text-[11px] text-faint">No new {nounPlural} left - you're on your open {pool.open.length > 1 ? nounPlural : (countUnit || "unit")}.</span>
        )}
      </div>
    </section>
  );
}

// One open unit — its remaining, a gauge, an inline "use" control, and its own
// statement with the running balance DERIVED on read over its ledger (§7.2).
// In the EXPANDED face it also carries its project binding (§3): a "for <project>"
// label, an assign/unassign control, per-project continuation, and the smart
// close-out prompt (§1.1). A withdrawal on a BOUND unit posts to its ledger with
// the project as the reason (source_kind "allocation"), so the statement reads
// "−200 m · Winter scarf".
function OpenUnitCard({
  unit,
  consumedUnit,
  countUnit,
  binding,
  expanded,
  thresholdPct,
  onChanged,
}: {
  unit: UnitRecord;
  consumedUnit: string;
  countUnit: string;
  /** The project this skein is bound to, or null (unbound partial / working ball). */
  binding: UnitBinding | null;
  /** Whether the panel is in the expanded per-project face (§4.2). */
  expanded: boolean;
  /** Fraction of capacity below which close-out prompts (else keep silently). */
  thresholdPct: number;
  onChanged: () => void;
}) {
  const { api } = useInventory();
  const toast = useToast();
  const [amt, setAmt] = useState("");
  const [open, setOpen] = useState(false);
  const [assigning, setAssigning] = useState(false);
  // Close-out prompt state: null = closed; else the editable "~N left" estimate.
  const [closeOut, setCloseOut] = useState<string | null>(null);
  const log = useQuery({ queryKey: ["inventory-consumption", unit.id], queryFn: () => api.listConsumption(unit.id) });
  const rows = log.data?.items ?? [];
  const balanced = runningBalances(rows, unit.qty);
  const pct = gaugePct(unit.qty, unit.capacity);
  const u = consumedUnit || "";
  const fail = (e: unknown) => toast.error((e as Error).message);

  // A withdrawal — attributed to the bound project when there is one, so the
  // skein's statement line reads the project's name (§7.4). Goes through the now-
  // ledgered stock-adjust writer, so the line exists and the balance walks.
  const use = (n: number) => {
    if (!(n > 0)) return;
    api
      .stockAdjust(
        unit.id,
        -n,
        binding ? binding.label : "Used",
        binding ? { source_kind: "allocation", source_id: binding.allocationId } : undefined,
      )
      .then(() => { setAmt(""); onChanged(); })
      .catch(fail);
  };

  // Bind this open skein to a project (§3) — a reserved allocation on the unit.
  const bind = (target: PickedEntity) => {
    api
      .createAllocation({
        part_id: unit.id,
        qty: unit.qty > 0 ? unit.qty : (unit.capacity ?? 1),
        target_module: target.module,
        target_entity_type: target.type,
        target_entity_id: target.id,
        reason: target.label,
      })
      .then(() => { setAssigning(false); onChanged(); })
      .catch(fail);
  };

  // Release the binding (§1.1 keep / plain unassign) — the skein returns to the
  // pool as an open, unbound partial. Never CONSUMED (that would double-decrement
  // the qty the per-unit withdrawals already tracked); release only.
  const release = () =>
    api.setAllocationStatus(binding!.allocationId, "released").then(onChanged).catch(fail);

  // Finish the project on this skein (§1.1): gate on the remainder vs the tunable
  // threshold. Clearly reusable → back to the pool silently; small/ambiguous →
  // the one-tap keep-vs-write-off prompt; nothing left → just release.
  const finish = () => {
    const gate = closeOutGate(unit.qty, unit.capacity, thresholdPct);
    if (gate === "prompt") {
      setCloseOut(String(round3(unit.qty)));
      return;
    }
    if (gate === "silent-keep") {
      release();
      toast.success(`Kept ~${round3(unit.qty)}${u ? " " + u : ""} left — back in the pool.`);
      return;
    }
    // "none" — already empty; just clear the binding.
    release();
  };

  // Keep from the prompt: optionally reconcile the remaining to the edited number
  // (a compensating ledger line), then release the binding.
  const keep = async () => {
    try {
      const n = Number(closeOut);
      if (Number.isFinite(n) && n >= 0 && Math.abs(n - unit.qty) > 1e-9) {
        await api.stockAdjust(unit.id, round3(n - unit.qty), "Adjusted at close-out");
      }
      await api.setAllocationStatus(binding!.allocationId, "released");
      setCloseOut(null);
      onChanged();
    } catch (e) { fail(e); }
  };

  // Write off from the prompt: the remaining is scrapped — drive the skein to 0
  // with an explicit "written off" line (§1.1, never silently vanished), then
  // release the binding. The unit goes empty and drops off the active view.
  const writeOff = async () => {
    try {
      if (unit.qty > 0) await api.stockAdjust(unit.id, -unit.qty, "Written off");
      await api.setAllocationStatus(binding!.allocationId, "released");
      setCloseOut(null);
      onChanged();
    } catch (e) { fail(e); }
  };

  return (
    <div className="rounded-lg border border-line dark:border-slate-700/70 bg-mortar-50/40 dark:bg-slate-800/40 p-3 space-y-2">
      {/* Heading — in the expanded face, the per-skein binding label ("· Winter
          scarf" / "· unbound partial"), else just "open ·" once several exist. */}
      {expanded && (
        <div className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider">
          <span className="text-faint">open · {unit.name}</span>
          {binding ? (
            <span className="text-accent dark:text-cobble-300 normal-case font-sans">for {binding.label}</span>
          ) : (
            <span className="text-faint normal-case font-sans italic">unbound partial</span>
          )}
        </div>
      )}
      <div>
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-content dark:text-mortar-100">
            <b className="tabular-nums">{round3(unit.qty)}</b> {u} left
          </span>
          {pct != null && unit.capacity != null && (
            <span className="text-faint text-xs">of {unit.capacity} {u} · {pct}%</span>
          )}
        </div>
        {pct != null && (
          <div className="mt-1 h-2 rounded bg-line dark:bg-slate-700 overflow-hidden">
            <div className={`h-full ${pct <= 15 ? "bg-ember-500" : "bg-moss-500"}`} style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input
          type="number"
          min="0"
          step="any"
          value={amt}
          onChange={(e) => setAmt(e.target.value)}
          placeholder={`use (${u || "amount"})`}
          className="w-28 px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
        />
        <button
          onClick={() => use(Number(amt))}
          disabled={!(Number(amt) > 0)}
          className="inline-flex items-center gap-1 text-xs rounded border border-line dark:border-slate-600 hover:border-accent disabled:opacity-40 px-2 py-1 text-content dark:text-mortar-200"
        >
          <Minus size={12} /> Use
        </button>
        {rows.length > 0 && (
          <button onClick={() => setOpen((v) => !v)} className="text-[11px] text-faint hover:text-accent ml-auto">
            {open ? "hide history" : `history (${rows.length})`}
          </button>
        )}
      </div>

      {/* Binding controls (§3). A bound skein shows finish + continue; an unbound
          one offers assign-to-a-project. Kept subtle so the simple face stays
          quiet — these appear per open card, and only a binding/parallelism flips
          the panel to the expanded face. */}
      {closeOut != null ? (
        <div className="rounded border border-line dark:border-slate-700 p-2 space-y-2 bg-surface/60 dark:bg-slate-900/40">
          <div className="text-[12px] text-content dark:text-mortar-100">
            ~{round3(unit.qty)}{u ? " " + u : ""} left - keep it, or done with it?
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              step="any"
              value={closeOut}
              onChange={(e) => setCloseOut(e.target.value)}
              className="w-24 px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
              title="Adjust the remaining before deciding"
            />
            <button onClick={keep} className="text-xs rounded bg-cobble-600 hover:bg-cobble-700 text-white px-2.5 py-1">
              Keep it
            </button>
            <button onClick={writeOff} className="text-xs rounded border border-ember-300 dark:border-ember-800 text-ember-600 dark:text-ember-500 hover:bg-ember-50 dark:hover:bg-ember-900/30 px-2.5 py-1">
              Done with it
            </button>
            <button onClick={() => setCloseOut(null)} className="text-[11px] text-faint hover:text-content">
              cancel
            </button>
          </div>
        </div>
      ) : binding ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          <button onClick={finish} className="text-faint hover:text-accent" title={`Finish ${binding.label} on this ${countUnit}`}>
            Done with {binding.label}
          </button>
          <span className="text-line dark:text-slate-700">·</span>
          <button onClick={release} className="text-faint hover:text-accent">unassign</button>
        </div>
      ) : assigning ? (
        <div className="space-y-1">
          <EntityPicker selected={null} onSelect={bind} onClear={() => setAssigning(false)} />
          <button onClick={() => setAssigning(false)} className="text-[11px] text-faint hover:text-content">cancel</button>
        </div>
      ) : (
        <button onClick={() => setAssigning(true)} className="text-[11px] text-faint hover:text-accent" title={`Assign this ${countUnit} to a project`}>
          + assign to a project
        </button>
      )}

      {open && rows.length > 0 && (
        <ul className="divide-y divide-line dark:divide-slate-800">
          {balanced.map(({ row, balanceAfter }, i) => {
            const d = Number(row.delta);
            return (
              <li key={row.id} className="py-1.5 flex items-center gap-2 text-[13px]">
                <span className={"font-medium tabular-nums w-20 " + (d < 0 ? "text-ember-600 dark:text-ember-500" : "text-moss-600 dark:text-moss-400")}>
                  {d < 0 ? "" : "+"}{round3(d)} {u}
                </span>
                <span className="text-muted dark:text-slate-400 truncate flex-1">{row.reason ?? row.source_kind ?? "adjustment"}</span>
                <span className="text-[11px] text-faint shrink-0 w-24 text-right">{new Date(row.at).toLocaleDateString()}</span>
                <span
                  className={"tabular-nums shrink-0 w-20 text-right " + (i === 0 ? "text-content dark:text-mortar-100 font-medium" : "text-faint")}
                  title={i === 0 ? "what's left in this one" : "balance after this line"}
                >
                  {round3(balanceAfter)} {u}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Trim float dust for display (546 - 0.1 - 0.2 …) without forcing integers. */
function round3(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function pluralizeUnit(u: string): string {
  if (!u) return "units";
  if (/(s|x|z|ch|sh)$/i.test(u)) return `${u}es`;
  if (/[^aeiou]y$/i.test(u)) return `${u.slice(0, -1)}ies`;
  return `${u}s`;
}

function numOr(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Counting an assortment: the moment a guess becomes a number.
 *
 *  The estimate is offered as the starting value because the user is usually
 *  confirming roughly what they already said, and it is the only number they
 *  have. Accepting it unchanged is a legitimate answer: "I looked, fifty is
 *  right" is more knowledge than "roughly fifty", even though the digits match.
 */
function CountAssortmentModal({
  open,
  onClose,
  noun,
  suggested,
  busy,
  onCount,
}: {
  open: boolean;
  onClose: () => void;
  noun: string;
  suggested: number;
  busy: boolean;
  onCount: (qty: number) => void;
}) {
  const [value, setValue] = useState(String(suggested));
  useEffect(() => {
    if (open) setValue(String(suggested));
  }, [open, suggested]);

  const n = Number(value);
  const valid = Number.isFinite(n) && n >= 0;

  return (
    <Modal open={open} onClose={onClose} title={`Count the ${noun}s`} size="sm">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          How many are actually there? This stops being an estimate and becomes a count.
          Everything else about it stays: its history, its tags, and any label already on it.
        </p>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-content">Counted</span>
          <input
            type="number"
            min={0}
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            className="w-full rounded-lg border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-3 py-2 text-content dark:text-mortar-100"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line dark:border-slate-600 px-3 py-2 text-sm text-content dark:text-mortar-100"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || busy}
            onClick={() => onCount(n)}
            className="rounded-lg bg-cobble-600 hover:bg-cobble-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 transition"
          >
            {busy ? "Saving…" : "It is a count now"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Adding a kind to an assortment.
 *
 *  A kind is another estimate, not a count: "DB25 gender changers, about 7".
 *  It becomes a part placed inside the assortment, which is what lets it
 *  graduate into a counted item later without being retyped.
 */
function AddKindModal({
  open,
  onClose,
  busy,
  onAdd,
  canSuggest,
  onSuggest,
  onAcceptAll,
}: {
  open: boolean;
  onClose: () => void;
  busy: boolean;
  onAdd: (name: string, approx: number) => void;
  canSuggest?: boolean;
  onSuggest?: () => Promise<Array<{ name: string; approximate_qty: number }>>;
  onAcceptAll?: (list: Array<{ name: string; approximate_qty: number }>) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [approx, setApprox] = useState("");
  const [suggested, setSuggested] = useState<
    Array<{ name: string; approximate_qty: number; keep: boolean }> | null
  >(null);
  const [thinking, setThinking] = useState(false);
  useEffect(() => {
    if (open) {
      setName("");
      setApprox("");
      setSuggested(null);
    }
  }, [open]);

  const n = Number(approx);
  const valid = name.trim().length > 0 && Number.isFinite(n) && n >= 0;

  return (
    <Modal open={open} onClose={onClose} title="Add a kind" size="sm">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onAdd(name.trim(), n);
        }}
      >
        <p className="text-sm text-muted">
          What is in there, roughly? Still an estimate: you are describing the jumble, not
          counting it.
        </p>

        {canSuggest && onSuggest && suggested === null && (
          <button
            type="button"
            disabled={thinking}
            onClick={async () => {
              setThinking(true);
              try {
                const list = await onSuggest();
                setSuggested(list.map((k) => ({ ...k, keep: true })));
              } finally {
                setThinking(false);
              }
            }}
            className="w-full rounded-lg border border-dashed border-cobble-400 px-3 py-2 text-sm text-content dark:text-mortar-100 disabled:opacity-50"
          >
            {thinking ? "Looking at the photo…" : "Read them off the photo"}
          </button>
        )}

        {suggested !== null && (
          <div className="space-y-2 rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 p-3">
            {suggested.length === 0 ? (
              <p className="text-sm text-muted">
                Nothing recognisable came back. Type one below instead.
              </p>
            ) : (
              <>
                <p className="text-xs text-muted">
                  Untick anything that is not really in there. These are guesses about
                  someone else&apos;s bin, so they are offered rather than applied.
                </p>
                {suggested.map((k, i) => (
                  <label key={`${k.name}-${i}`} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={k.keep}
                      onChange={(e) =>
                        setSuggested((cur) =>
                          (cur ?? []).map((x, j) =>
                            j === i ? { ...x, keep: e.target.checked } : x,
                          ),
                        )
                      }
                    />
                    <span className="text-content dark:text-mortar-100">{k.name}</span>
                    <span className="text-muted">~{k.approximate_qty}</span>
                  </label>
                ))}
                <button
                  type="button"
                  disabled={busy || !suggested.some((k) => k.keep)}
                  onClick={() => void onAcceptAll?.(suggested.filter((k) => k.keep))}
                  className="w-full rounded-lg bg-cobble-600 hover:bg-cobble-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  Add the ticked ones
                </button>
              </>
            )}
          </div>
        )}
        <label className="block space-y-1">
          <span className="text-sm font-medium text-content">Kind</span>
          <input
            value={name}
            autoFocus
            placeholder="DB25 gender changer"
            onChange={(e) => setName(e.target.value)}
            className="input w-full"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-content">Roughly how many</span>
          <input
            type="number"
            min={0}
            value={approx}
            placeholder="7"
            onChange={(e) => setApprox(e.target.value)}
            className="input w-full"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-line dark:border-slate-600 px-3 py-2 text-sm text-content dark:text-mortar-100"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!valid || busy}
            className="rounded-lg bg-cobble-600 hover:bg-cobble-500 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 transition"
          >
            {busy ? "Adding…" : "Add it"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
