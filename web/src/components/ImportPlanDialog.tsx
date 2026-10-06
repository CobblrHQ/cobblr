// Import a plan: a whole house as one cobblr-floorplan/1 file, from another
// AI or a person. Paste or pick the file; what is wrong with it is said at
// once, by line and field; a good one is previewed (every room drawn to
// scale, what will be made and what updated, and every warning) before
// anything is written. Import is one step with Undo. Beside it: Copy a prompt
// for another AI (the same prompt the docs print), and Export.
// See docs/modules/floorplan-file-format.md.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Modal, downloadBlob, useToast } from "@cobblr/platform-web";
import { FLOORPLAN_PROMPT, problemSentence, readFloorplanFile, type FloorplanContainerT, type FloorplanRoomT } from "@cobblr/platform-contract/floorplan-format";
import { ApiError, api, type FloorplanImportResult } from "../lib/api";

const pct = (v: number, total: number) => `${(v / total) * 100}%`;

function RoomPreview({ room }: { room: FloorplanRoomT }) {
  // Drawn where the import will put it: inside the room, outlined red when
  // it had to be moved there (the importer's own rule, floorplan-file.ts).
  const box = (c: FloorplanContainerT) => {
    const w = Math.min(c.w_mm, room.w_mm), d = Math.min(c.d_mm, room.d_mm);
    const x = Math.max(0, Math.min(c.x_mm, room.w_mm - w)), y = Math.max(0, Math.min(c.y_mm, room.d_mm - d));
    const moved = w !== c.w_mm || d !== c.d_mm || x !== c.x_mm || y !== c.y_mm;
    return (
      <div
        key={c.name}
        title={moved ? `${c.name}: moved inside the room` : c.name}
        data-preview-moved={moved ? "true" : undefined}
        className={`absolute overflow-hidden rounded-sm border bg-cobble-100 dark:bg-cobble-900 text-[9px] leading-tight px-0.5 text-content dark:text-slate-200 ${moved ? "border-ember-500" : "border-slate-500 dark:border-slate-400"}`}
        style={{ left: pct(x, room.w_mm), top: pct(y, room.d_mm), width: pct(w, room.w_mm), height: pct(d, room.d_mm) }}
      >
        {c.name}
      </div>
    );
  };
  return (
    <figure className="m-0">
      <figcaption className="mb-1 text-xs font-medium text-content dark:text-slate-200">
        {[room.level, room.name].filter(Boolean).join(" › ")}
      </figcaption>
      <div
        data-preview-room={room.name}
        className="relative w-full max-w-xs border-2 border-slate-500 dark:border-slate-400 bg-surface dark:bg-slate-900"
        style={{ aspectRatio: `${room.w_mm} / ${room.d_mm}` }}
      >
        {(room.walls ?? []).map((w, i) => (
          <svg key={i} className="absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${room.w_mm} ${room.d_mm}`} preserveAspectRatio="none" aria-hidden>
            <line x1={w.x1} y1={w.y1} x2={w.x2} y2={w.y2} className="stroke-slate-600 dark:stroke-slate-300" strokeWidth={Math.max(room.w_mm, room.d_mm) / 120} />
          </svg>
        ))}
        {(room.zones ?? []).map((z) => (
          <div key={z.name} className="absolute border border-dashed border-slate-400 dark:border-slate-500" style={{ left: pct(z.x_mm, room.w_mm), top: pct(z.y_mm, room.d_mm), width: pct(z.w_mm, room.w_mm), height: pct(z.d_mm, room.d_mm) }} />
        ))}
        {(room.containers ?? []).map(box)}
      </div>
    </figure>
  );
}

