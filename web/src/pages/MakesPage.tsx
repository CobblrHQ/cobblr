import { ADMIN_TIER } from "@cobblr/platform-contract/org-roles";
import { useRoleAtLeast } from "../lib/can";
// Makes: every print's history, from what was asked for to how it came out
// (services.md §13). The list finds one by what it was, where it was made or
// what it was made from; a Make's own page is its timeline.
//
// The timeline's shape is the server's (makes-core.ts timelineFor), never
// worked out here: placeholders for the steps still to come when this
// workspace can do them, and an honest end with one way on when it cannot.
// This page only draws what it is given, so the page and the rule cannot
// disagree about what happens next.

import { useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, CircleDashed, FileText, Loader2, RotateCcw, Sparkles, Upload, XCircle } from "lucide-react";
import { RecordFormModal, CustomFieldsPanel, EntityPhoto, FilePreview, Modal, SearchInput, useConfirm, useFilePreviewRegistry, usePageTitle, usePasteImage, useToast } from "@cobblr/platform-web";
import { api, ApiError, MAKE_STEPS, type MakeDetail, type MakeFileRole, type MakeStepName, type MakeStepRecord, type MakeSummary } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useEnabledModules } from "../lib/useEnabledModules";
import { openAuthedFile } from "../lib/authed-file";
import { ServiceJobCard } from "../components/ServiceJobCard";
import { DesignMakeDoor } from "../features/digifab/designMake";
import { PrintConfirmCard, PrintThisDialog } from "../features/digifab/printThis";

import { countOf } from "@cobblr/platform-contract/plural";
const STEP_TITLE: Record<MakeStepName, string> = {
  request: "Request",
  design: "Design",
  model: "Model",
  slice: "Slice",
  print: "Print",
  outcome: "Outcome",
};

/** Query keys for Makes, one family so a change refreshes the list and the page together. */
const makeKeys = {
  all: (slug: string) => ["makes", slug] as const,
  list: (slug: string, q: string) => ["makes", slug, "list", q] as const,
  one: (slug: string, id: string) => ["makes", slug, "one", id] as const,
};

/** What a file a person brings starts: a model is the Model step, G-code is the Slice. */
export function stepForFile(filename: string): { step: "model" | "slice"; role: MakeFileRole } | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "stl") return { step: "model", role: "stl" };
  if (ext === "step" || ext === "stp") return { step: "model", role: "step" };
  if (ext === "3mf") return { step: "model", role: "3mf" };
  if (ext === "gcode" || ext === "bgcode" || ext === "gco") return { step: "slice", role: "gcode" };
  return null;
}

const nameFromFile = (filename: string) => filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || filename;

// ── the list ────────────────────────────────────────────────────────────────

export function MakesPage() {
  usePageTitle("Makes");
  const { activeSlug } = useActiveOrg();
  const on = useEnabledModules(activeSlug);
  const [search, setSearch] = useState("");
  const [starting, setStarting] = useState(false);
  const q = search.trim();
  const list = useQuery({
    queryKey: makeKeys.list(activeSlug, q),
    queryFn: () => api.listMakes(activeSlug, q || undefined),
    enabled: !!activeSlug && !!on?.has("digifab"),
  });
  const items = list.data?.items ?? [];

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <div className="flex items-center gap-3 mb-1">
        <h1 className="text-xl font-semibold text-content dark:text-mortar-100 flex-1">Makes</h1>
        <button type="button" onClick={() => setStarting(true)} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white">
          New make
        </button>
      </div>
      <p className="text-sm text-muted mb-4">
        Every print from what was asked for to how it came out: the design, the model, the slicer settings, the printer and the spool. <Link to="/digifab" className="text-accent hover:underline">Printers</Link>
      </p>
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Find a make by what it was, the printer or the material"
        aria-label="Find a make"
        wrapperClassName="mb-4"
      />
      {list.isLoading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : list.isError ? (
        <div className="rounded border border-dashed border-line dark:border-slate-600 p-6 text-center text-sm text-muted">
          Makes come with Digital Fabrication, which is not on in this workspace. <Link to="/configuration/modules" className="text-accent hover:underline">Turn it on in Modules</Link>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded border border-dashed border-line dark:border-slate-600 p-6 text-center text-sm text-muted">
          {q ? `No make matches "${q}".` : "Nothing made yet. Start one from a description, or bring a model or G-code you already have."}
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((m) => (
            <li key={m.id}>
              <MakeRow make={m} />
            </li>
          ))}
        </ul>
      )}
      {starting && <NewMakeModal onClose={() => setStarting(false)} />}
    </div>
  );
}

