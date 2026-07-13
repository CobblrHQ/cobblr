// Modal to create a new part. Minimum fields only — name + qty +
// optional category/location.
//
// v0.2: catalog-aware quick-add. Type in the catalog typeahead at the
// top — the platform searches every installed catalog at once. Pick
// a hit → name + image_path pre-fill from the catalog payload, and a
// `matches → core-catalogs:entry` pairing is written after create so
// the rest of the app can hydrate matched-entry data into the row.

import { useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CatalogTypeahead,
  Modal,
  RelationSelect,
  MarkdownEditor,
  fieldControl,
  useUnits,
  type CatalogTypeaheadHit,
  type FieldType,
  type FieldRendererId,
  usePlatformWeb,
} from "@cobblr/platform-web";
import { useInventory } from "./context";
import { useFieldPresentation } from "./useFieldPresentation";
import { ParentPicker, type ParentRef } from "./ParentPicker";
import { InventoryApiError, type InvFieldDef } from "./api";

interface NewPartDialogProps {
  onClose: (created: boolean) => void;
  /** When set, called with the new part id after create instead of
   *  the default navigate-to-detail. Used by the portal shell to
   *  refresh its view in place rather than send the user to the
   *  admin shell's detail page. */
  onCreated?: (partId: string) => void;
  /** Pre-fill the form from an existing item (Duplicate). The user
   *  still reviews + saves, so it's a new row, not a silent clone.
   *  `fields` seeds the custom metadata. */
  seed?: {
    name?: string;
    qty?: number | string | null;
    unit?: string | null;
    manufacturer?: string | null;
    cost?: number | string | null;
    category_id?: string | null;
    location_id?: string | null;
    fields?: Record<string, unknown> | null;
    parent?: ParentRef | null;
  };
}

// Common quantity units, surfaced as type-ahead suggestions on the Unit field
// (a datalist — still free text, so nothing is constrained). Covers everyday
// inventory + medication units, since "each" alone was too thin (feedback).
const UNIT_SUGGESTIONS = [
  "each", "pcs", "pack", "box", "set", "pair",
  "tablet", "capsule", "pill", "mL", "L", "drop", "puff", "spray", "patch", "dose", "sachet",
  "mg", "mcg", "g", "kg", "IU", "unit",
  "m", "cm", "ft", "roll", "sheet",
];

