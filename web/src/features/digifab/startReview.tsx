import { productName } from "@cobblr/platform-web";
import { laserLayerLabel } from "../../lib/laser-layer-label";
import { useState, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Modal, useToast, FilePreview, EntityPhoto, useImageSrc } from "@cobblr/platform-web";
import { api, ApiError, type DigifabJobReview, type DigifabLibraryItem } from "../../lib/api";
import { useActiveOrg } from "../../auth/ActiveOrgContext";

import { LaserDrawing } from "./LaserLayout";

const text = (value: unknown) => typeof value === "string" || typeof value === "number" ? String(value) : "Not reported";
const paramsOf = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

export function LightBurnReview({ review, library, starting, onStart, onClose, onFrame, error, controls, slug, atStation = false }: {
  atStation?: boolean;
  library?: DigifabLibraryItem;
  slug: string;
  review: DigifabJobReview;
  starting: boolean;
  onStart: () => void;
  onClose: () => void;
  onFrame?: () => void;
  error?: string;
  controls?: ReactNode;
}) {
  const source = library?.file_id === review.sourceFile.id ? library : undefined;
  const layout = source?.metadata?.laser_layout;
  const material = source?.metadata?.laser_material;
  const units = paramsOf(review.project.units);
  const thumbnail = useImageSrc(review.thumbnailFileId ? api.fileRawUrl(slug, review.thumbnailFileId) : null);
  return <Modal open onClose={onClose} title={review.transport === "compiled" ? "Review compiled laser job" : "Review LightBurn job"} size="md" footer={controls}>
    <div className="space-y-4 min-w-0">
      {error && <p role="alert" className="rounded border border-red-500 p-3 break-words">{error}</p>}
      <p className="text-sm break-words">{source?.name || text(review.sourceFile.filename)}</p>
      {review.project.backend === "ruida" && <p className="text-sm">Ruida uses tube 1. Set focus at the machine.</p>}
      {review.project.backend === "galvo" && <section className="rounded border border-line p-3 space-y-2 text-sm">
        <p>Galvo source: {text(review.project.source)}. Field: {text(paramsOf(review.project.field).width)} × {text(paramsOf(review.project.field).height)} mm. Set focus at the machine and check placement with the red guide.</p>
        <p>{text(review.project.frequencyKhz)} kHz{review.project.pulseWidthNs!=null?`, ${text(review.project.pulseWidthNs)} ns pulse`:", fixed pulse width"}. {review.project.airAssist==="manual"?"Air assist is manual. Set it at the machine.":"Air assist uses the confirmed output."}</p>
        <p>Lens correction: <span className="break-all">{text(review.project.lensHash)}</span></p>
        {Array.isArray(review.project.effectiveLayers)&&review.project.effectiveLayers.map((raw,index)=>{const layer=paramsOf(raw);return <p key={index}>Compiled layer {text(layer.index)}: {Number(layer.speedMin).toFixed(3)} mm/s to {Number(layer.speedMax).toFixed(3)} mm/s, {Number(layer.powerPercent).toFixed(3)}% power, {Number(layer.frequencyKhz).toFixed(3)} kHz. Native command rounding is included.</p>;})}
      </section>}
      <div className="rounded border border-line bg-surface overflow-hidden" aria-label="Uploaded design preview">{layout && material ? <LaserDrawing design={layout.design} parts={layout.parts} width={material.width_mm} height={material.height_mm} /> : review.thumbnailFileId ? thumbnail ? <EntityPhoto src={thumbnail} alt="Design to cut" fit="contain" aspect="16/9" /> : <p className="p-4 text-sm">Loading design thumbnail…</p> : <FilePreview src={api.fileRawUrl(slug, review.sourceFile.id, "original")} filename={text(review.sourceFile.filename)} className="h-44" />}</div>
      {review.transport === "udp" ? <p className="text-sm text-amber-700 dark:text-amber-300">This version has no REST project details. Check the layers, speed, power and passes in LightBurn before approving Start.</p> : <>
        <div className="space-y-3">
          {review.cuts.map((cut, i) => {
            const params = paramsOf(cut.params);
            const layer = review.layers.find(l => l.index === cut.layer_index);
            const power = params.min_power == null ? `${text(params.max_power)}%` : `${text(params.min_power)}% to ${text(params.max_power)}%`;
            return <section key={text(cut.index ?? i)} className="rounded border border-line p-3 space-y-2">
              <h3 className="text-sm font-semibold break-words">{laserLayerLabel(text(layer?.name ?? cut.name))}{cut.enabled === false ? " (disabled)" : ""}</h3>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt>Mode</dt><dd>{text(cut.mode ?? cut.kind)}</dd>
                <dt>Speed</dt><dd>{text(params.speed)} {text(units.speed)}</dd>
                <dt>Power</dt><dd>{power}</dd>
                <dt>Passes</dt><dd>{text(params.num_passes)}</dd>
                {review.transport === "compiled" && <><dt>Air assist</dt><dd>{params.air_assist === true ? "On" : params.air_assist === false ? "Off" : "Not reported"}</dd><dt>Focus offset</dt><dd>{text(params.z_offset)} {text(units.distance)}</dd></>}
              </dl>
              {Array.isArray(cut.sub_layers) && cut.sub_layers.length > 0 && <div className="text-sm space-y-1">{cut.sub_layers.map((sub, index) => {
                const settings = paramsOf(sub);
                return <p key={index}>Sub-layer {index + 1}: {text(settings.speed)} {text(units.speed)}, {text(settings.max_power)}% power, Z offset {text(settings.z_offset)} {text(units.distance)}</p>;
              })}</div>}
            </section>;
          })}
          {review.cuts.length === 0 && <p className="text-sm">No cut settings were reported. Check the project in LightBurn.</p>}
        </div>
        {review.transport !== "compiled" && <details className="text-sm">
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
        </details>}
      </>}
      <p className="text-sm">{review.transport === "compiled" ? `These settings were compiled by ${productName()}. Frame the bounds, check the material and keep the machine supervised. Use Stop laser at the station or the stop at the machine.` : "This physically starts the laser. Check the material and keep the machine supervised. Stop it in LightBurn or at the machine."}</p>
      <div className="flex flex-wrap justify-end gap-2">
        {onFrame && <button onClick={onFrame} disabled={starting} className="min-h-11 px-3 py-2 rounded border border-line">Frame with laser off</button>}
        <button onClick={onClose} disabled={starting} className="px-3 py-2 rounded border border-line">Back</button>
        <button onClick={onStart} disabled={starting || !atStation} className="min-h-11 px-3 py-2 rounded bg-ember-600 text-white disabled:opacity-50">{starting ? "Starting…" : atStation ? "Approve and start laser" : "Approve at the laser's station"}</button>
      </div>
    </div>
  </Modal>;
}

