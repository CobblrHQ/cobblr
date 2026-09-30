// One service job, where the conversation that started it is (services.md
// section 11): what it is doing, the yes it is waiting for, the question it
// is asking, and what it made.
//
// The card IS the confirm for a job that needs a person: Cobb's tool starts
// the job and the server's gate decides it waits here, so there is no chat
// proposal before it and nothing asks twice.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EntityPhoto } from "@cobblr/platform-web";
import { api, ApiError, type ServiceJob } from "../lib/api";
import { openAuthedFile } from "../lib/authed-file";

const TERMINAL = new Set(["done", "failed", "cancelled"]);

const STATUS_WORD: Record<string, string> = {
  awaiting_confirm: "Waiting for your yes",
  queued: "Queued",
  running: "Running",
  needs_input: "Asking you something",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function serviceJobKey(slug: string, id: string) {
  return ["service-job", slug, id] as const;
}

export function ServiceJobCard({ slug, jobId, capability }: { slug: string; jobId: string; capability?: string }) {
  const qc = useQueryClient();
  const job = useQuery({
    queryKey: serviceJobKey(slug, jobId),
    queryFn: () => api.getServiceJob(slug, jobId),
    // Follows the job while it can still change, and stops when it cannot.
    refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.status) ? false : 3000),
  });
  const [said, setSaid] = useState<string | null>(null);
  const settle = (j: ServiceJob) => qc.setQueryData(serviceJobKey(slug, jobId), j);
  const onError = (e: unknown) => setSaid(e instanceof ApiError ? e.message : "That did not go through. Try again.");
  const confirm = useMutation({ mutationFn: () => api.confirmServiceJob(slug, jobId), onSuccess: settle, onError });
  const cancel = useMutation({ mutationFn: () => api.cancelServiceJob(slug, jobId), onSuccess: settle, onError });
  const answer = useMutation({ mutationFn: (input: unknown) => api.answerServiceJob(slug, jobId, input), onSuccess: settle, onError });

  const j = job.data;
  const status = j?.status ?? "queued";
  const busy = confirm.isPending || cancel.isPending || answer.isPending;
  const outputs = (j?.files ?? []).filter((f) => f.direction === "out");

  return (
    <div className="mt-2 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-3 text-sm" data-service-job={jobId} data-status={status}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-content dark:text-mortar-100">{j?.capability ?? capability ?? "Service job"}</span>
        <span className="text-[11px] rounded px-1.5 py-px border border-line dark:border-slate-700 text-muted">{STATUS_WORD[status] ?? status}</span>
      </div>
      {job.isError && <div className="text-[12px] text-red-700 dark:text-red-400 mt-1">This job could not be read just now.</div>}
      {j?.message && <div className="text-[12px] text-muted mt-1">{j.message}</div>}
      {(status === "running" || status === "queued") && typeof j?.progress === "number" && (
        <div className="mt-2 h-1.5 rounded bg-subtle dark:bg-slate-800 overflow-hidden" aria-label="Progress">
          <div className="h-full bg-cobble-500" style={{ width: `${Math.round(Math.min(1, Math.max(0, j.progress)) * 100)}%` }} />
        </div>
      )}

      {status === "awaiting_confirm" && (
        <div className="mt-2">
          <div className="text-[12px] text-amber-700 dark:text-amber-500">
            Nothing has run yet. It starts only when you say yes, exactly as it was asked.
          </div>
          <div className="flex gap-2 mt-2">
            <button type="button" disabled={busy} onClick={() => confirm.mutate()} className="px-3 py-1 rounded bg-cobble-600 text-white disabled:opacity-60">
              {confirm.isPending ? "Starting…" : "Yes, start it"}
            </button>
            <button type="button" disabled={busy} onClick={() => cancel.mutate()} className="px-3 py-1 rounded border border-line dark:border-slate-700 disabled:opacity-60">
              Don't
            </button>
          </div>
        </div>
      )}

      {status === "needs_input" && j?.needs && <NeedsInput slug={slug} needs={j.needs} busy={busy} onAnswer={(v) => answer.mutate(v)} />}

      {status === "done" && outputs.length > 0 && (
        <ul className="mt-2 space-y-1">
          {outputs.map((f) =>
            /\.(png|jpe?g|webp)$/i.test(f.name) || f.name === "preview" ? (
              <li key={f.file_id}>
                <JobPicture slug={slug} fileId={f.file_id} name={f.name} />
              </li>
            ) : (
              <li key={f.file_id}>
                <button type="button" className="text-accent hover:underline" onClick={() => void openAuthedFile(slug, f.file_id, { filename: f.name })}>
                  {f.name}
                </button>
              </li>
            ),
          )}
        </ul>
      )}

      {status === "failed" && j?.error && <div className="text-[12px] text-red-700 dark:text-red-400 mt-1">{j.error.message}</div>}

      {(status === "queued" || status === "running" || status === "needs_input") && (
        <button type="button" disabled={busy} onClick={() => cancel.mutate()} className="mt-2 text-[12px] text-faint hover:text-ember-500 disabled:opacity-60">
          Stop this job
        </button>
      )}
      {said && <div className="text-[12px] text-red-700 dark:text-red-400 mt-1">{said}</div>}
    </div>
  );
}