function MakeRow({ make }: { make: MakeSummary }) {
  const last = make.last_step;
  const bits = [make.printer_name, make.material].filter(Boolean).join(" · ");
  return (
    <Link to={`/makes/${make.id}`} className="block rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-2 hover:border-accent transition">
      <div className="flex items-center gap-2">
        <span className="font-medium text-content dark:text-mortar-100 flex-1 min-w-0 truncate">{make.name}</span>
        {make.outcome === "pass" && <span className="text-xs text-emerald-700 dark:text-emerald-400">Came out well</span>}
        {make.outcome === "fail" && <span className="text-xs text-red-700 dark:text-red-400">Failed</span>}
        {!make.outcome && last && <span className="text-xs text-muted">{STEP_TITLE[last.step]}{last.status === "done" ? "" : ` · ${statusWords(last.status)}`}</span>}
      </div>
      {(make.prompt || bits) && <div className="text-xs text-muted truncate">{[make.prompt, bits].filter(Boolean).join(" · ")}</div>}
    </Link>
  );
}

function statusWords(status: string): string {
  switch (status) {
    case "running":
      return "in progress";
    case "needs_input":
      return "needs an answer";
    case "awaiting_confirm":
      return "waiting for your OK";
    case "failed":
      return "failed";
    default:
      return "done";
  }
}

// ── starting a Make ─────────────────────────────────────────────────────────

