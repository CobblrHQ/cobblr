// Taking files in from the browser: the one drop zone for every surface
// that accepts files into core-files (the Files page, a Patterns page), so
// "already here", a zip's folders and a batch's report read the same
// everywhere. It speaks to core-files' two doors, POST /files and
// POST /files/import-zip, which share one intake on the server.
//
// A batch shows "Uploading 3 of 38…" and ends with one report, a line per
// file that needs a word, never a toast per file. A zip asks what it is: a
// folder of files to unpack (its tree kept, under the folder you are in),
// or one file to keep.

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useToast } from "./ToastContext";
import { sendUpload, uploadErrorOf } from "./upload-client";

const TOKEN_KEY = "cobblr.token";

/** What happened to one file. A duplicate carries the file already holding
 *  those bytes, so a caller can link to it rather than skip it. */
export interface IntakeLine {
  /** "Blankets/granny.pdf" inside a zip; the filename for a plain upload. */
  path: string;
  filename: string;
  status: "stored" | "duplicate" | "too_big" | "failed";
  file_id?: string;
  folder_id?: string | null;
  mime_type?: string;
  bytes?: number;
  reason?: string;
  /** For a duplicate: the name the existing copy goes by. */
  existing_filename?: string;
  /** For a duplicate: the folders the existing copy sits in, top first
   *  ([] at the top level), from the server, which knows a folder a zip
   *  made a moment ago when the page's own folder list does not. */
  existing_folder?: string[];
}

export interface FileIntakeOptions {
  orgSlug: string;
  /** The folder files land in; null or absent is the top level. */
  folderId?: string | null;
  /** A path under it, made where missing ("Patterns/Blankets"). */
  folderPath?: string | null;
  getToken?: () => string | null | undefined;
  /** Called once per batch or zip with every file's line. */
  onResults?: (lines: IntakeLine[]) => void;
}

const isZip = (f: File) => /\.zip$/i.test(f.name) || f.type === "application/zip" || f.type === "application/x-zip-compressed";
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export function describeLine(l: IntakeLine): string | null {
  switch (l.status) {
    case "stored":
      return null;
    case "duplicate": {
      const existing = l.existing_filename ?? l.filename;
      const as = existing === (l.path.split("/").pop() ?? l.path) ? "" : ` as ${existing}`;
      const where = l.existing_folder ? `, ${l.existing_folder.length ? `in ${l.existing_folder.join(" / ")}` : "at the top level"}` : "";
      return `${l.path}: already here${as}${where}. Kept the one copy.`;
    }
    case "too_big":
      // The server's own sentence names this file's size and its limit, for a
      // single upload and a zip's entry alike.
      return l.reason ? `${l.path}: ${l.reason} Not imported.` : `${l.path}: ${mb(l.bytes ?? 0)}, over the most a file can be. Not imported.`;
    case "failed":
      return `${l.path}: not imported. ${l.reason ?? ""}`.trim();
  }
}