type Needs = NonNullable<ServiceJob["needs"]>;

/** The service's question, as a form drawn from the schema it sent: a field
 *  per simple property, or one JSON box when the schema is more than that. */
/** The files a question carries that the kernel has already stored, as
 *  pictures: a service's own blob reference is not something a browser can
 *  open, so only an entry with a file id shows. */
function previewsOf(needs: Needs): Array<{ name: string; file_id: string }> {
  const files = (needs as { files?: unknown }).files;
  const list = Array.isArray(files) ? files : files && typeof files === "object" ? Object.entries(files).map(([name, f]) => ({ name, ...(f as object) })) : [];
  return list.filter((f): f is { name: string; file_id: string } => !!f && typeof (f as { file_id?: unknown }).file_id === "string");
}

function NeedsInput({ slug, needs, busy, onAnswer }: { slug: string; needs: Needs; busy: boolean; onAnswer: (v: unknown) => void }) {
  const schema = (needs.input_schema ?? {}) as { properties?: Record<string, { type?: string; enum?: unknown[]; title?: string; description?: string }> };
  const props = Object.entries(schema.properties ?? {});
  const simple = props.length > 0 && props.every(([, p]) => ["string", "number", "integer", "boolean"].includes(String(p.type)) || Array.isArray(p.enum));
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [raw, setRaw] = useState("{}");
  const [bad, setBad] = useState(false);
  return (
    <div className="mt-2">
      <div className="text-[12px] text-content dark:text-mortar-100">{needs.prompt}</div>
      {/* What the question is about, when the service showed one (a design
          that is not watertight, or does not fit). */}
      {previewsOf(needs).map((f) => (
        <div key={f.file_id} className="mt-2">
          <JobPicture slug={slug} fileId={f.file_id} name={f.name} />
        </div>
      ))}
      {simple ? (
        <div className="mt-2 space-y-2">
          {props.map(([key, p]) => (
            <label key={key} className="block text-[12px]">
              <span className="text-muted">{p.title ?? key}</span>
              {Array.isArray(p.enum) ? (
                <select className="block mt-0.5 w-full rounded border border-line dark:border-slate-700 bg-transparent px-2 py-1" value={String(values[key] ?? "")} onChange={(e) => setValues({ ...values, [key]: e.target.value })}>
                  <option value="">Choose…</option>
                  {p.enum.map((o) => (
                    <option key={String(o)} value={String(o)}>
                      {String(o)}
                    </option>
                  ))}
                </select>
              ) : p.type === "boolean" ? (
                <input type="checkbox" className="ml-2" checked={!!values[key]} onChange={(e) => setValues({ ...values, [key]: e.target.checked })} />
              ) : (
                <input
                  type={p.type === "string" ? "text" : "number"}
                  className="block mt-0.5 w-full rounded border border-line dark:border-slate-700 bg-transparent px-2 py-1"
                  value={String(values[key] ?? "")}
                  onChange={(e) => setValues({ ...values, [key]: p.type === "string" ? e.target.value : Number(e.target.value) })}
                />
              )}
            </label>
          ))}
        </div>
      ) : (
        <textarea className="mt-2 w-full font-mono text-[12px] rounded border border-line dark:border-slate-700 bg-transparent p-2" rows={4} value={raw} onChange={(e) => setRaw(e.target.value)} />
      )}
      {bad && <div className="text-[12px] text-red-700 dark:text-red-400">That is not valid JSON.</div>}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (simple) return onAnswer(values);
          try {
            setBad(false);
            onAnswer(JSON.parse(raw));
          } catch {
            setBad(true);
          }
        }}
        className="mt-2 px-3 py-1 rounded bg-cobble-600 text-white disabled:opacity-60"
      >
        Send
      </button>
    </div>
  );
}

/** A picture the job made, shown whole in a box sized before it arrives. */
function JobPicture({ slug, fileId, name }: { slug: string; fileId: string; name: string }) {
  return (
    <EntityPhoto
      src={api.fileRawUrl(slug, fileId, "medium")}
      alt={name}
      aspect="4/3"
      fit="contain"
      className="w-48 rounded border border-line dark:border-slate-700"
    />
  );
}