function NewMakeModal({ onClose }: { onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const brought = file ? stepForFile(file.name) : null;

  const start = useMutation({
    mutationFn: async () => {
      if (file) {
        if (!brought) throw new Error("A make starts from a model (STL, STEP or 3MF) or from G-code.");
        const stored = await api.uploadFile(activeSlug, file);
        return api.createMake(activeSlug, { name: name.trim() || nameFromFile(file.name), start_at: brought.step, files: [{ file_id: stored.id, role: brought.role }] });
      }
      return api.createMake(activeSlug, { name: name.trim() || prompt.trim().slice(0, 80), prompt: prompt.trim() });
    },
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: makeKeys.all(activeSlug) });
      onClose();
      navigate(`/makes/${m.id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : (err as Error).message),
  });
  const ready = file ? !!brought : prompt.trim().length > 0;

  return (
    <RecordFormModal open onClose={onClose} title="New make">
      <div className="space-y-3">
        <label className="block text-sm">
          <span className="text-muted">What to make</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!!file}
            rows={3}
            placeholder="A 20 mm round spacer with a hole for an M3 screw, in black PETG"
            className="mt-1 w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5"
          />
        </label>
        <div className="text-xs text-faint text-center">or</div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => fileInput.current?.click()} className="inline-flex items-center gap-2 rounded border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 px-3 py-1.5 text-sm transition">
            <Upload className="w-4 h-4" /> Bring a model or G-code
          </button>
          {file && (
            <span className="text-sm text-muted truncate">
              {file.name}
              {brought ? ` starts at ${STEP_TITLE[brought.step].toLowerCase()}` : ": not a model or G-code"}
            </span>
          )}
          <input
            ref={fileInput}
            type="file"
            accept=".stl,.step,.stp,.3mf,.gcode,.bgcode,.gco"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <label className="block text-sm">
          <span className="text-muted">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={file ? nameFromFile(file.name) : "Round spacer"} className="mt-1 w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5" />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">
            Cancel
          </button>
          <button type="button" disabled={!ready || start.isPending} onClick={() => start.mutate()} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
            {start.isPending ? "Starting…" : "Start"}
          </button>
        </div>
      </div>
    </RecordFormModal>
  );
}

// ── one Make: its timeline ──────────────────────────────────────────────────

export function MakePage() {
  const { id = "" } = useParams();
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const navigate = useNavigate();
  useFilePreviewRegistry();
  const [reading, setReading] = useState<MakeStepRecord["files"][number] | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const on = useEnabledModules(activeSlug);
  const one = useQuery({
    queryKey: makeKeys.one(activeSlug, id),
    queryFn: () => api.getMake(activeSlug, id),
    enabled: !!activeSlug && !!id && !!on?.has("digifab"),
    // A step a service is doing (a slice) and a print in progress both move on
    // their own; the page follows them. A slice that finishes turns into the
    // print's confirm card without a reload.
    refetchInterval: (query) => {
      const d = query.state.data;
      if (d?.steps.some((st) => st.step !== "print" && (st.status === "running" || st.status === "needs_input"))) return 3_000;
      return d?.print && (d.print.material_pending || ["sent", "printing", "queued", "assigning"].includes(d.print.status)) ? 10_000 : false;
    },
  });
  usePageTitle(one.data?.make.name ?? "Make");
  const refresh = () => void qc.invalidateQueries({ queryKey: makeKeys.all(activeSlug) });
  const fail = (err: unknown) => toast.error(err instanceof ApiError ? err.message : (err as Error).message);

  const setOutcome = useMutation({
    mutationFn: (body: { outcome?: "pass" | "fail" | null; outcome_notes?: string }) => api.patchMake(activeSlug, id, body),
    onSuccess: refresh,
    onError: fail,
  });
  const mayDelete = useRoleAtLeast(ADMIN_TIER);
  const setField = useMutation({
    mutationFn: (metadata: Record<string, unknown>) => api.patchMake(activeSlug, id, { metadata }),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api.deleteMake(activeSlug, id),
    onSuccess: () => {
      refresh();
      toast.success("Make deleted. Its files are still in Files.");
      navigate("/makes");
    },
    onError: fail,
  });
  const bring = useMutation({
    mutationFn: async (v: { file: File; step: "model" | "slice" }) => {
      const kind = stepForFile(v.file.name);
      if (!kind || kind.step !== v.step) throw new Error(v.step === "model" ? "Bring a model: an STL, STEP or 3MF." : "Bring the G-code you sliced.");
      const stored = await api.uploadFile(activeSlug, v.file);
      return api.addMakeFiles(activeSlug, id, { step: v.step, files: [{ file_id: stored.id, role: kind.role }] });
    },
    onSuccess: refresh,
    onError: fail,
  });

  if (on && !on.has("digifab")) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6 text-sm text-muted" data-testid="make-digifab-off">
        Makes come with Digital Fabrication, which is not on in this workspace. <Link to="/configuration/modules" className="text-accent hover:underline">Turn it on in Modules</Link>
      </div>
    );
  }
  if (on === null || one.isLoading) return <div className="max-w-3xl mx-auto px-4 py-6 text-sm text-muted">Loading…</div>;
  if (one.isError || !one.data) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-6 text-sm">
        <p className="text-muted mb-2">This make could not be found.</p>
        <Link to="/makes" className="text-accent hover:underline">All makes</Link>
      </div>
    );
  }
  const d = one.data;

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <div className="text-xs mb-2">
        <Link to="/makes" className="text-accent hover:underline">All makes</Link>
      </div>
      <div className="flex items-start gap-3 mb-1">
        <h1 className="text-xl font-semibold text-content dark:text-mortar-100 flex-1 min-w-0">{d.make.name}</h1>
        <button type="button" onClick={() => setRerunning(true)} className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 px-3 py-1.5 text-sm transition">
          <RotateCcw className="w-4 h-4" /> Make again
        </button>
        {mayDelete && <button
          type="button"
          onClick={async () => {
            if (await confirm({ title: "Delete this make?", message: "Its history goes. Its files stay in Files.", confirmLabel: "Delete", destructive: true })) remove.mutate();
          }}
          className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800"
        >
          Delete
        </button>}
      </div>
      {d.rerun_of && (
        <p className="text-sm text-muted mb-1">
          Made again from {STEP_TITLE[d.make.rerun_from_step ?? "design"].toLowerCase()} of <Link to={`/makes/${d.rerun_of.id}`} className="text-accent hover:underline">{d.rerun_of.name}</Link>
        </p>
      )}
      {d.made_for && (
        <p className="text-sm text-muted mb-1">
          Made for{" "}
          {d.made_for.detail_url ? (
            <Link to={d.made_for.detail_url} className="text-accent hover:underline">{d.made_for.title ?? "the record that asked for it"}</Link>
          ) : (
            <span className="text-content dark:text-mortar-200">{d.made_for.title ?? "the record that asked for it"}</span>
          )}
        </p>
      )}
      {d.make.folder_id && (
        <p className="text-xs text-faint mb-4">
          Every file is kept in <Link to={`/files?folder=${d.make.folder_id}`} className="text-accent hover:underline">its folder in Files</Link>.
        </p>
      )}

      <ol className="relative border-l border-line dark:border-slate-700 ml-3 space-y-4 mt-4">
        {d.timeline.entries.map((e) =>
          e.state === "recorded" ? (
            <RecordedStep key={e.step} row={e.row} detail={d} onOpenFile={setReading} onOutcome={(o) => setOutcome.mutate({ outcome: o })} />
          ) : (
            <li key={e.step} className="ml-5">
              <CircleDashed className="absolute -left-[9px] w-[18px] h-[18px] text-faint bg-surface dark:bg-slate-950" />
              <div className="rounded border border-dashed border-line dark:border-slate-700 px-3 py-2 text-sm text-faint">{e.hint}</div>
              {e.step === "outcome" && d.steps.some((s) => s.step === "print") && (
                <OutcomeButtons onPick={(o) => setOutcome.mutate({ outcome: o })} />
              )}
            </li>
          ),
        )}
        {d.timeline.end && (
          <li className="ml-5">
            <Circle className="absolute -left-[9px] w-[18px] h-[18px] text-amber-500 bg-surface dark:bg-slate-950" />
            <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-3 py-2">
              <p className="text-sm text-content dark:text-mortar-100 mb-2">{d.timeline.end.sentence}</p>
              <div className="flex flex-wrap gap-2">
                {d.timeline.end.doors.map((door) =>
                  door.href ? (
                    <Link key={door.label} to={door.href} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white">
                      {door.label}
                    </Link>
                  ) : door.action === "upload-model" || door.action === "upload-gcode" ? (
                    <FileDoor key={door.label} label={door.label} accept={door.action === "upload-model" ? ".stl,.step,.stp,.3mf" : ".gcode,.bgcode,.gco"} busy={bring.isPending} onFile={(file) => bring.mutate({ file, step: door.action === "upload-model" ? "model" : "slice" })} />
                  ) : door.action === "rerun" ? (
                    <button key={door.label} type="button" onClick={() => setRerunning(true)} className="px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white">
                      {door.label}
                    </button>
                  ) : null,
                )}
              </div>
            </div>
          </li>
        )}
      </ol>

      {/* The Make's own fields, as a bundle or a person defines them. */}
      <CustomFieldsPanel className="mt-6" entityKind="digifab:make" entityId={d.make.id} values={d.make.metadata ?? {}} onCommit={(name, value) => setField.mutate({ [name]: value })} />

      {d.reruns.length > 0 && (
        <div className="mt-6">
          <h2 className="text-[10px] uppercase tracking-widest text-faint mb-1">Made again</h2>
          <ul className="space-y-1">
            {d.reruns.map((r) => (
              <li key={r.id} className="text-sm">
                <Link to={`/makes/${r.id}`} className="text-accent hover:underline">{r.name}</Link>
                <span className="text-muted"> from {STEP_TITLE[r.rerun_from_step ?? "design"].toLowerCase()}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {reading && (
        <Modal open onClose={() => setReading(null)} title={reading.filename} size="lg" fillHeight>
          <div className="flex justify-end mb-2">
            <button type="button" onClick={() => void openAuthedFile(activeSlug, reading.file_id, { mime: reading.mime_type, filename: reading.filename })} className="text-xs text-muted hover:text-accent underline decoration-dotted underline-offset-2">
              Open in a new tab
            </button>
          </div>
          <FilePreview src={api.fileRawUrl(activeSlug, reading.file_id, "original")} filename={reading.filename} />
        </Modal>
      )}
      {rerunning && <RerunModal make={d} onClose={() => setRerunning(false)} />}
    </div>
  );
}

function FileDoor({ label, accept, busy, onFile }: { label: string; accept: string; busy: boolean; onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  // A door that takes a picture takes a pasted one too (usePasteImage).
  usePasteImage(() => input.current?.parentElement ?? null, { enabled: !busy, onFiles: ([f]) => f && onFile(f), accept });
  return (
    <>
      <button type="button" disabled={busy} onClick={() => input.current?.click()} className="inline-flex items-center gap-2 rounded border border-line dark:border-slate-600 hover:border-accent text-content dark:text-mortar-200 px-3 py-1.5 text-sm transition disabled:opacity-50">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} {label}
      </button>
      <input
        ref={input}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </>
  );
}

function OutcomeButtons({ onPick }: { onPick: (o: "pass" | "fail") => void }) {
  return (
    <div className="flex gap-2 mt-2">
      <button type="button" onClick={() => onPick("pass")} className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent px-3 py-1.5 text-sm">
        <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" /> Came out well
      </button>
      <button type="button" onClick={() => onPick("fail")} className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent px-3 py-1.5 text-sm">
        <XCircle className="w-4 h-4 text-red-600 dark:text-red-400" /> Failed
      </button>
    </div>
  );
}

/** Who or what produced a step, in words: "Slicer 2.9.6", "your upload". */
function producedWords(row: MakeStepRecord): string | null {
  const p = row.produced_by;
  if (p.kind === "upload") return "Your file";
  if (p.kind === "person") return p.name ?? null;
  if (p.name) return [p.name, p.version].filter(Boolean).join(" ");
  return null;
}

function RecordedStep({ row, detail, onOpenFile, onOutcome }: { row: MakeStepRecord; detail: MakeDetail; onOpenFile: (f: MakeStepRecord["files"][number]) => void; onOutcome: (o: "pass" | "fail" | null) => void }) {
  const failed = row.status === "failed";
  const pending = row.status !== "done" && !failed;
  const by = producedWords(row);
  return (
    <li className="ml-5">
      {failed ? (
        <XCircle className="absolute -left-[9px] w-[18px] h-[18px] text-red-600 dark:text-red-400 bg-surface dark:bg-slate-950" />
      ) : pending ? (
        <Loader2 className="absolute -left-[9px] w-[18px] h-[18px] text-accent animate-spin bg-surface dark:bg-slate-950" />
      ) : (
        <CheckCircle2 className="absolute -left-[9px] w-[18px] h-[18px] text-emerald-600 dark:text-emerald-400 bg-surface dark:bg-slate-950" />
      )}
      <div className="rounded border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-2">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-sm font-semibold text-content dark:text-mortar-100">{STEP_TITLE[row.step]}</span>
          {pending && <span className="text-xs text-muted">{statusWords(row.status)}</span>}
          {by && <span className="text-[11px] text-faint">{by}</span>}
          {row.copied_from && <span className="text-[11px] text-faint">kept from the first make</span>}
        </div>
        {row.error && <p className="text-sm text-red-700 dark:text-red-400 mb-1">{row.error}</p>}
        <StepBody row={row} detail={detail} onOutcome={onOutcome} />
        {row.files.length > 0 && (
          <ul className="flex flex-wrap gap-2 mt-2">
            {row.files.map((f) => (
              <li key={f.id}>
                <button type="button" onClick={() => onOpenFile(f)} className="inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent px-2 py-1 text-xs">
                  <FileText className="w-3.5 h-3.5 text-faint" /> {f.filename}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : typeof v === "number" ? String(v) : null);

function StepBody({ row, detail, onOutcome }: { row: MakeStepRecord; detail: MakeDetail; onOutcome: (o: "pass" | "fail" | null) => void }) {
  const d = row.data;
  const { activeSlug } = useActiveOrg();
  switch (row.step) {
    case "request":
      return <><p className="text-sm text-content dark:text-mortar-200 whitespace-pre-wrap">{str(d.prompt) ?? "Started here."}</p>{detail.reach.design && !detail.steps.some((s) => s.step === "design" || s.step === "model") && <DesignMakeDoor makeId={detail.make.id} />}</>;
    case "design": {
      const params = d.parameters && typeof d.parameters === "object" ? Object.entries(d.parameters as Record<string, unknown>) : [];
      return <>{row.service_job_id && <ServiceJobCard slug={activeSlug} jobId={row.service_job_id} capability="design.part" />}{params.length > 0 && <Facts rows={params.map(([k, v]) => [k.replace(/_/g, " "), String(v)])} />}</>;
    }
    case "model": {
      const r = (d.report ?? {}) as Record<string, unknown>;
      const size = Array.isArray(r.size_mm) ? `${(r.size_mm as number[]).join(" × ")} mm` : null;
      const rows: Array<[string, string]> = [];
      if (size) rows.push(["Size", size]);
      if (typeof r.volume_mm3 === "number") rows.push(["Volume", `${Math.round(r.volume_mm3)} mm³`]);
      if (typeof r.watertight === "boolean") rows.push(["Closed solid", r.watertight ? "yes" : "no"]);
      const printable = row.status === "done" && !detail.steps.some((s) => s.step === "slice" || s.step === "print");
      return (
        <>
          {d.source === "uploaded" && rows.length === 0 ? <p className="text-sm text-muted">Brought as a file.</p> : rows.length ? <Facts rows={rows} /> : null}
          {row.files.filter((f) => f.role === "preview").map((f) => <EntityPhoto key={f.file_id} src={api.fileRawUrl(activeSlug, f.file_id, "medium")} alt="Model preview" fit="contain" aspect="4/3" />)}
          {printable && <PrintThisDoor makeId={detail.make.id} what={detail.make.name} quantity={typeof row.data.quantity === "number" ? row.data.quantity : 1} />}
        </>
      );
    }
    case "slice": {
      const rows: Array<[string, string]> = [];
      const chosen = (d.printer ?? null) as { machine?: string | null; reason?: string } | null;
      if (chosen?.machine) rows.push(["For", chosen.machine]);
      if (chosen?.reason) rows.push(["Why", chosen.reason]);
      const slicer = [str(d.slicer), str(d.version)].filter(Boolean).join(" ");
      if (slicer) rows.push(["Slicer", slicer]);
      for (const [label, key] of [["Printer", "printer_model"], ["Quality", "quality"], ["Material", "material"]] as const) {
        const v = str(d[key]);
        if (v) rows.push([label, v]);
      }
      if (typeof d.time_s === "number") rows.push(["Time", minutes(d.time_s)]);
      if (Array.isArray(d.grams_by_tool)) rows.push(["Filament", (d.grams_by_tool as number[]).map((g, i) => `${g} g${(d.grams_by_tool as number[]).length > 1 ? ` (tool ${i + 1})` : ""}`).join(", ")]);
      const settings = d.settings && typeof d.settings === "object" ? Object.entries(d.settings as Record<string, unknown>) : [];
      const live = !!row.service_job_id && row.status !== "done" && row.status !== "failed";
      return (
        <>
          {live && <ServiceJobCard slug={activeSlug} jobId={row.service_job_id!} capability="slice.model" />}
          {d.source === "uploaded" && rows.length === 0 && <p className="text-sm text-muted">Sliced by you, brought as G-code.</p>}
          {rows.length > 0 && <Facts rows={rows} />}
          {settings.length > 0 && (
            <details className="mt-1">
              <summary className="text-xs text-muted cursor-pointer">All {countOf(settings.length, "setting")}{str(d.profile_hash) ? ` · profile ${str(d.profile_hash)!.slice(0, 16)}` : ""}</summary>
              <Facts rows={settings.map(([k, v]) => [k.replace(/_/g, " "), typeof v === "object" ? JSON.stringify(v) : String(v)])} />
            </details>
          )}
        </>
      );
    }
    case "print": {
      if (row.status === "awaiting_confirm" || row.data.batch) return <PrintConfirmCard makeId={detail.make.id} row={row} />;
      const p = detail.print;
      if (!p) return null;
      const rows: Array<[string, string]> = [];
      if (p.machine) rows.push(["Printer", p.machine.title ?? "a printer"]);
      rows.push(["State", p.status + (p.progress != null && p.status === "printing" ? ` · ${Math.round(Number(p.progress) * 100)}%` : "")]);
      if (p.material_pending) rows.push(["Filament accounting", "Pending. Stock use will be retried automatically."]);
      for (const s of p.spools) rows.push([s.slot ? `Spool, slot ${s.slot}` : "Spool", `${s.title ?? "a spool"}${s.grams ? ` · ${s.grams} g${p.grams_measured ? "" : " (the slicer's estimate)"}` : ""}`]);
      return (
        <>
          <Facts rows={rows} />
          {p.machine?.detail_url && (
            <Link to={p.machine.detail_url} className="text-xs text-accent hover:underline">
              Open the printer
            </Link>
          )}
        </>
      );
    }
    case "outcome": {
      const o = d.outcome;
      return (
        <div className="text-sm">
          <span className={o === "pass" ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}>{o === "pass" ? "Came out well" : "Failed"}</span>
          {d.source === "bed-check" && <span className="text-xs text-faint"> · from the bed check</span>}
          {str(d.notes) && <p className="text-muted mt-1 whitespace-pre-wrap">{str(d.notes)}</p>}
          <button type="button" onClick={() => onOutcome(o === "pass" ? "fail" : "pass")} className="ml-2 text-xs text-muted hover:text-accent underline decoration-dotted underline-offset-2">
            {o === "pass" ? "It failed after all" : "It came out well after all"}
          </button>
        </div>
      );
    }
  }
}

/** "Print this" on a Make that has its model and nothing after it yet. */
function PrintThisDoor({ makeId, what, quantity }: { makeId: string; what: string; quantity: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="mt-2 inline-flex items-center gap-1.5 rounded border border-line dark:border-slate-600 hover:border-accent px-3 py-1.5 text-sm">
        Print this
      </button>
      {open && <PrintThisDialog makeId={makeId} what={what} initialQuantity={quantity} onClose={() => setOpen(false)} />}
    </>
  );
}

function minutes(s: number): string {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function Facts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="text-content dark:text-mortar-200 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── making it again from a step ─────────────────────────────────────────────

function RerunModal({ make, onClose }: { make: MakeDetail; onClose: () => void }) {
  const { activeSlug } = useActiveOrg();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  // A step this Make reached, after its start: the ones before it are kept,
  // this one and the rest run again. The server holds the same rule.
  const choices = useMemo(() => {
    const start = MAKE_STEPS.indexOf(make.make.start_step);
    const reached = new Set(make.steps.map((s) => s.step));
    return (["design", "model", "slice", "print"] as const).filter((s) => MAKE_STEPS.indexOf(s) > start && reached.has(s));
  }, [make.make.start_step, make.steps]);
  const failed = make.timeline.end?.reason === "failed" ? make.timeline.end.step : null;
  const [from, setFrom] = useState<(typeof choices)[number] | undefined>(
    (failed && (choices as readonly string[]).includes(failed) ? failed : choices[choices.length - 1]) as (typeof choices)[number] | undefined,
  );
  const [name, setName] = useState(`${make.make.name} again`);
  const run = useMutation({
    mutationFn: () => api.createMake(activeSlug, { name: name.trim() || make.make.name, rerun_of: make.make.id, from_step: from! }),
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: makeKeys.all(activeSlug) });
      onClose();
      navigate(`/makes/${m.id}`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : (err as Error).message),
  });
  return (
    <RecordFormModal open onClose={onClose} title="Make again">
      {choices.length === 0 ? (
        <p className="text-sm text-muted">Nothing after the first step has happened yet, so there is nothing to make again. Start a new make instead.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">The steps before the one you pick are kept as they are, with their files. That step and the ones after it run again.</p>
          <div className="flex flex-wrap gap-2">
            {choices.map((s) => (
              <button key={s} type="button" onClick={() => setFrom(s)} className={"px-3 py-1.5 text-sm rounded border " + (from === s ? "border-accent bg-subtle" : "border-line dark:border-slate-600")}>
                From {STEP_TITLE[s].toLowerCase()}
              </button>
            ))}
          </div>
          <label className="block text-sm">
            <span className="text-muted">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 w-full rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5" />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm rounded text-content hover:bg-subtle dark:hover:bg-slate-800">
              Cancel
            </button>
            <button type="button" disabled={!from || run.isPending} onClick={() => run.mutate()} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white">
              <Sparkles className="w-4 h-4" /> Make again
            </button>
          </div>
        </div>
      )}
    </RecordFormModal>
  );
}
