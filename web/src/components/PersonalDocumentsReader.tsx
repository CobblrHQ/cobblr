// "Personal documents" on a workspace's AI page (#5621): who reads them, in
// one sentence that says what is true now, and for the workspace's owner the
// choice of a cloud connection, which needs their consent in words that name
// the company the documents go to. Local only is the default and the way back.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useToast } from "@cobblr/platform-web";
import { api, ApiError, type PersonalDocumentsReaderView } from "../lib/api";
import { aiAvailabilityKeys } from "../lib/ai-availability-keys";
import { useActiveOrg } from "../auth/ActiveOrgContext";

const LOCAL = "local";

/** The one sentence the panel says: what happens to a personal document now. */
export function readerSentence(v: Pick<PersonalDocumentsReaderView, "reader" | "local_ai">): string {
  if (v.reader.kind === "cloud") {
    const when = v.reader.consented_at.slice(0, 10);
    return `Sent to ${v.reader.company} (${v.reader.label}) to be read, as ${v.reader.consented_by ?? "the owner"} agreed on ${when}.`;
  }
  return v.local_ai
    ? "Read on this machine: code reads what it can and your local AI fills in the rest. They never go to a cloud AI."
    : "No local AI is connected: code reads what it can and you check the rest. They never go to a cloud AI.";
}

/** Who reads personal documents. The list of jobs it sits in waits for the answer: the row is drawn only once it is known, in the middle of the list. */
export function usePersonalDocumentsReader() {
  const { activeSlug } = useActiveOrg();
  return useQuery({ queryKey: aiAvailabilityKeys.personalReader(activeSlug), queryFn: () => api.getPersonalDocumentsReader(activeSlug), enabled: !!activeSlug });
}

export function PersonalDocumentsReader() {
  const { activeSlug } = useActiveOrg();
  const qc = useQueryClient();
  const toast = useToast();
  const view = usePersonalDocumentsReader();
  const [picked, setPicked] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);
  const save = useMutation({
    mutationFn: (body: Parameters<typeof api.setPersonalDocumentsReader>[1]) => api.setPersonalDocumentsReader(activeSlug, body),
    onSuccess: (next) => {
      qc.setQueryData(aiAvailabilityKeys.personalReader(activeSlug), next);
      void qc.invalidateQueries({ queryKey: aiAvailabilityKeys.all() });
      setPicked(null);
      setAgreed(false);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const v = view.data;
  if (!v) return null;
  const current = v.reader.kind === "cloud" ? v.reader.connection : LOCAL;
  const choice = picked ?? current;
  const offer = v.choices.find((c) => c.connection === choice);
  const changing = choice !== current;

  return (
    <div className="py-3" data-job="personal">
      <div className="text-sm font-medium text-content dark:text-mortar-100">Personal documents</div>
      <p className="mt-1 text-sm text-muted" data-personal-reader>
        {readerSentence(v)}
        {v.reader.kind === "local" && !v.local_ai && (
          <>
            {" "}
            <Link to="/me/connections" className="text-accent hover:underline">
              Connect a local AI
            </Link>{" "}
            (Ollama on your computer, or an{" "}
            <Link to="/configuration/edge" className="text-accent hover:underline">
              edge bridge
            </Link>
            ).
          </>
        )}
      </p>
      {v.can_change && (
        <div className="mt-2 space-y-2">
          <label className="flex flex-wrap items-center gap-2 text-xs text-muted">
            Personal documents are read by
            <select
              aria-label="Personal documents are read by"
              value={choice}
              disabled={save.isPending}
              onChange={(e) => {
                setPicked(e.target.value);
                setAgreed(false);
              }}
              className="min-w-0 max-w-full px-2 py-1 text-sm border border-line dark:border-slate-600 rounded bg-surface dark:bg-slate-900"
            >
              <option value={LOCAL}>This machine only</option>
              {v.choices.map((c) => (
                <option key={c.connection} value={c.connection}>
                  {c.label} ({c.company})
                </option>
              ))}
            </select>
          </label>
          {changing && choice === LOCAL && (
            <button type="button" disabled={save.isPending} onClick={() => save.mutate({ connection: LOCAL })} className="text-xs text-accent hover:underline disabled:opacity-50">
              Keep them on this machine only
            </button>
          )}
          {changing && offer && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-50 dark:bg-amber-950/20 p-2 text-xs text-amber-800 dark:text-amber-200" data-consent>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" aria-label={offer.consent} />
                <span>{offer.consent} You can change this back at any time.</span>
              </label>
              <button
                type="button"
                disabled={!agreed || save.isPending}
                onClick={() => save.mutate({ connection: offer.connection, consent: offer.consent })}
                className="mt-2 rounded bg-accent px-2 py-1 text-white disabled:opacity-40"
              >
                Send them to {offer.company}
              </button>
            </div>
          )}
        </div>
      )}
      {!v.can_change && <p className="mt-1 text-[11px] text-faint">Only the workspace's owner changes who reads personal documents.</p>}
    </div>
  );
}