export function useJobStartReview(onStarted: () => void) {
  const { activeSlug } = useActiveOrg();
  const toast = useToast();
  const [pending, setPending] = useState<{ id: string; review: DigifabJobReview } | null>(null);
  const [busy, setBusy] = useState(false);
  const [station, setStation] = useState<{ connectionId: string; deviceId: string | null } | null>(null);
  const working = useRef(false);
  const beforeStart = async (id: string, otherwise: () => Promise<void>) => {
    if (working.current || pending) return;
    working.current = true;
    setBusy(true);
    try {
      const { review, stationRequired } = await api.prepareDigifabJob(activeSlug, id);
      if (stationRequired) setStation(stationRequired);
      else if (review) setPending({ id, review });
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
  return { beforeStart, busy, sheet: station ? <Modal open onClose={() => setStation(null)} title="Approve at the laser's station"><p className="mb-4">The job is queued. Load and confirm its sheet at the laser before Start.</p>{station.deviceId ? <Link className="inline-flex min-h-11 items-center rounded bg-ember-600 text-white px-4 py-2" to={`/station/machine/${station.connectionId}/${encodeURIComponent(station.deviceId)}`}>Open machine station</Link> : <p>Choose this laser as the job's target machine first.</p>}</Modal> : pending ? <LightBurnReview slug={activeSlug} review={pending.review} starting={busy} onStart={() => void start()} onClose={() => { if (!working.current) setPending(null); }} /> : null };
}