export function NewPartDialog({ onClose, onCreated, seed }: NewPartDialogProps) {
  const { api, instance, entityKind, itemNoun, qtyUnit, parent, basePath, orgSlug } = useInventory();
  // Native-field presentation: a bundle/config relabels + hides natives on the
  // create form too (the Yarn instance hides category/location/etc.). Scoped to
  // the instance kind so each instance's create form shows only its fields.
  const fp = useFieldPresentation(entityKind);
  const navigate = useNavigate();
  const cats = useQuery({ queryKey: ["inventory-categories"], queryFn: () => api.listCategories() });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });
  // Does any installed catalog bind to inventory:part? If so, show the
  // quick-match typeahead even on a skinned instance (Lego Sets is the point —
  // the instance IS the catalog-backed thing). Instances in a workspace with no
  // such catalog (a lone Yarn stash) still get the clean, matchless form.
  const catalogsQ = useQuery({
    queryKey: ["catalogs-bound-inventory-part", orgSlug],
    queryFn: () => api.listCatalogs(),
    staleTime: 60_000,
  });
  const hasBoundCatalog = (catalogsQ.data?.items ?? []).some((c) => {
    const b = c.schema?.bindable_to_kinds;
    // Omitted → binds to everything; array → must include the kind.
    return b == null || (Array.isArray(b) && b.includes("inventory:part"));
  });
  // The instance's custom fields (yarn: colour, fibre, weight, …) — promoted
  // INTO the create form so the user fills them at creation, not after.
  const fieldDefs = useQuery({
    queryKey: ["platform-field-defs", orgSlug, entityKind, "effective"],
    queryFn: () => api.listFieldDefs(entityKind, true),
    staleTime: 60_000,
  });
  const customFields = (fieldDefs.data?.items ?? [])
    // computed = derived every read; server_managed = stamped server-side.
    // Neither has anything to set at creation — no input.
    .filter((d) => d.type !== "computed" && !d.server_managed)
    .sort((a, b) => a.position - b.position);
  // The instance's PREFERRED catalog: the one whose field_map fills the most of
  // this instance's own fields (Lego Sets fields ← the Rebrickable sets
  // catalog). Floats that catalog's hits to the top of the quick-match so a Sets
  // form leads with sets, not minifigs. Derived — no per-instance config to
  // seed; the binding IS the field_map the instance's fields already declare.
  const preferredCatalogId = useMemo(() => {
    const fieldNames = new Set(customFields.map((f) => f.name));
    if (fieldNames.size === 0) return undefined;
    let best: { id: string; score: number } | undefined;
    for (const c of catalogsQ.data?.items ?? []) {
      const targets = Object.values(c.schema?.field_map ?? {});
      const score = targets.filter((t) => fieldNames.has(t)).length;
      if (score > 0 && (!best || score > best.score)) best = { id: c.id, score };
    }
    return best?.id;
  }, [catalogsQ.data, customFields]);

  const [matched, setMatched] = useState<CatalogTypeaheadHit | null>(null);
  const [name, setName] = useState(seed?.name ?? "");
  const [qty, setQty] = useState(seed?.qty != null ? String(seed.qty) : "1");
  const [unit, setUnit] = useState(seed?.unit ?? qtyUnit ?? "each");
  const units = useUnits();
  // The unit when the field was focused — so changing g→kg converts the qty
  // once on blur (not on every keystroke while typing "kg"). (e55169b1)
  const unitAtFocus = useRef(unit);
  const [categoryId, setCategoryId] = useState(seed?.category_id ?? "");
  const [locationId, setLocationId] = useState(seed?.location_id ?? "");
  const [manufacturer, setManufacturer] = useState(seed?.manufacturer ?? "");
  const [cost, setCost] = useState(seed?.cost != null ? String(seed.cost) : "");
  const [meta, setMeta] = useState<Record<string, unknown>>(seed?.fields ?? {});
  const [parentRef, setParentRef] = useState<ParentRef | null>(seed?.parent ?? null);
  const [printLabel, setPrintLabel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { appMode } = usePlatformWeb();

  function pickImageFromPayload(payload: Record<string, unknown>): string | null {
    for (const k of ["img_url", "image_url", "image", "thumbnail"]) {
      const v = payload[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
  }

  // When the user picks a catalog hit, pre-fill any blank fields. We
  // never overwrite something the user already typed — they may have
  // started entering a custom name and then matched to refine the
  // image without losing their work.
  function handleMatch(hit: CatalogTypeaheadHit | null) {
    setMatched(hit);
    if (!hit) return;
    if (!name.trim()) setName(hit.title);
    // Prefill the instance's fields the catalog declares a mapping for (Lego
    // Sets → set_number / theme / year / piece_count). Blanks only — never
    // clobber something the user already typed. The map lives on the catalog
    // (schema.field_map: { catalogPayloadKey: instanceFieldName }).
    const map = hit.field_map;
    if (map) {
      const payload = hit.payload as Record<string, unknown>;
      setMeta((m) => {
        const next = { ...m };
        for (const [catKey, fieldName] of Object.entries(map)) {
          const v = payload[catKey];
          const cur = next[fieldName];
          if (v != null && v !== "" && (cur == null || cur === "")) next[fieldName] = v;
        }
        return next;
      });
    }
  }

  async function queueQrLabel(partId: string, displayName: string) {
    // Two-step cross-module call: mint a QR navigate-token from
    // core-labels-qr, then enqueue a label in the labels module
    // pointing at it. Both flow through the typed inventory client
    // so failures throw InventoryApiError instead of vanishing.
    try {
      const tok = await api.mintQrToken({
        entity_kind: "inventory:part",
        entity_id: partId,
        mode: "navigate",
        auth: "session",
      });
      await api.enqueueLabel({
        module_name: "inventory",
        entity_type: "part",
        entity_id: partId,
        qr_payload: tok.scan_url,
        description: displayName,
        qty: 1,
      });
    } catch {
      // Non-fatal: the part was created. A failed label enqueue
      // shouldn't block the user from seeing the new part.
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const imageFromMatch = matched ? pickImageFromPayload(matched.payload) : null;
      const part = await api.createPart({
        name: name.trim(),
        qty: Number(qty) || 0,
        unit: unit.trim() || "each",
        category_id: categoryId || null,
        location_id: locationId || null,
        manufacturer: manufacturer.trim() || null,
        // `cost` is number-or-omitted on the server (not nullable) — only
        // send it when the user typed one, else leave it off entirely.
        ...(cost.trim() === "" ? {} : { cost: Number(cost) }),
        // The instance's custom fields (colour, fibre, weight, …) filled in
        // the form go straight onto the new item.
        ...(Object.keys(meta).length ? { metadata: meta } : {}),
        // Stamp the matched catalog's image so the list row shows it
        // immediately. (Hydration would still find it via the pairing,
        // but this avoids the join cost on every list render.)
        image_path: imageFromMatch,
      });
      // Write the pairing AFTER create — needs the part id. Failure
      // here is non-fatal: the part exists, only the binding is
      // missing. The user can still hit "Match to catalog" from the
      // detail page.
      if (matched) {
        try {
          await api.createMatchPairing(part.id, matched.id);
        } catch (e) {
          console.error("[NewPartDialog] match pairing failed", e);
        }
      }
      // Link this unit to its parent "type" (the `instance-of` pairing) — same
      // post-create timing as the catalog match, and equally non-fatal.
      if (parent && parentRef) {
        try {
          await api.createParentPairing(part.id, parentRef.id);
        } catch (e) {
          console.error("[NewPartDialog] parent pairing failed", e);
        }
      }
      if (printLabel) {
        try {
          const displayName =
            "asset_id" in part && (part as { asset_id: number }).asset_id != null
              ? `#${String((part as { asset_id: number }).asset_id).padStart(3, "0")} ${name.trim()}`
              : name.trim();
          await queueQrLabel(part.id, displayName);
        } catch {
          /* non-fatal */
        }
      }
      onClose(true);
      if (onCreated) {
        onCreated(part.id);
      } else {
        navigate(`${basePath}/parts/${part.id}`);
      }
    } catch (err) {
      setError(err instanceof InventoryApiError ? err.message : `Couldn't create ${itemNoun.toLowerCase()}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={() => onClose(false)} title={`new ${itemNoun.toLowerCase()}`} size="lg" dismissOnBackdrop={false}>
      <form onSubmit={submit} className="space-y-3">
        {/* Catalog matching: always on the base inventory; on a skinned
            instance only when a catalog actually binds to inventory:part (Lego
            Sets → Rebrickable). Instances with nothing to match against stay
            clean — no empty field. */}
        {(!instance || hasBoundCatalog) && (
          <Field label="Match to a catalog (optional)">
            <CatalogTypeahead
              selected={matched}
              onSelect={handleMatch}
              search={(q) => api.searchCatalogs(q, 20, preferredCatalogId)}
              placeholder="Search a catalog…"
            />
          </Field>
        )}
        <Field label="Name">
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={matched ? matched.title : `Name this ${itemNoun.toLowerCase()}`}
            className="input"
          />
        </Field>
        {/* Everything below name flows in a 2-up grid — a wide modal that uses
            the horizontal space instead of a tall column you have to scroll.
            Full-width things (parent picker, long text) span both columns. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          {!fp.hidden("qty") && (
            <Field label={fp.label("qty", "Qty")}>
              <input
                type="number"
                step="any"
                min="0"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="input"
              />
            </Field>
          )}
          {!fp.hidden("unit") && (
            <Field label={fp.label("unit", "Unit")}>
              <input
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                onFocus={() => {
                  unitAtFocus.current = unit;
                }}
                onBlur={() => {
                  const n = Number(qty);
                  const c = Number.isFinite(n) ? units.convert(n, unitAtFocus.current, unit) : null;
                  if (c != null) setQty(String(c));
                }}
                list="part-unit-options"
                className="input"
              />
              <datalist id="part-unit-options">
                {UNIT_SUGGESTIONS.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </Field>
          )}
          {/* Parent / "type" link — when this instance's items belong to a type
              in another instance (Spool → Filament type), pick it here; the
              `instance-of` pairing is written after create. */}
          {parent && (
            <div className="sm:col-span-2">
              <Field label={parent.label ?? "Type"}>
                <ParentPicker
                  instance={parent.instance}
                  value={parentRef}
                  onChange={setParentRef}
                  placeholder={`Search ${parent.label?.toLowerCase() ?? "type"}…`}
                />
              </Field>
            </div>
          )}
          {/* The instance's own fields, promoted into create (the whole point of a
              skinned instance — fill yarn fields here, not after). Long fields
              (rich text) span both columns. */}
          {customFields.map((f) => (
            <div key={f.id} className={f.type === "richtext" ? "sm:col-span-2" : undefined}>
              <CustomFieldInput
                def={f}
                value={meta[f.name]}
                entityKind={entityKind}
                onChange={(v) => setMeta((m) => ({ ...m, [f.name]: v }))}
              />
            </div>
          ))}
          {/* Brand + Price — natives that belong on the first create modal,
              not buried in the full-size editor. Relabelled per instance via fp
              (Yarn: "Brand" / "Price"); an instance can still hide either. */}
          {!fp.hidden("manufacturer") && (
            <Field label={fp.label("manufacturer", "Brand")}>
              <input
                value={manufacturer}
                onChange={(e) => setManufacturer(e.target.value)}
                className="input"
              />
            </Field>
          )}
          {!fp.hidden("cost") && (
            <Field label={fp.label("cost", "Price")}>
              <input
                type="number"
                step="any"
                min="0"
                inputMode="decimal"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                className="input"
              />
            </Field>
          )}
          {!fp.hidden("category") && (
            <Field label={fp.label("category", "Category")}>
              <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="input">
                <option value="">— none —</option>
                {cats.data?.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {!fp.hidden("location") && (
            <Field label={fp.label("location", "Location")}>
              <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className="input">
                <option value="">— none —</option>
                {locs.data?.items.map((l) => (
                  <option key={l.id} value={l.id}>
                    {"  ".repeat(l.depth)}
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {/* QR-label printing is a platform/maker feature — hide it in a locked
            managed app (a yarn consumer has no label printer). */}
        {!appMode && (
          <label className="flex items-center gap-2 text-xs text-content dark:text-mortar-200 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={printLabel}
              onChange={(e) => setPrintLabel(e.target.checked)}
              className="accent-cobble-500"
            />
            Queue a QR label print after create
          </label>
        )}
        {error && (
          <div className="text-xs text-ember-500 bg-ember-50 rounded-md px-3 py-2">{error}</div>
        )}
        <div className="flex gap-2 pt-2">
          <button
            type="button"
            onClick={() => onClose(false)}
            className="flex-1 rounded-md border border-line dark:border-slate-700 text-sm text-content dark:text-mortar-200 hover:bg-subtle dark:bg-slate-800/70 transition py-2"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="flex-1 rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-sm font-medium py-2 transition disabled:opacity-50"
          >
            {busy ? "…" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}

/** Renders one custom-field input on the create form, by the field def's type:
 *  a colour-swatch picker for `color-hex`, an add-as-you-go dropdown for
 *  `choices`, then number/date/checkbox/text. */
function CustomFieldInput({
  def,
  value,
  onChange,
  entityKind,
}: {
  def: InvFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  entityKind: string;
}) {
  const s = value == null ? "" : String(value);
  const help = def.help ? (
    <p className="text-[11px] text-faint dark:text-slate-500 leading-snug mt-1">{def.help}</p>
  ) : null;

  // Shared control decision (see fieldControl) so this create form and the
  // detail-page edit panel can't pick different controls for the same field.
  const control = fieldControl({
    type: def.type as FieldType,
    renderer: def.renderer as FieldRendererId | null,
    choices: def.choices,
    server_managed: def.server_managed,
  });

  // Server-managed: nothing to set at creation (also filtered upstream —
  // belt-and-braces so a future caller can't render a lying input).
  if (control === "server-managed") return null;
  // Relation: the same shared picker the detail panel uses.
  if (control === "relation") {
    return (
      <Field label={def.display_label}>
        <RelationSelect
          refKind={def.ref_kind ?? ""}
          value={value}
          onChange={(v) => onChange(v)}
        />
        {help}
      </Field>
    );
  }

  // Colour: a real swatch picker (type a hex/name OR pick from the OS picker).
  if (control === "color") {
    const t = s.trim();
    const swatch = /^#?[0-9a-fA-F]{6}$/.test(t) ? (t[0] === "#" ? t : `#${t}`) : "#cccccc";
    return (
      <Field label={def.display_label}>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={swatch}
            onChange={(e) => onChange(e.target.value)}
            className="h-9 w-12 shrink-0 rounded border border-line dark:border-slate-600 cursor-pointer bg-transparent p-0.5"
            aria-label={`${def.display_label} colour picker`}
          />
          <input
            type="text"
            value={s}
            onChange={(e) => onChange(e.target.value || null)}
            placeholder="#hex or a colour name"
            className="input flex-1"
          />
        </div>
        {help}
      </Field>
    );
  }

  if (control === "choice") {
    return <ChoiceInput def={def} value={s} onChange={onChange} entityKind={entityKind} help={help} />;
  }
  // Rich text — the same Markdown editor the detail panel uses.
  if (control === "markdown") {
    return (
      <Field label={def.display_label}>
        <MarkdownEditor value={s} ariaLabel={def.display_label} onChange={(v) => onChange(v === "" ? null : v)} />
        {help}
      </Field>
    );
  }
  if (control === "checkbox") {
    return (
      <div>
        <label className="flex items-center gap-2 text-sm text-content dark:text-mortar-200 cursor-pointer">
          <input
            type="checkbox"
            checked={value === true || value === "true"}
            onChange={(e) => onChange(e.target.checked)}
            className="accent-cobble-500"
          />
          {def.display_label}
        </label>
        {help}
      </div>
    );
  }
  // number / date / url / text (computed fields are filtered out upstream)
  const inputType = control === "number" ? "number" : control === "date" ? "date" : control === "url" ? "url" : "text";
  return (
    <Field label={def.display_label}>
      <input
        type={inputType}
        step={control === "number" ? "any" : undefined}
        value={s}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
        className="input"
      />
      {help}
    </Field>
  );
}

/** A choice dropdown that lets the user add a new option on the fly — the new
 *  value is persisted to the field def's `choices` (so it sticks for next
 *  time) and selected immediately. */
function ChoiceInput({
  def,
  value,
  onChange,
  entityKind,
  help,
}: {
  def: InvFieldDef;
  value: string;
  onChange: (v: unknown) => void;
  entityKind: string;
  help: ReactNode;
}) {
  const { api, orgSlug } = useInventory();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function commitNew() {
    const v = draft.trim();
    if (!v) return;
    if ((def.choices ?? []).some((c) => c.toLowerCase() === v.toLowerCase())) {
      onChange(v);
      setAdding(false);
      setDraft("");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.updateFieldDef(def.id, { choices: [...(def.choices ?? []), v] });
      await qc.invalidateQueries({ queryKey: ["platform-field-defs", orgSlug, entityKind] });
      onChange(v);
      setAdding(false);
      setDraft("");
    } catch (e) {
      setErr(e instanceof InventoryApiError ? e.message : "Couldn't add that option");
    } finally {
      setBusy(false);
    }
  }

  if (adding) {
    return (
      <Field label={def.display_label}>
        <div className="flex gap-2">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitNew();
              } else if (e.key === "Escape") {
                setAdding(false);
              }
            }}
            placeholder={`New ${def.display_label.toLowerCase()}…`}
            className="input flex-1"
          />
          <button
            type="button"
            onClick={() => void commitNew()}
            disabled={busy || !draft.trim()}
            className="rounded-lg bg-cobble-600 px-3 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Adding…" : "Add"}
          </button>
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="rounded-lg border border-line dark:border-slate-600 px-3 text-sm text-faint"
            aria-label="Cancel adding a new option"
          >
            ✕
          </button>
        </div>
        {err ? <p className="text-[11px] text-red-500 mt-1">{err}</p> : help}
      </Field>
    );
  }

  return (
    <Field label={def.display_label}>
      <select
        value={value}
        onChange={(e) => {
          if (e.target.value === "__add__") {
            setAdding(true);
            setDraft("");
          } else {
            onChange(e.target.value || null);
          }
        }}
        className="input"
      >
        <option value="">— none —</option>
        {(def.choices ?? []).map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
        <option value="__add__">＋ Add new…</option>
      </select>
      {help}
    </Field>
  );
}
