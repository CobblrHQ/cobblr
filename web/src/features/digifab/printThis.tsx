// Print this, in the page (Services §14.3): the door on a model file and on a
// Make, and the one confirm card that is the only yes before a machine moves.
//
// The flow itself runs on the server (digifab print-this.ts): a Make, the
// printer the part fits that is loaded with the filament, a slice for that
// printer. What lands here is the card that waits at the end of it: the
// preview, the printer, the spool and its slot, the grams and the time, and
// the sentence that says pressing Start moves a real machine.

import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Modal, EntityPhoto, NumberField, useToast } from "@cobblr/platform-web";
import { Printer } from "lucide-react";
import { api, ApiError, type MakeStepRecord } from "../../lib/api";
import { useActiveOrg } from "../../auth/ActiveOrgContext";
import { roleSatisfies } from "@cobblr/platform-contract/org-roles";
import type { EntityDetailPanelCtx } from "../../panels/types";
import { PrintBatchCard } from "./PrintBatchCard";

const MATERIALS = ["PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC"];

/** A file Print this can take: a model to slice, or G-code already sliced. */
export function isPrintable(filename: string): boolean {
  return /\.(stl|step|stp|3mf|gcode|bgcode)$/i.test(filename);
}

const message = (err: unknown) => (err instanceof ApiError ? err.message : (err as Error).message);

/** Ask for the material (and colour), then start Print this and open the Make. */
export function PrintThisDialog({ fileId, makeId, what, initialQuantity = 1, onClose }: { fileId?: string; makeId?: string; what: string; initialQuantity?: number; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [material, setMaterial] = useState("PLA");
  const [color, setColor] = useState("");
  const [quantity, setQuantity] = useState(initialQuantity);
  const [error, setError] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => api.printThis(activeSlug, { ...(fileId ? { file_id: fileId } : { make_id: makeId! }), material: material.trim(), quantity, ...(color.trim() ? { color: color.trim() } : {}) }),
    onSuccess: (r) => {
      toast.success(r.summary);
      void qc.invalidateQueries({ queryKey: ["makes", activeSlug] });
      onClose();
      navigate(`/makes/${r.make_id}`);
    },
    onError: (err) => setError(message(err)),
  });
  return (
    <Modal open onClose={onClose} title="Print this" subtitle={what}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (material.trim()) start.mutate();
        }}
      >
        <p className="text-sm text-muted">Cobblr picks the printer the part fits that has this material loaded, slices it for that printer, and waits for you to start it. Nothing prints until you press Start.</p>
        <label className="block text-sm">
          <span className="text-muted">Material</span>
          <input
            list="print-this-materials"
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            className="mt-1 w-full rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1.5"
            required
          />
          <datalist id="print-this-materials">
            {MATERIALS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <label className="block text-sm">
          <span className="text-muted">Colour (optional)</span>
          <input value={color} onChange={(e) => setColor(e.target.value)} placeholder="Any colour" className="mt-1 w-full rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1.5" />
        </label>
        <label className="block text-sm">
          <span className="text-muted">Prints</span>
          <NumberField integer min={1} max={10000} required value={quantity} onChange={setQuantity} className="mt-1 w-full rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1.5" />
        </label>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded border border-line dark:border-slate-700 px-3 py-1.5 text-sm">
            Cancel
          </button>
          <button type="submit" disabled={start.isPending || !material.trim()} className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm">
            <Printer size={14} /> {start.isPending ? "Choosing a printer…" : "Choose a printer and slice"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** The Print this door on a model file's own page. */
export function PrintThisFilePanel({ ctx }: { ctx: EntityDetailPanelCtx }) {
  const file = useQuery({ queryKey: ["file", ctx.slug, ctx.entityId], queryFn: () => api.getFile(ctx.slug, ctx.entityId) });
  const [open, setOpen] = useState(false);
  if (!file.data || !isPrintable(file.data.filename)) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-700 hover:border-accent px-3 py-1.5 text-sm">
        <Printer size={14} /> Print this
      </button>
      {open && <PrintThisDialog fileId={ctx.entityId} what={file.data.filename} onClose={() => setOpen(false)} />}
    </>
  );
}

const minutes = (s: number) => {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

/** The one yes. Everything a person needs to decide, and one button. */
export function PrintConfirmCard({ makeId, row }: { makeId: string; row: MakeStepRecord }) {
  return row.data.batch ? <PrintBatchCard makeId={makeId} row={row} /> : <SinglePrintConfirmCard makeId={makeId} row={row} />;
}

function SinglePrintConfirmCard({ makeId, row }: { makeId: string; row: MakeStepRecord }) {
  const { activeSlug, activeOrg } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const d = row.data as { printer?: string | null; spool?: string | null; slot?: string | null; grams?: number | null; time_s?: number | null; preview_file_id?: string | null; confirm_hash?: string };
  const canStart = roleSatisfies(activeOrg?.role, ["owner", "admin"]);
  // A second press before the first answers is the same yes, not another one.
  const pressed = useRef(false);
  const start = useMutation({
    mutationFn: () => api.startMakePrint(activeSlug, makeId, d.confirm_hash ?? ""),
    onSuccess: () => {
      toast.success(`Started on ${d.printer ?? "the printer"}`);
      void qc.invalidateQueries({ queryKey: ["makes", activeSlug] });
    },
    onError: (err) => {
      pressed.current = false;
      setError(message(err));
    },
  });
  const press = () => {
    if (pressed.current) return;
    pressed.current = true;
    setError(null);
    start.mutate();
  };
  const rows: Array<[string, string]> = [];
  if (d.printer) rows.push(["Printer", d.printer]);
  if (d.spool) rows.push(["Spool", d.slot ? `${d.spool}, slot ${d.slot}` : d.spool]);
  if (typeof d.grams === "number") rows.push(["Filament", `${Math.round(d.grams * 10) / 10} g`]);
  if (typeof d.time_s === "number") rows.push(["Time", minutes(d.time_s)]);
  return (
    <div data-testid="print-confirm-card" className="mt-1 rounded border border-accent/40 bg-subtle dark:bg-slate-800/60 p-3 space-y-2">
      <div className="flex gap-3">
        {d.preview_file_id && (
          <div className="relative w-24 h-24 shrink-0 rounded overflow-hidden border border-line dark:border-slate-700 bg-surface">
            <EntityPhoto src={api.fileRawUrl(activeSlug, d.preview_file_id, "medium")} alt="Slice preview" fill fit="contain" />
          </div>
        )}
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm self-start">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="text-content dark:text-mortar-200 break-words">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="text-sm font-medium text-content dark:text-mortar-100">This physically starts the print.</p>
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {canStart ? (
        <button type="button" disabled={start.isPending} onClick={press} className="inline-flex items-center gap-1.5 rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm">
          <Printer size={14} /> {start.isPending ? "Starting…" : "Start the print"}
        </button>
      ) : (
        <p className="text-sm text-muted">An owner or admin of this workspace starts prints. Ask one to press Start here.</p>
      )}
    </div>
  );
}
