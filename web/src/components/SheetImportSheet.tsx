// Bring your spreadsheet: drop a file or paste a Google Sheets link, see
// exactly what would happen (nothing is written until Import), change where
// things go, import as one run, and undo it. Backend: core-import's /sheets
// routes; the plan the server makes is the only source of what happens.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Upload, Link2, Loader2, CheckCircle2, AlertTriangle, ArrowRight, Undo2, FileSpreadsheet, EyeOff, Eye } from "lucide-react";
import { Modal, downloadBlob, useToast } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import {
  ACCEPTED_SHEETS,
  destinationChoices,
  destinationKey,
  destinationLabel,
  fileToBase64,
  isFinished,
  looksLikeSheetsLink,
  ownershipLine,
  showFigure,
  showValue,
  skipReason,
  targetChoiceLabel,
  type Destination,
  type ImportRun,
  type RecordPlan,
  type SheetOverride,
  type SheetPlanView,
  type SheetsPlan,
  type SheetsSource,
  type SummaryCheck,
  type UndoReport,
  type ImportRunSheet,
  issuesCsv,
} from "../lib/sheet-import";
import { DISPOSITION_LABELS } from "@cobblr/platform-contract/disposition";

const SHOWN_ROWS = 12;

export function SheetImportSheet({ open, onClose, runId }: { open: boolean; onClose: () => void; runId?: string | null }) {
  const { activeSlug: slug } = useActiveOrg();
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [source, setSource] = useState<SheetsSource | null>(null);
  const [link, setLink] = useState("");
  const [plan, setPlan] = useState<SheetsPlan | null>(null);
  const [overrides, setOverrides] = useState<Record<string, SheetOverride>>({});
  const [busy, setBusy] = useState<"reading" | "planning" | "importing" | "undoing" | null>(null);
  const [run, setRun] = useState<ImportRun | null>(null);
  const [undo, setUndo] = useState<UndoReport | null>(null);
  const [dragging, setDragging] = useState(false);

  // Opened on a past run (from the list of imports or the activity feed).
  useEffect(() => {
    if (!open || !runId || !slug) return;
    void api.sheetsImportRun(slug, runId).then(setRun).catch(() => undefined);
  }, [open, runId, slug]);

  // A running import is watched until it finishes.
  const polling = run && !isFinished(run.status);
  useEffect(() => {
    if (!polling || !slug || !run) return;
    const t = setInterval(() => {
      void api.sheetsImportRun(slug, run.id).then((r) => {
        setRun(r);
        if (isFinished(r.status)) void qc.invalidateQueries();
      });
    }, 1000);
    return () => clearInterval(t);
  }, [polling, slug, run, qc]);

  function reset() {
    setSource(null);
    setLink("");
    setPlan(null);
    setOverrides({});
    setRun(null);
    setUndo(null);
    setBusy(null);
  }
  function close() {
    reset();
    onClose();
  }

  async function replan(src: SheetsSource, ov: Record<string, SheetOverride>) {
    if (!slug) return;
    setBusy("planning");
    try {
      setPlan(await api.sheetsPlan(slug, { source: src, overrides: ov }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't read that spreadsheet");
      if (!plan) setSource(null);
    } finally {
      setBusy(null);
    }
  }

  async function pickFile(file: File) {
    setBusy("reading");
    const src = { file_b64: await fileToBase64(file), filename: file.name };
    setSource(src);
    setOverrides({});
    await replan(src, {});
  }

  async function readLink() {
    const src = { url: link.trim() };
    setSource(src);
    setOverrides({});
    await replan(src, {});
  }

  function change(sheet: string, patch: SheetOverride) {
    if (!source) return;
    const next = { ...overrides, [sheet]: { ...overrides[sheet], ...patch } };
    setOverrides(next);
    void replan(source, next);
  }

  async function doImport() {
    if (!slug || !source) return;
    setBusy("importing");
    try {
      const started = await api.sheetsImport(slug, { source, overrides });
      setRun(await api.sheetsImportRun(slug, started.run_id));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The import could not start");
    } finally {
      setBusy(null);
    }
  }

  async function doUndo(force: boolean) {
    if (!slug || !run) return;
    setBusy("undoing");
    try {
      const report = await api.sheetsImportUndo(slug, run.id, force);
      setUndo(report);
      setRun(await api.sheetsImportRun(slug, run.id));
      void qc.invalidateQueries();
      if (report.status === "undone") toast.success("The import is undone.");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Undo failed");
    } finally {
      setBusy(null);
    }
  }

  const included = plan?.sheets.filter((s) => s.include) ?? [];
  const total = included.reduce((n, s) => n + s.counts.create + s.counts.update, 0);
  const needsAdmin = included.flatMap((s) => s.needs_admin);
  const blocked = needsAdmin.length > 0 && plan && !["owner", "admin"].includes(plan.your_role);

  const footer =
    plan && !run ? (
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void doImport()}
          disabled={busy !== null || total === 0 || !!blocked}
          className="inline-flex items-center gap-2 rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white text-sm px-3.5 py-2 disabled:opacity-50"
        >
          {busy === "importing" ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
          {total === 0 ? "Nothing to import" : `Import ${total} ${total === 1 ? "record" : "records"}`}
        </button>
        <span className="text-xs text-muted dark:text-slate-400">You can undo the whole import afterwards.</span>
      </div>
    ) : undefined;

  return (
    <Modal
      open={open}
      onClose={close}
      title="Bring your spreadsheet"
      subtitle={run ? (run.filename ?? "Your import") : "See exactly what happens before anything changes"}
      size="xl"
      footer={footer}
    >
      <div className="space-y-4">
        {!plan && !run && (
          <PickStep
            dragging={dragging}
            setDragging={setDragging}
            busy={busy}
            fileRef={fileRef}
            link={link}
            setLink={setLink}
            onFile={(f) => void pickFile(f)}
            onLink={() => void readLink()}
          />
        )}

        {plan && !run && (
          <>
            <div className="flex items-center gap-2 text-sm text-muted dark:text-slate-400 min-w-0">
              <FileSpreadsheet size={16} className="shrink-0 text-accent" />
              <span className="truncate font-medium text-content dark:text-mortar-100">{plan.filename}</span>
              {busy === "planning" && <Loader2 size={15} className="animate-spin text-accent shrink-0" />}
              <button type="button" onClick={reset} className="ml-auto shrink-0 text-xs text-muted hover:text-content">
                Choose another
              </button>
            </div>
            <p className="text-sm text-muted dark:text-slate-400">Nothing has changed yet. Adjust anything below, then import.</p>
            {plan.sheets.map((s) => (
              <SheetCard key={s.sheet} plan={s} busy={busy !== null} override={overrides[s.sheet] ?? {}} onChange={(p) => change(s.sheet, p)} />
            ))}
            {blocked && (
              <div className="flex items-start gap-2 rounded-lg border border-ember-300/60 dark:border-ember-800/60 bg-ember-50/50 dark:bg-ember-950/20 p-3 text-sm text-content dark:text-mortar-200">
                <AlertTriangle size={16} className="mt-0.5 shrink-0 text-ember-600 dark:text-ember-400" />
                <span>This import {needsAdmin.join(", ")}. An owner or admin can run it, or send each sheet to a collection that has its fields already.</span>
              </div>
            )}
          </>
        )}

        {run && <RunView run={run} undo={undo} busy={busy} onUndo={(force) => void doUndo(force)} onAnother={reset} onLeave={close} />}

        {!plan && !run && <RecentImports onOpen={(r) => setRun(r)} />}
      </div>
    </Modal>
  );
}

function PickStep(props: {
  dragging: boolean;
  setDragging: (b: boolean) => void;
  busy: string | null;
  fileRef: React.RefObject<HTMLInputElement | null>;
  link: string;
  setLink: (s: string) => void;
  onFile: (f: File) => void;
  onLink: () => void;
}) {
  const { dragging, setDragging, busy, fileRef, link, setLink, onFile, onLink } = props;
  return (
    <>
      {/* paste-ok: a spreadsheet door (ACCEPTED_SHEETS); a picture is not a sheet */}
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPTED_SHEETS}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        disabled={busy !== null}
        className={`w-full rounded-xl border-2 border-dashed p-6 text-center transition ${
          dragging ? "border-accent bg-accent/5" : "border-line dark:border-slate-700 hover:border-cobble-400"
        }`}
      >
        {busy ? <Loader2 size={24} className="mx-auto animate-spin text-accent" /> : <Upload size={24} className="mx-auto text-accent" />}
        <div className="mt-2 font-medium text-content dark:text-mortar-100">{busy ? "Reading your spreadsheet…" : "Drop a spreadsheet, or choose one"}</div>
        <div className="mt-1 text-xs text-muted dark:text-slate-400">Excel, LibreOffice, Numbers export, CSV or TSV. Every tab is read.</div>
      </button>
      <div className="flex flex-col gap-2 sm:flex-row">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-2">
          <Link2 size={15} className="shrink-0 text-faint" />
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="Or paste a Google Sheets link"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            inputMode="url"
          />
        </label>
        <button
          type="button"
          onClick={onLink}
          disabled={busy !== null || !looksLikeSheetsLink(link)}
          className="rounded-lg border border-line dark:border-slate-700 px-3.5 py-2 text-sm hover:border-cobble-400 disabled:opacity-50"
        >
          Read the sheet
        </button>
      </div>
      <p className="text-xs text-muted dark:text-slate-400">
        A Google Sheet needs its sharing set to anyone with the link can view. Cobblr reads the sheet, shows you where everything would go, and changes nothing until you press Import.
      </p>
    </>
  );
}

function SheetCard({ plan, busy, override, onChange }: { plan: SheetPlanView; busy: boolean; override: SheetOverride; onChange: (p: SheetOverride) => void }) {
  const [showAll, setShowAll] = useState(false);
  const target = plan.target;
  const leftOut = new Set(override.skip_rows ?? []);
  const rows = showAll ? plan.records : plan.records.slice(0, SHOWN_ROWS);
  const adds = [
    plan.install && `adds the ${plan.install.label} collection`,
    plan.enable && `turns on ${plan.enable.label}`,
    plan.new_collection && `makes a new collection, ${plan.new_collection.label}`,
    plan.fields_to_create.length && `adds ${plan.fields_to_create.length} new ${plan.fields_to_create.length === 1 ? "field" : "fields"}`,
    plan.locations_to_create.length && `adds ${plan.locations_to_create.length} new ${plan.locations_to_create.length === 1 ? "place" : "places"}`,
    plan.categories_to_create.length && `adds ${plan.categories_to_create.length} new ${plan.categories_to_create.length === 1 ? "category" : "categories"}`,
  ].filter(Boolean) as string[];

  return (
    <section className={`rounded-xl border p-3.5 space-y-3 ${plan.include ? "border-line dark:border-slate-700" : "border-dashed border-line/70 dark:border-slate-800 opacity-70"}`}>
      <header className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={plan.include}
          onChange={(e) => onChange({ include: e.target.checked })}
          disabled={busy}
          className="mt-1 h-4 w-4 shrink-0 accent-cobble-600"
          aria-label={`Import the ${plan.sheet} tab`}
        />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-content dark:text-mortar-100 truncate">{plan.sheet}</div>
          <div className="text-xs text-muted dark:text-slate-400">
            {plan.row_count} {plan.row_count === 1 ? "row" : "rows"}
            {plan.counts.create > 0 && ` · ${plan.counts.create} to add`}
            {plan.counts.update > 0 && ` · ${plan.counts.update} to update`}
            {plan.counts.unchanged > 0 && ` · ${plan.counts.unchanged} already there`}
          </div>
        </div>
      </header>

      {plan.include && (
        <>
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-muted dark:text-slate-400">Goes to</label>
            <select
              value={target.id}
              onChange={(e) => onChange({ target: e.target.value })}
              disabled={busy}
              className="w-full rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2.5 py-2 text-sm"
            >
              <option value={target.id}>{targetChoiceLabel(target)}</option>
              {plan.alternatives.map((a) => (
                <option key={a.id} value={a.id}>
                  {targetChoiceLabel(a)}
                </option>
              ))}
            </select>
            {target.status === "new" && (
              <input
                // DRAFT-OK: a name typed for a collection that does not exist yet; it goes to the server on blur, and the key remounts it on the plan's answer
                key={target.label}
                defaultValue={target.label}
                onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== target.label && onChange({ collection_label: e.target.value.trim() })}
                disabled={busy}
                aria-label="Name the new collection"
                className="w-full rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2.5 py-2 text-sm"
              />
            )}
            {plan.why_target && <p className="text-xs text-muted dark:text-slate-400">Why: {plan.why_target}.</p>}
            {adds.length > 0 && <p className="text-xs text-content dark:text-mortar-200">This {adds.join(", ")}.</p>}
          </div>

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted dark:text-slate-400">Every column, and where it goes</div>
            {plan.headerless && (
              <p className="text-xs text-content dark:text-mortar-200">This sheet has no header row, so its first row is a record too, and the columns are named from what they hold.</p>
            )}
            {plan.header_row !== null && plan.skipped.every((k) => k.reason !== "title") && plan.records.some((r) => r.row < plan.header_row!) && (
              <p className="text-xs text-content dark:text-mortar-200" data-testid="header-below">
                The header is row {plan.header_row}, under the data, so every row above it comes in.
              </p>
            )}
            <ul className="divide-y divide-line/70 dark:divide-slate-800 rounded-lg border border-line dark:border-slate-700">
              {plan.columns.map((c) => {
                const choices = destinationChoices(target, c);
                return (
                  <li key={c.column} className="flex flex-col gap-1.5 p-2.5 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-content dark:text-mortar-100 truncate">
                        {c.header}
                        {c.named_by && (
                          <span className="ml-1.5 text-[11px] font-normal text-muted dark:text-slate-400">
                            {c.named_by === "ai" ? "named by AI from the first rows" : "named from its values"}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted dark:text-slate-400 truncate">{c.samples.slice(0, 2).join(" · ") || "no values"}</div>
                      {c.misfits > 0 && <div className="text-xs text-ember-600 dark:text-ember-400">{c.misfits} kept as written: they don't fit {destinationLabel(c.dest, target)}.</div>}
                    </div>
                    <select
                      value={destinationKey(c.dest)}
                      onChange={(e) => {
                        const d = choices.find((x) => x.key === e.target.value)?.dest as Destination;
                        onChange({ columns: { ...(override.columns ?? {}), [String(c.column)]: d } });
                      }}
                      disabled={busy}
                      className="w-full rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm sm:w-72"
                      aria-label={`Where ${c.header} goes`}
                    >
                      {choices.map((x) => (
                        <option key={x.key} value={x.key}>
                          {x.label}
                        </option>
                      ))}
                    </select>
                  </li>
                );
              })}
            </ul>
          </div>

          {plan.ownership && (
            <div className="space-y-1.5 rounded-lg border border-line dark:border-slate-700 p-2.5" data-testid="ownership">
              <p className="text-sm text-content dark:text-mortar-100">{ownershipLine(plan.ownership)}.</p>
              <p className="text-xs text-muted dark:text-slate-400">
                {target.retires
                  ? `The ones no longer yours come in marked that way in ${target.label}, with what became of them kept beside it.`
                  : `${target.label} has no way to mark things as gone, so what became of them is kept as written.`}
              </p>
              {plan.ownership.gone > 0 && (
                <label className="flex items-center gap-2 text-sm text-content dark:text-mortar-200">
                  <input
                    type="checkbox"
                    checked={!!override.only_owned}
                    onChange={(e) => onChange({ only_owned: e.target.checked })}
                    disabled={busy}
                    className="h-4 w-4 accent-cobble-600"
                  />
                  Import only what you still have
                </label>
              )}
            </div>
          )}

          {(plan.groups.length > 0 || override.keep_identical_apart) && (
            <div className="space-y-1.5 rounded-lg border border-line dark:border-slate-700 p-2.5" data-testid="identical-rows">
              {plan.groups.map((g) => (
                <p key={g.rows[0]} className="text-sm text-content dark:text-mortar-100">
                  {g.rows.length} identical {g.name} (rows {g.rows[0]} to {g.rows[g.rows.length - 1]}) become one record of {g.rows.length}.
                </p>
              ))}
              <label className="flex items-center gap-2 text-sm text-content dark:text-mortar-200">
                <input
                  type="checkbox"
                  checked={!!override.keep_identical_apart}
                  onChange={(e) => onChange({ keep_identical_apart: e.target.checked })}
                  disabled={busy}
                  className="h-4 w-4 accent-cobble-600"
                />
                Keep identical rows as a record each
              </label>
            </div>
          )}

          {plan.summary.length > 0 && <SummaryChecks checks={plan.summary} />}

          <div className="space-y-1.5">
            <div className="text-xs font-medium text-muted dark:text-slate-400">What each row becomes</div>
            <ul className="space-y-1.5">
              {rows.map((r) => (
                <RowCard
                  key={r.row}
                  record={r}
                  onLeaveOut={() => onChange({ skip_rows: [...(override.skip_rows ?? []), r.row] })}
                  disabled={busy}
                />
              ))}
            </ul>
            {plan.records.length > SHOWN_ROWS && (
              <button type="button" onClick={() => setShowAll(!showAll)} className="text-xs text-accent hover:underline">
                {showAll ? "Show fewer" : `Show all ${plan.records.length}`}
              </button>
            )}
            {plan.records_shown === "some" && (
              <p className="text-xs text-muted dark:text-slate-400">The rest of the sheet comes in the same way.</p>
            )}
          </div>

          {plan.skipped.filter((k) => k.reason !== "blank").length > 0 && (
            <details className="text-xs text-muted dark:text-slate-400">
              <summary className="cursor-pointer">
                {plan.skipped.filter((k) => k.reason !== "blank").length === 1
                  ? "1 line of the sheet is left out"
                  : `${plan.skipped.filter((k) => k.reason !== "blank").length} lines of the sheet are left out`}
              </summary>
              <ul className="mt-1.5 space-y-1">
                {plan.skipped
                  .filter((k) => k.reason !== "blank")
                  .map((k) => (
                    <li key={`${k.reason}-${k.row}`} className="flex items-center gap-2">
                      <span>
                        Row {k.row}
                        {k.text ? `, "${k.text}"` : ""}: {skipReason(k.reason)}
                      </span>
                      {k.reason === "excluded" && (
                        <button
                          type="button"
                          onClick={() => onChange({ skip_rows: (override.skip_rows ?? []).filter((n) => n !== k.row) })}
                          className="inline-flex items-center gap-1 text-accent hover:underline"
                        >
                          <Eye size={12} /> Bring back
                        </button>
                      )}
                    </li>
                  ))}
              </ul>
            </details>
          )}
          {leftOut.size > 0 && <p className="text-xs text-muted dark:text-slate-400">{leftOut.size} left out by you.</p>}
        </>
      )}
    </section>
  );
}

/** The sheet's own totals beside what this import comes to. */
function SummaryChecks({ checks }: { checks: SummaryCheck[] }) {
  return (
    <div className="space-y-1.5 rounded-lg border border-line dark:border-slate-700 p-2.5" data-testid="summary-checks">
      <div className="text-xs font-medium text-muted dark:text-slate-400">Your sheet's own totals, checked against this import</div>
      <ul className="space-y-1">
        {checks.map((c) => (
          <li key={`${c.row}-${c.label}`} className="flex items-start gap-2 text-sm">
            {c.agrees === true ? (
              <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="agrees" />
            ) : c.agrees === false ? (
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-ember-600 dark:text-ember-400" aria-label="does not agree" />
            ) : (
              <span className="mt-0.5 w-[15px] shrink-0" />
            )}
            <span className="min-w-0 text-content dark:text-mortar-200">
              {c.label} {showFigure(c.value, c)}
              <span className="block text-xs text-muted dark:text-slate-400">
                {c.computed === null
                  ? `Not checked: ${c.basis}.`
                  : c.agrees
                    ? `The import agrees: ${showFigure(c.computed, c)}, ${c.basis}.`
                    : `The import comes to ${showFigure(c.computed, c)}, ${c.basis}.`}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted dark:text-slate-400">These rows are not imported as things. They stay with this import, so you can check them again under your imports.</p>
    </div>
  );
}

function RowCard({ record, onLeaveOut, disabled }: { record: RecordPlan; onLeaveOut: () => void; disabled: boolean }) {
  const facts = useMemo(() => {
    const out: string[] = [];
    if (record.qty != null) out.push(`${record.qty}${record.unit ? ` ${record.unit}` : ""}`);
    if (record.location_path) out.push(record.location_path.join(" / "));
    if (record.category) out.push(record.category);
    // What became of it has its own line below; its words and price are not
    // said twice.
    const said = new Set(record.disposition ? [record.disposition.text, ...(record.disposition.price !== null ? [String(record.disposition.price)] : [])] : []);
    for (const v of Object.values(record.fields)) {
      const t = showValue(v);
      if (t && !said.has(t) && out.length < 5) out.push(t);
    }
    return out.slice(0, 5);
  }, [record]);
  const chip =
    record.action === "create"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
      : record.action === "update"
        ? "bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
        : "bg-subtle text-muted dark:bg-slate-800 dark:text-slate-400";
  return (
    <li className="rounded-lg border border-line dark:border-slate-700 p-2.5">
      <div className="flex items-start gap-2">
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${chip}`}>
          {record.action === "create" ? "New" : record.action === "update" ? "Update" : "Same"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm text-content dark:text-mortar-100 truncate">
            {record.name}
            {record.rows && <span className="ml-1.5 text-xs text-muted dark:text-slate-400">×{record.rows.length}, rows {record.rows[0]} to {record.rows[record.rows.length - 1]}</span>}
          </div>
          {record.disposition && (
            <div className="text-xs text-content dark:text-mortar-200">
              No longer yours: {DISPOSITION_LABELS[record.disposition.kind]}
              {record.disposition.text.toLowerCase() !== DISPOSITION_LABELS[record.disposition.kind] ? ` ("${record.disposition.text}")` : ""}
            </div>
          )}
          {facts.length > 0 && <div className="text-xs text-muted dark:text-slate-400 truncate">{facts.join(" · ")}</div>}
          {record.changes?.map((c) => (
            <div key={c.field} className="text-xs text-content dark:text-mortar-200">
              {c.field}: {showValue(c.from) || "empty"} → {showValue(c.to) || "empty"}
            </div>
          ))}
          {record.problems.map((p) => (
            <div key={p} className="text-xs text-ember-600 dark:text-ember-400">
              {p}
            </div>
          ))}
        </div>
        <button type="button" onClick={onLeaveOut} disabled={disabled} className="shrink-0 text-faint hover:text-content" title="Leave this row out" aria-label={`Leave ${record.name} out`}>
          <EyeOff size={14} />
        </button>
      </div>
    </li>
  );
}

function RunView({
  run,
  undo,
  busy,
  onUndo,
  onAnother,
  onLeave,
}: {
  run: ImportRun;
  undo: UndoReport | null;
  busy: string | null;
  onUndo: (force: boolean) => void;
  onAnother: () => void;
  onLeave: () => void;
}) {
  const sheets = run.summary.sheets ?? [];
  const pct = run.progress_total ? Math.round((100 * run.progress_done) / run.progress_total) : 0;
  const held = undo?.held ?? run.undo_report?.held ?? [];
  if (!isFinished(run.status)) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-content dark:text-mortar-200">
          <Loader2 size={16} className="animate-spin text-accent" />
          {run.status === "undoing" ? "Undoing…" : `Importing ${run.progress_done} of ${run.progress_total}…`}
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-subtle dark:bg-slate-800">
          <div className="h-full bg-cobble-600 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-muted dark:text-slate-400">You can close this; the import keeps going and shows up under your imports.</p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 font-medium text-content dark:text-mortar-100">
        {run.status === "failed" ? <AlertTriangle size={18} className="text-ember-600 dark:text-ember-400" /> : run.status === "done" ? <CheckCircle2 size={18} className="text-emerald-600 dark:text-emerald-400" /> : <Undo2 size={18} className="text-muted" />}
        {run.status === "done" ? "Imported" : run.status === "failed" ? "The import stopped" : run.status === "undone" ? "Undone: the workspace is as it was" : "Partly undone"}
      </div>
      {run.error && <p className="text-sm text-ember-600 dark:text-ember-400">{run.error}</p>}
      <ul className="space-y-2">
        {sheets.map((s) => (
          <li key={s.sheet} className="rounded-lg border border-line dark:border-slate-700 p-2.5 text-sm">
            <div className="font-medium text-content dark:text-mortar-100">
              {s.sheet} → {s.label}
            </div>
            <div className="text-xs text-muted dark:text-slate-400">
              {s.created ?? 0} added · {s.updated ?? 0} updated{s.retired ? ` · ${s.retired} marked no longer yours` : ""}{s.failed ? ` · ${s.failed} could not be written` : ""}
            </div>
            {s.checks && s.checks.length > 0 && <SummaryChecks checks={s.checks} />}
            {run.status === "done" && (s.created ?? 0) + (s.updated ?? 0) > 0 && (
              <Link to={collectionRoute(s.kind)} onClick={onLeave} className="mt-1 inline-flex items-center gap-1 text-xs text-accent hover:underline">
                Open {s.label} <ArrowRight size={12} />
              </Link>
            )}
            {s.issues ? <RowsNotAsWritten sheet={s} /> : (s.problems ?? []).slice(0, 5).map((p) => (
              <div key={p} className="text-xs text-ember-600 dark:text-ember-400">
                {p}
              </div>
            ))}
          </li>
        ))}
      </ul>
      {held.length > 0 && (
        <div className="rounded-lg border border-amber-300/60 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-950/20 p-3 text-sm space-y-1.5">
          <div className="text-content dark:text-mortar-200">Left as it is, because it changed after the import:</div>
          <ul className="text-xs text-muted dark:text-slate-400 space-y-0.5">
            {held.slice(0, 12).map((h, i) => (
              <li key={i}>
                {h.label}: {h.why}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => onUndo(true)}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg border border-line dark:border-slate-700 px-3 py-1.5 text-xs hover:border-cobble-400 disabled:opacity-50"
          >
            Undo those too
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {(run.status === "done" || run.status === "failed" || (run.status === "partly-undone" && held.length === 0)) && (
          <button
            type="button"
            onClick={() => onUndo(false)}
            disabled={busy !== null}
            className="inline-flex items-center gap-2 rounded-lg border border-line dark:border-slate-700 px-3.5 py-2 text-sm hover:border-cobble-400 disabled:opacity-50"
          >
            {busy === "undoing" ? <Loader2 size={15} className="animate-spin" /> : <Undo2 size={15} />} Undo this import
          </button>
        )}
        <button type="button" onClick={onAnother} className="text-sm text-muted hover:text-content">
          Import another spreadsheet
        </button>
      </div>
    </div>
  );
}

function RecentImports({ onOpen }: { onOpen: (r: ImportRun) => void }) {
  const { activeSlug: slug } = useActiveOrg();
  const runs = useQuery({ queryKey: ["sheet-imports", slug], queryFn: () => api.sheetsImports(slug!), enabled: !!slug });
  const items = runs.data?.items ?? [];
  if (!items.length) return null;
  return (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted dark:text-slate-400">Your imports</div>
      <ul className="divide-y divide-line/70 dark:divide-slate-800 rounded-lg border border-line dark:border-slate-700">
        {items.slice(0, 8).map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onOpen(r)} className="flex w-full items-center gap-2 p-2.5 text-left text-sm hover:bg-subtle/50 dark:hover:bg-slate-800/50">
              <FileSpreadsheet size={15} className="shrink-0 text-faint" />
              <span className="min-w-0 flex-1 truncate text-content dark:text-mortar-200">{r.filename ?? "Spreadsheet"}</span>
              <span className="shrink-0 text-xs text-muted dark:text-slate-400">{runStatusWord(r)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Where a collection's list lives: a named collection by its instance, a
 *  module's own table by the module. */
function collectionRoute(kind: string): string {
  const [head, tail] = kind.split(":");
  return tail === "item" ? `/instances/${head}` : `/${head}`;
}

function runStatusWord(r: ImportRun): string {
  switch (r.status) {
    case "done":
      return new Date(r.created_at).toLocaleDateString();
    case "undone":
      return "Undone";
    case "partly-undone":
      return "Partly undone";
    case "failed":
      return "Stopped";
    default:
      return "Running";
  }
}

/** The rows of a sheet that did not go in exactly as written: how many, the
 *  first few, and every one of them as a file to fix the spreadsheet from.
 *  The import used to say "60 added" and nothing about the 55 dates it could
 *  not read (the 2026-09 fundamentals audit). */
function RowsNotAsWritten({ sheet }: { sheet: ImportRunSheet }) {
  const count = sheet.issue_count ?? sheet.issues?.length ?? 0;
  if (count === 0) return null;
  const shown = sheet.issues ?? [];
  return (
    <div className="mt-2 rounded-md border border-amber-300/60 dark:border-amber-800/60 bg-amber-50/50 dark:bg-amber-950/20 p-2 space-y-1" data-testid="rows-not-as-written">
      <div className="text-xs font-medium text-content dark:text-mortar-100">
        {count === 1 ? "1 line of your sheet did not go in exactly as written" : `${count} lines of your sheet did not go in exactly as written`}
      </div>
      <ul className="text-xs text-muted dark:text-slate-400 space-y-0.5">
        {shown.slice(0, 3).map((i, n) => (
          <li key={n}>
            Row {i.row} ({i.name}): {i.problem}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => downloadBlob(new Blob([issuesCsv(sheet)], { type: "text/csv" }), `${sheet.sheet} - rows to check.csv`)}
        className="text-xs font-medium text-accent hover:underline"
      >
        Download the list{shown.length < count ? ` (the first ${shown.length})` : ""}
      </button>
    </div>
  );
}

