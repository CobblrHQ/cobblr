// Modal to create a new part. Minimum fields only — name + qty +
// optional category/location.
//
// v0.2: catalog-aware quick-add. Type in the catalog typeahead at the
// top — the platform searches every installed catalog at once. Pick
// a hit → name + image_path pre-fill from the catalog payload, and a
// `matches → core-catalogs:entry` pairing is written after create so
// the rest of the app can hydrate matched-entry data into the row.

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  CatalogTypeahead,
  Modal,
  type CatalogTypeaheadHit,
} from "@cobblr/platform-web";
import { useInventory } from "./context";
import { useFieldPresentation } from "./useFieldPresentation";
import { InventoryApiError } from "./api";

interface NewPartDialogProps {
  onClose: (created: boolean) => void;
  /** When set, called with the new part id after create instead of
   *  the default navigate-to-detail. Used by the portal shell to
   *  refresh its view in place rather than send the user to the
   *  admin shell's detail page. */
  onCreated?: (partId: string) => void;
}

export function NewPartDialog({ onClose, onCreated }: NewPartDialogProps) {
  const { api } = useInventory();
  // Native-field presentation: a bundle/config can relabel + hide these on the
  // create form too (no-op until an override exists). Matches PartDetailPage.
  const fp = useFieldPresentation("inventory:part");
  const navigate = useNavigate();
  const cats = useQuery({ queryKey: ["inventory-categories"], queryFn: () => api.listCategories() });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });

  const [matched, setMatched] = useState<CatalogTypeaheadHit | null>(null);
  const [name, setName] = useState("");
  const [qty, setQty] = useState("1");
  const [unit, setUnit] = useState("each");
  const [categoryId, setCategoryId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [printLabel, setPrintLabel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        qr_payload: `${window.location.origin}/qr/${tok.token}`,
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
        navigate(`/inventory/parts/${part.id}`);
      }
    } catch (err) {
      setError(err instanceof InventoryApiError ? err.message : "Couldn't create part");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={() => onClose(false)} title="new part" size="sm">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Match to a catalog (optional)">
          <CatalogTypeahead
            selected={matched}
            onSelect={handleMatch}
            search={(q) => api.searchCatalogs(q)}
            placeholder="Search a catalog…"
          />
        </Field>
        <Field label="Name">
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={matched ? matched.title : "Name this item"}
            className="input"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
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
                className="input"
              />
            </Field>
          )}
        </div>
        <Field label="Category">
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="input">
            <option value="">— none —</option>
            {cats.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Location">
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
        <label className="flex items-center gap-2 text-xs text-content dark:text-mortar-200 cursor-pointer pt-1">
          <input
            type="checkbox"
            checked={printLabel}
            onChange={(e) => setPrintLabel(e.target.checked)}
            className="accent-cobble-500"
          />
          Queue a QR label print after create
        </label>
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
