import { useState, useRef } from "react";
import { Modal, useToast, FilePreview } from "@cobblr/platform-web";
import { api, ApiError, type DigifabJobReview } from "../../lib/api";
import { useActiveOrg } from "../../auth/ActiveOrgContext";

const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "Not reported";
const paramsOf = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

export function LightBurnReview({ review, starting, onStart, onClose, slug }: {
  slug: string;
  review: DigifabJobReview;
  starting: boolean;
  onStart: () => void;
  onClose: () => void;
}) {
  const units = paramsOf(review.project.units);
  return <Modal open onClose={onClose} title="Review LightBurn job" size="md">
    <div className="space-y-4 min-w-0">
      <p className="text-sm break-words">{text(review.sourceFile.filename)}</p>
      <div className="rounded border border-line bg-surface overflow-hidden" aria-label="Uploaded design preview"><FilePreview src={api.fileRawUrl(slug, review.sourceFile.id, "original")} filename={text(review.sourceFile.filename)} className="h-44" /></div>
      {review.transport === "udp" ? <p className="text-sm text-amber-700 dark:text-amber-300">This version has no REST project details. Check the layers, speed, power and passes in LightBurn before approving Start.</p> : <>
        <div className="space-y-3">
          {review.cuts.map((cut, i) => {
            const params = paramsOf(cut.params);
            const layer = review.layers.find(l => l.index === cut.layer_index);
            const power = params.min_power == null ? `${text(params.max_power)}%` : `${text(params.min_power)}% to ${text(params.max_power)}%`;
            return <section key={text(cut.index ?? i)} className="rounded border border-line p-3 space-y-2">
              <h3 className="text-sm font-semibold break-words">{text(layer?.name ?? cut.name)}{cut.enabled === false ? " (disabled)" : ""}</h3>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt>Mode</dt><dd>{text(cut.mode ?? cut.kind)}</dd>
                <dt>Speed</dt><dd>{text(params.speed)} {text(units.speed)}</dd>
                <dt>Power</dt><dd>{power}</dd>
                <dt>Passes</dt><dd>{text(params.num_passes)}</dd>
              </dl>
              {Array.isArray(cut.sub_layers) && cut.sub_layers.length > 0 && <div className="text-sm space-y-1">{cut.sub_layers.map((sub, index) => {
                const settings = paramsOf(sub);
                return <p key={index}>Sub-layer {index + 1}: {text(settings.speed)} {text(units.speed)}, {text(settings.max_power)}% power, Z offset {text(settings.z_offset)} {text(units.distance)}</p>;
              })}</div>}
            </section>;
          })}
          {review.cuts.length === 0 && <p className="text-sm">No cut settings were reported. Check the project in LightBurn.</p>}
        </div>
        <details className="text-sm">
          <summary className="font-medium cursor-pointer">Material library: {text(review.materialLibrary.name)}</summary>
          <p className="text-xs text-muted py-2">These are the loaded library entries. LightBurn does not report which entry was used for this project.</p>
          <div className="space-y-2">{(Array.isArray(review.materialLibrary.entries) ? review.materialLibrary.entries : []).map((raw, i) => {
            const entry = paramsOf(raw);
            const settings = paramsOf(paramsOf(entry.cut).params);
            return <div key={text(entry.guid ?? i)} className="rounded border border-line p-2 break-words">
              <p>{text(entry.material)}: {text(entry.description)}{typeof entry.thickness === "number" && entry.thickness >= 0 ? ` (${entry.thickness} ${text(units.distance)})` : ""}</p>
              {entry.cut != null && <p className="text-xs text-muted">Speed {text(settings.speed)} {text(units.speed)}, power {text(settings.max_power)}%, passes {text(settings.num_passes)}</p>}
            </div>;
          })}</div>
          {(!Array.isArray(review.materialLibrary.entries) || review.materialLibrary.entries.length === 0) && <p className="text-muted py-2">No material library entries were reported.</p>}
        </details>
      </>}
      <p className="text-sm">This physically starts the laser. Check the material and keep the machine supervised. Stop it in LightBurn or at the machine.</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button onClick={onClose} disabled={starting} className="px-3 py-2 rounded border border-line">Back</button>
        <button onClick={onStart} disabled={starting} className="px-3 py-2 rounded bg-ember-600 text-white disabled:opacity-50">{starting ? "Starting…" : "Approve and start laser"}</button>
      </div>
    </div>
  </Modal>;
}

export function useJobStartReview(onStarted: () => void) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [pending, setPending] = useState<{ id: string; review: DigifabJobReview } | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const beforeStart = async (id: string, otherwise: () => Promise<void>) => {
    if (working.current || pending) return;
    working.current = true;
    setBusy(true);
    try {
      const { review } = await api.prepareDigifabJob(activeSlug, id);
      if (review) setPending({ id, review });
      else await otherwise();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : String(e)); }
    finally { working.current = false; setBusy(false); }
  };
  const start = async () => {
    if (!pending || working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await api.sendDigifabJob(activeSlug, pending.id, { fileId: pending.review.fileId, projectHash: pending.review.projectHash });
      toast.success("Start sent, waiting for LightBurn to report running");
      setPending(null);
      onStarted();
    } catch (e) { toast.error(e instanceof ApiError ? e.message : String(e)); setPending(null); }
    finally { working.current = false; setBusy(false); }
  };
  return { beforeStart, busy, sheet: pending ? <LightBurnReview slug={activeSlug} review={pending.review} starting={busy} onStart={() => void start()} onClose={() => { if (!working.current) setPending(null); }} /> : null };
}