export function ImportPlanDialog({ slug, onClose }: { slug: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState("");
  const read = useMemo(() => (text.trim() ? readFloorplanFile(text) : null), [text]);
  const plan = read?.plan ?? null;
  const [preview, setPreview] = useState<FloorplanImportResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  useEffect(() => {
    setPreview(null);
    setPreviewError(null);
    if (!plan) return;
    let live = true;
    api
      .floorplanImport(slug, plan, true)
      .then((r) => live && setPreview(r))
      .catch((e) => live && setPreviewError(e instanceof ApiError ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [plan, slug]);

  const refresh = () => void qc.invalidateQueries({ queryKey: ["core-locations", slug] });
  const run = useMutation({
    mutationFn: () => api.floorplanImport(slug, plan, false),
    onSuccess: (r) => {
      refresh();
      onClose();
      toast.action(r.note, {
        actionLabel: "Undo",
        onAction: async () => {
          const back = await api.floorplanImportUndo(slug, { created: r.created, updated: r.updated });
          refresh();
          toast.success(back.note);
        },
      });
    },
  });
  const counts = preview
    ? { create: preview.steps.filter((s) => s.action === "create").length, update: preview.steps.filter((s) => s.action === "update").length }
    : null;

  return (
    <Modal open onClose={onClose} title="Import a plan" size="lg">
      <div className="space-y-3">
        <p className="text-sm text-muted dark:text-slate-400">
          A whole home or workshop as one cobblr-floorplan/1 file. Ask any AI with the prompt (Copy a prompt for another AI), then paste what it gives you here, or pick the file.
        </p>
        <textarea
          aria-label="The plan"
          data-testid="plan-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='{ "format": "cobblr-floorplan/1", "rooms": [ … ] }'
          rows={8}
          className="w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 font-mono text-sm text-content dark:text-slate-100"
        />
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-accent hover:underline">
          Pick a file
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setText(await f.text());
            }}
          />
        </label>
        {read && !plan && (
          <ul data-testid="plan-problems" className="space-y-0.5 text-sm text-ember-700 dark:text-ember-300">
            {read.problems.map((p, i) => (
              <li key={i}>{problemSentence(p)}</li>
            ))}
          </ul>
        )}
        {previewError && <p className="text-sm text-ember-700 dark:text-ember-300">{previewError}</p>}
        {plan && preview && counts && (
          <div data-testid="plan-preview" className="space-y-3">
            <p className="text-sm text-content dark:text-slate-200">{preview.note}</p>
            {preview.warnings.length > 0 && (
              <ul className="space-y-0.5 text-sm text-ember-700 dark:text-ember-300">
                {preview.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {plan.rooms.map((r) => (
                <RoomPreview key={`${r.level ?? ""}/${r.name}`} room={r} />
              ))}
            </div>
            <details className="text-xs text-muted dark:text-slate-400">
              <summary className="cursor-pointer">Every place, and what happens to it</summary>
              <ul className="mt-1 space-y-0.5">
                {preview.steps.map((s) => (
                  <li key={s.path}>
                    <span className={s.action === "create" ? "text-accent" : s.action === "update" ? "text-content dark:text-slate-200" : ""}>
                      {s.action === "create" ? "new" : s.action === "update" ? "updated" : "as it is"}
                    </span>{" "}
                    {s.path}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        )}
        {run.isError && <p className="text-sm text-ember-700 dark:text-ember-300">{run.error instanceof ApiError ? run.error.message : String(run.error)}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm text-muted hover:text-content">
            Cancel
          </button>
          <button
            type="button"
            disabled={!preview || !counts || counts.create + counts.update === 0 || run.isPending}
            onClick={() => run.mutate()}
            className="rounded bg-cobble-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {counts && counts.create + counts.update === 0 ? "Nothing to change" : "Import"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** The plan file's buttons: Import a plan, Export this one, and Copy a prompt
 *  for another AI. */
export function PlanFileButtons({ slug, exportId, exportName }: { slug: string; exportId: string | null; exportName: string | null }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const btn = "inline-flex items-center gap-1 rounded-full border border-line dark:border-slate-600 px-3 py-1 text-sm text-muted hover:border-accent hover:text-accent transition";
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={btn}>
        Import a plan
      </button>
      {exportId && (
        <button
          type="button"
          className={btn}
          onClick={async () => {
            try {
              const file = await api.floorplanExport(slug, exportId);
              downloadBlob(new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }), `${(exportName ?? "plan").replace(/[^\w-]+/g, "-")}.cobblr-floorplan.json`);
            } catch (e) {
              toast.error(e instanceof ApiError ? e.message : String(e));
            }
          }}
        >
          Export
        </button>
      )}
      <button
        type="button"
        className={btn}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(FLOORPLAN_PROMPT);
            toast.success("Copied. Paste it into any AI, answer its questions, and import what it gives you.");
          } catch {
            toast.error("Could not copy here. The prompt is in the docs: A floor plan as one file.");
          }
        }}
      >
        Copy a prompt for another AI
      </button>
      {open && <ImportPlanDialog slug={slug} onClose={() => setOpen(false)} />}
    </>
  );
}
