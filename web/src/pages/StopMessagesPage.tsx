// The link at the foot of every message an automation emails someone outside
// a workspace (#6070): it names the workspace and asks; only the press stops
// the messages, so a mail scanner that opens links stops nothing by itself.
// Signed out, and it shows nothing else of the workspace.
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { usePageTitle } from "@cobblr/platform-web";
import { MAIN_ID, SkipToContent } from "../components/a11y/shell-landmarks";

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok) throw new Error(body?.error?.message ?? `The link did not answer (${res.status}).`);
  return body as T;
}

export function StopMessagesPage() {
  usePageTitle("Stop these messages");
  const { token = "" } = useParams();
  const url = `/api/v1/public/external-stop/${encodeURIComponent(token)}`;
  const about = useQuery({ queryKey: ["external-stop", token], queryFn: async () => readJson<{ workspace: string; stopped: boolean }>(await fetch(url)), retry: false });
  const stop = useMutation({ mutationFn: async () => readJson<{ stopped: boolean }>(await fetch(url, { method: "POST" })) });
  const done = stop.data?.stopped || about.data?.stopped;
  return (
    <>
    <SkipToContent />
    <main id={MAIN_ID} tabIndex={-1} className="min-h-screen bg-canvas dark:bg-slate-950 px-4 py-16">
      <div className="mx-auto max-w-md rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 space-y-3" data-testid="stop-messages">
        <h1 className="text-lg font-semibold text-content dark:text-mortar-100">Stop these messages</h1>
        {about.isLoading && <p className="text-sm text-muted">Reading the link…</p>}
        {about.isError && <p className="text-sm text-ember-700 dark:text-ember-300">{(about.error as Error).message}</p>}
        {about.data && !done && (
          <>
            <p className="text-sm text-content dark:text-mortar-200">
              An automation in <strong>{about.data.workspace}</strong> sent you a message. Stop it from sending you more?
            </p>
            <button
              type="button"
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
              className="rounded-md bg-cobble-600 px-4 py-2 text-sm font-medium text-white hover:bg-cobble-700 disabled:opacity-60"
              data-testid="stop-messages-press"
            >
              Stop these messages
            </button>
            {stop.isError && <p className="text-sm text-ember-700 dark:text-ember-300">{(stop.error as Error).message}</p>}
          </>
        )}
        {about.data && done && (
          <p className="text-sm text-content dark:text-mortar-200" data-testid="stop-messages-done">
            Done. This automation in {about.data.workspace} will not message you again.
          </p>
        )}
      </div>
    </main>
    </>
  );
}