export function useFileIntake(opts: FileIntakeOptions) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);
  const [zips, setZips] = useState<File[] | null>(null);
  const [report, setReport] = useState<{ title: string; lines: string[] } | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const post = useCallback(async (path: string, file: File): Promise<Response> => {
    const o = optsRef.current;
    const form = new FormData();
    if (o.folderId) form.set("folder_id", o.folderId);
    if (o.folderPath) form.set("folder_path", o.folderPath);
    if (path === "") form.set("on_duplicate", "skip");
    form.set("file", file);
    const token = o.getToken ? o.getToken() : typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : null;
    return sendUpload(`/api/v1/orgs/${o.orgSlug}/modules/core-files/files${path}`, form, { token, file });
  }, []);


  const finish = useCallback(
    (title: string, lines: IntakeLine[], quietSingle: boolean) => {
      const o = optsRef.current;
      o.onResults?.(lines);
      const words = lines.map((l) => describeLine(l)).filter((w): w is string => !!w);
      if (quietSingle && lines.length === 1) {
        const l = lines[0]!;
        if (l.status === "stored") toast.success(`Uploaded ${l.filename}`);
        else if (l.status === "duplicate") toast.info(words[0]!.replace(`${l.path}: `, `${l.filename} is `));
        else toast.error(words[0]!);
        return;
      }
      setReport({ title, lines: words });
    },
    [toast],
  );

  /** Plain files, one request each (the server keeps one copy of the same bytes). */
  const upload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setBusy(true);
      const lines: IntakeLine[] = [];
      for (const [i, f] of files.entries()) {
        setProgress({ done: i, of: files.length });
        try {
          const res = await post("", f);
          if (!res.ok) {
            // A full workspace is a 413 too, and says so in its own words;
            // only the per-file ceiling is "too big".
            const e = await uploadErrorOf(res, f);
            const tooBig = e.code === "file_too_large" || (res.status === 413 && e.code !== "storage_full");
            lines.push({ path: f.name, filename: f.name, status: tooBig ? "too_big" : "failed", bytes: f.size, reason: e.message });
            continue;
          }
          const r = (await res.json()) as { id: string; filename: string; folder_id?: string | null; mime_type?: string; duplicate?: boolean; duplicate_of?: { folder_names?: string[] } | null };
          lines.push({ path: f.name, filename: r.filename, status: r.duplicate ? "duplicate" : "stored", file_id: r.id, folder_id: r.folder_id ?? null, mime_type: r.mime_type, existing_filename: r.duplicate ? r.filename : undefined, existing_folder: r.duplicate ? r.duplicate_of?.folder_names : undefined });
        } catch (err) {
          lines.push({ path: f.name, filename: f.name, status: "failed", reason: (err as Error).message });
        }
      }
      setProgress(null);
      setBusy(false);
      finish(`${lines.filter((l) => l.status === "stored").length} of ${files.length} uploaded`, lines, true);
    },
    [post, finish],
  );

  /** Each zip unpacked into folders under the target. */
  const unpack = useCallback(
    async (files: File[]) => {
      setZips(null);
      setBusy(true);
      const lines: IntakeLine[] = [];
      for (const z of files) {
        try {
          const res = await post("/import-zip", z);
          if (!res.ok) {
            lines.push({ path: z.name, filename: z.name, status: "failed", reason: (await uploadErrorOf(res, z)).message });
            continue;
          }
          lines.push(...((await res.json()) as { lines: IntakeLine[] }).lines);
        } catch (err) {
          lines.push({ path: z.name, filename: z.name, status: "failed", reason: (err as Error).message });
        }
      }
      setBusy(false);
      finish(`${lines.filter((l) => l.status === "stored").length} of ${lines.length} files imported`, lines, false);
    },
    [post, finish],
  );

  /** Files as the picker hands them: zips wait for the question. */
  const take = useCallback(
    async (list: FileList | File[] | null) => {
      const files = list ? Array.from(list) : [];
      if (files.length === 0) return;
      const zipped = files.filter(isZip);
      await upload(files.filter((f) => !isZip(f)));
      if (zipped.length) setZips(zipped);
    },
    [upload],
  );

  return {
    take,
    busy,
    progress,
    zips,
    unpack: () => zips && void unpack(zips),
    keepZips: () => {
      const keep = zips;
      setZips(null);
      if (keep) void upload(keep);
    },
    report,
    dismissReport: () => setReport(null),
  };
}

/** The zip question and the report, for a surface that has its own button
 *  (the Files page's Upload) and wants the rest to read the same. */
export function FileIntakePanels({ intake, where }: { intake: ReturnType<typeof useFileIntake>; where?: string }) {
  const { zips, report } = intake;
  return (
    <>
      {zips && (
        <div className="rounded border border-cobble-300 dark:border-cobble-700 bg-subtle dark:bg-slate-800 px-3 py-2.5 text-sm flex flex-wrap items-center gap-2" data-testid="zip-question">
          <span className="flex-1 min-w-0">
            {zips.length === 1 ? zips[0]!.name : `${zips.length} zip files`}: unpack the folders inside {where ?? "here"}, or keep {zips.length === 1 ? "it as a file" : "them as files"}?
          </span>
          <button type="button" onClick={intake.unpack} className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5">
            Unpack its folders here
          </button>
          <button type="button" onClick={intake.keepZips} className="rounded border border-line dark:border-slate-700 px-3 py-1.5 hover:text-accent">
            Keep as {zips.length === 1 ? "a file" : "files"}
          </button>
        </div>
      )}
      {report && (
        <div role="status" className="rounded border border-line dark:border-slate-700 px-3 py-2.5 text-sm space-y-1" data-testid="intake-report">
          <div className="flex items-center gap-2">
            <span className="flex-1 font-medium text-content dark:text-mortar-100">{report.title}</span>
            <button type="button" onClick={intake.dismissReport} className="text-xs text-muted hover:text-accent">
              Done
            </button>
          </div>
          {report.lines.length > 0 && (
            <ul className="max-h-48 overflow-auto text-xs text-muted space-y-0.5">
              {report.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}

/** A complete drop zone: a button that picks many files (a zip included),
 *  the progress in its label, and the panels. */
export function FileIntake({ label = "Upload", accept, where, className, children, ...opts }: FileIntakeOptions & { label?: string; accept?: string; where?: string; className?: string; children?: ReactNode }) {
  const intake = useFileIntake(opts);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={className ?? "space-y-2"}>
      <button
        type="button"
        disabled={intake.busy}
        onClick={() => input.current?.click()}
        className="inline-flex items-center gap-2 rounded bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white px-3 py-1.5 text-sm transition"
      >
        {children}
        {intake.progress ? `Uploading ${intake.progress.done + 1} of ${intake.progress.of}…` : intake.busy ? "Importing…" : label}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          e.target.value = "";
          void intake.take(files);
        }}
      />
      <FileIntakePanels intake={intake} where={where} />
    </div>
  );
}
