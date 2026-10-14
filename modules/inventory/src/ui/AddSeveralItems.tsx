import { useState } from "react";
import { Modal, useRunAction, useToast } from "@cobblr/platform-web";
import { useQueryClient } from "@tanstack/react-query";
import { useInventory } from "./context";
import { countOf } from "@cobblr/platform-contract/plural";

export function AddSeveralItems({ onClose }: { onClose: () => void }) {
  const { instance, qtyUnit, nounWords } = useInventory();
  const [names, setNames] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // PRESS-ARGS: the form collects each name; its current collection, quantity one and default unit complete every item.
  const run = useRunAction();
  const toast = useToast();
  const qc = useQueryClient();
  const items = names.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const valid = items.length > 0 && items.length <= 100 && items.every((s) => s.length <= 200);
  const add = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      const out = await run({ actionId: "inventory:create-items", args: { items: items.map((name) => ({ name, instance: instance ?? "inventory", qty: 1, unit: qtyUnit || "each" })) } });
      const r = out.result as { ok?: boolean; error?: string; ids?: string[] } | null;
      if (!r?.ok) throw new Error(r?.error || "These items were not added.");
      void qc.invalidateQueries({ queryKey: ["inventory-parts"] });
      toast.success(`Added ${countOf(r.ids?.length ?? items.length, nounWords)}.`);
      onClose();
      setNames("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return <Modal open onClose={() => { if (!busy) onClose(); }} title="Add several" size="md">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <p>One name per line, up to 100. Each starts with a quantity of one. You can fill in its details afterwards.</p>
        <label className="block text-sm">Names<textarea className="mt-1 block w-full rounded-md border border-line bg-surface p-2" rows={8} value={names} onChange={(e) => setNames(e.target.value)} /></label>
        <p className="text-sm">{countOf(items.length, nounWords)} to add</p>
        {items.length > 100 && <p role="alert">Add up to 100 at a time.</p>}
        {items.some((s) => s.length > 200) && <p role="alert">Keep each name under 201 characters.</p>}
        {error && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
        <button type="submit" className="min-h-11 rounded-md bg-cobble-600 px-3 py-2 text-white disabled:opacity-50" disabled={busy || !valid}>{busy ? "Adding…" : "Add these items"}</button>
      </form>
    </Modal>;
}
