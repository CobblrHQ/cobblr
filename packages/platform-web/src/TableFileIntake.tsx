// A table's "Import …" door: each dropped file becomes one of its records.
//
// A bundle declares it on a table (`file_intake`; Yarn's Patterns: every PDF is
// a pattern). The files go through the one intake every surface uses
// (<FileIntake>, core-files: plain files or a zip, deduped by their bytes,
// into the table's folder), and the lines it answers are handed to the
// table's file-intake route, which makes the records and attaches the files.
// So a pattern PDF is stored once, sits in the Files page's Patterns folder,
// and is the pattern's own file: two views of the same file, never two copies.
//
// The batch question (`ask`, e.g. Source) is asked once, before the drop, from
// the field's own choices. The report says what became of every file.
//
// An answer can carry a guide the bundle wrote (`guides`): Source: Ribblr
// shows how to get your patterns out of Ribblr, since the person importing
// them is exactly the person who has not yet.
import { useState } from "react";
import type { FileIntakeDecl } from "@cobblr/platform-contract";
import { FileIntake, type IntakeLine } from "./FileIntake";

const TOKEN_KEY = "cobblr.token";

export interface TableFileIntakeResult {
  created: number;
  existing: number;
  skipped: number;
  failed: number;
  results: Array<{ filename: string; path: string; outcome: "created" | "existing" | "skipped" | "failed"; record_id?: string; title?: string; reason?: string }>;
}

/** The field the batch question reads its words and choices from. */
export interface AskField {
  name: string;
  display_label: string;
  choices?: string[] | null;
}

/** "3 patterns made, 1 already here." The one sentence a batch ends with. */
export function intakeSummary(r: Pick<TableFileIntakeResult, "created" | "existing" | "skipped" | "failed">, noun: string, plural: string): string {
  const parts: string[] = [];
  if (r.created) parts.push(`${r.created} ${r.created === 1 ? noun : plural} made`);
  if (r.existing) parts.push(`${r.existing} already here`);
  if (r.skipped) parts.push(`${r.skipped} not ${r.skipped === 1 ? `a ${noun}` : plural}`);
  if (r.failed) parts.push(`${r.failed} could not be made`);
  if (!parts.length) return `No ${plural} in that.`;
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

export function TableFileIntake({
  orgSlug,
  instance,
  decl,
  askFields,
  noun,
  plural,
  getToken,
  onDone,
}: {
  orgSlug: string;
  instance: string;
  decl: FileIntakeDecl;
  /** Field definitions for `decl.ask`, for the batch question's words. */
  askFields: AskField[];
  noun: string;
  plural: string;
  getToken?: () => string | null | undefined;
  onDone?: (r: TableFileIntakeResult) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  // A drop can answer in more than one batch (loose files, then a zip), so
  // the report adds up until it is dismissed rather than showing the last one.
  const [tally, setTally] = useState<{ created: number; existing: number; skipped: number; failed: number; lines: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = () => (getToken ? getToken() : (() => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  })());
  const asked = (decl.ask ?? []).map((n) => askFields.find((f) => f.name === n)).filter((f): f is AskField => !!f);
  const guides = (decl.guides ?? []).filter((g) => values[g.when.field] === g.when.equals);

  async function makeRecords(lines: IntakeLine[]) {
    const t = token();
    const res = await fetch(`/api/v1/orgs/${encodeURIComponent(orgSlug)}/instances/${encodeURIComponent(instance)}/file-intake`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) },
      body: JSON.stringify({ lines, values }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      setError(err?.error?.message ?? `The files are in Files, but no ${plural} were made (HTTP ${res.status}).`);
      return;
    }
    const r = (await res.json()) as TableFileIntakeResult;
    const failed = r.results.filter((x) => x.outcome === "failed").map((x) => `${x.path}: ${x.reason ?? "could not be made"}`);
    setTally((t) => ({
      created: (t?.created ?? 0) + r.created,
      existing: (t?.existing ?? 0) + r.existing,
      skipped: (t?.skipped ?? 0) + r.skipped,
      failed: (t?.failed ?? 0) + r.failed,
      lines: [...(t?.lines ?? []), ...failed],
    }));
    onDone?.(r);
  }

  return (
    <div className="space-y-2" data-testid="table-file-intake">
      <div className="flex flex-wrap items-center gap-2">
        {asked.map((f) => (
          <label key={f.name} className="flex items-center gap-1.5 text-sm text-muted">
            {f.display_label}
            {f.choices?.length ? (
              <select
                value={values[f.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                className="input !py-1 !text-sm"
                aria-label={f.display_label}
              >
                <option value="">(not set)</option>
                {f.choices.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={values[f.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                className="input !py-1 !text-sm !w-40"
                aria-label={f.display_label}
              />
            )}
          </label>
        ))}
        <FileIntake
          orgSlug={orgSlug}
          getToken={getToken}
          folderPath={decl.folder ?? null}
          label={decl.label ?? `Import ${plural}`}
          accept={[...decl.accept, ".zip", "application/zip"].join(",")}
          where={decl.folder ? `in ${decl.folder}` : undefined}
          onResults={(lines) => void makeRecords(lines)}
        />
      </div>
      {guides.map((g) => (
        <details
          key={`${g.when.field}:${g.when.equals}`}
          open
          className="rounded border border-line dark:border-slate-700 bg-subtle/40 dark:bg-slate-800/40 px-3 py-2 text-sm"
          data-testid="table-file-intake-guide"
        >
          <summary className="cursor-pointer font-medium text-content dark:text-mortar-100">{g.title}</summary>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-content dark:text-mortar-200">
            {g.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </details>
      ))}
      {(tally || error) && (
        <div role="status" className="rounded border border-line dark:border-slate-700 px-3 py-2 text-sm" data-testid="table-file-intake-summary">
          <div className="flex items-start gap-2">
            <span className="flex-1 font-medium text-content dark:text-mortar-100">{error ?? (tally ? intakeSummary(tally, noun, plural) : "")}</span>
            <button
              type="button"
              onClick={() => {
                setTally(null);
                setError(null);
              }}
              className="text-xs text-muted hover:text-accent"
            >
              Dismiss
            </button>
          </div>
          {tally?.lines.map((l) => (
            <div key={l} className="text-xs text-muted">
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
