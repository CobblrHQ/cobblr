// Modal to create a new part. Minimum fields only — name + qty +
// optional category/location. Detail page handles every other field
// after creation.

import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Modal } from "@cobblr/platform-web";
import { useInventory } from "./context";
import { InventoryApiError } from "./api";

export function NewPartDialog({ onClose }: { onClose: (created: boolean) => void }) {
  const { api, orgSlug, getToken } = useInventory();
  const navigate = useNavigate();
  const cats = useQuery({ queryKey: ["inventory-categories"], queryFn: () => api.listCategories() });
  const locs = useQuery({ queryKey: ["inventory-locations"], queryFn: () => api.listLocations() });

  const [name, setName] = useState("");
  const [qty, setQty] = useState("1");
  const [unit, setUnit] = useState("each");
  const [categoryId, setCategoryId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [printLabel, setPrintLabel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function queueQrLabel(partId: string, displayName: string) {
    const auth = (): Record<string, string> => {
      const t = getToken();
      return t ? { Authorization: `Bearer ${t}` } : {};
    };
    const mint = await fetch(
      `/api/v1/orgs/${orgSlug}/modules/core-labels-qr/tokens`,
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
    if (!mint.ok) return;
    const tok = (await mint.json()) as { token: string };
    await fetch(`/api/v1/orgs/${orgSlug}/modules/labels/queue`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({
        module_name: "inventory",
        entity_type: "part",
        entity_id: partId,
        qr_payload: `${window.location.origin}/qr/${tok.token}`,
        description: displayName,
        qty: 1,
      }),
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const part = await api.createPart({
        name: name.trim(),
        qty: Number(qty) || 0,
        unit: unit.trim() || "each",
        category_id: categoryId || null,
        location_id: locationId || null,
      });
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
      navigate(`/inventory/parts/${part.id}`);
    } catch (err) {
      setError(err instanceof InventoryApiError ? err.message : "Couldn't create part");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={() => onClose(false)} title="new part" size="sm">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name">
          <input
            autoFocus
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Qty">
            <input
              type="number"
              step="any"
              min="0"
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Unit">
            <input
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              className="input"
            />
          </Field>
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
        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-mortar-200 cursor-pointer pt-1">
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
            className="flex-1 rounded-md border border-slate-200 dark:border-slate-700 text-sm text-slate-600 dark:text-mortar-200 hover:bg-mortar-50 dark:bg-slate-800/70 transition py-2"
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
      <span className="block text-[10px] font-mono uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
