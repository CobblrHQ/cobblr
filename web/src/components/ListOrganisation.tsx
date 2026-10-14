import { useState } from "react";
import { Modal, useChangeWorkspaceShape, useRunAction, useToast } from "@cobblr/platform-web";
import { api, type ModuleInstance } from "../lib/api";

const button = "min-h-11 rounded-md border border-line px-3 py-2 text-sm disabled:opacity-50";
const field = "block w-full rounded-md border border-line bg-surface p-2 text-sm";

export function ListOrganisation({ slug, instance, siblings }: { slug: string; instance: ModuleInstance; siblings: ModuleInstance[] }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [into, setInto] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // PRESS-ARGS: the sheet asks for the category or destination; the current list supplies the other required argument.
  const run = useRunAction();
  const changeShape = useChangeWorkspaceShape();
  const toast = useToast();
  // registry-filter-ok: these are list instances; folding only accepts another list of the same module.
  const destinations = siblings.filter((i) => i.module_name === instance.module_name && i.instance_name !== instance.instance_name);
  const save = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await changeShape(work);
      setOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const action = async (actionId: string, args: Record<string, unknown>) => {
    const out = await run({ actionId, args });
    const result = out.result as { ok?: boolean; error?: string; summary?: string } | null;
    if (!result?.ok) throw new Error(result?.error || "The list was not changed.");
    if (result.summary) toast.success(result.summary);
    return out;
  };
  return <>
    <button type="button" className={button} aria-label={`Organise ${instance.display_name}`} title={`Organise ${instance.display_name}`} onClick={() => { setError(""); setOpen(true); }}>Organise</button>
    <Modal open={open} onClose={() => { if (!busy) setOpen(false); }} title={`Organise ${instance.display_name}`} size="md">
      <div className="space-y-4">
        {instance.movable !== false && <>
          <section className="space-y-2">
            <p>Give one category a list of its own. Its records, history and labels move with it.</p>
            <label className="block text-sm">Category<input className={field} value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} /></label>
            <button type="button" className={button} disabled={busy || !category.trim()} onClick={() => void save(() => action("platform:promote-category", { from: instance.instance_name, category: category.trim() }))}>Give category its own list</button>
          </section>
          {!instance.is_default && destinations.length > 0 && <section className="space-y-2 border-t border-line pt-3">
            <p>Fold this whole list into another as a category. Every record moves and this list leaves the navigation.</p>
            <label className="block text-sm">Move into<select className={field} value={into} onChange={(e) => setInto(e.target.value)}><option value="">Choose a list</option>{destinations.map((i) => <option key={i.id} value={i.instance_name}>{i.display_name}</option>)}</select></label>
            <button type="button" className={button} disabled={busy || !into} onClick={() => void save(() => action("platform:demote-category", { list: instance.instance_name, into }))}>Fold this list into another</button>
          </section>}
        </>}
        <section className="space-y-2 border-t border-line pt-3">
          <p>Scans for this kind of thing that do not match another list will land here.</p>
          <button type="button" className={button} disabled={busy || instance.is_scan_fallback === true} onClick={() => void save(async () => { await api.setScanFallback(slug, instance.instance_name); toast.success("Unmatched scans will land here."); })}>{instance.is_scan_fallback === true ? "Unmatched scans land here" : "Send unmatched scans here"}</button>
        </section>
        {error && <p role="alert" className="text-sm text-ember-600 dark:text-ember-400">{error}</p>}
      </div>
    </Modal>
  </>;
}
