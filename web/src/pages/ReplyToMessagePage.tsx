// The reply link a wire may add to its message to someone outside a
// workspace (#6070, slice 3b): what the message was about and two answers,
// "Got it" and "Bought it", nothing else of the workspace. Signed out; the
// token is the key, for one message, for 14 days.
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { usePageTitle } from "@cobblr/platform-web";
import { MAIN_ID, SkipToContent } from "../components/a11y/shell-landmarks";

type Answer = "got" | "bought";

async function readJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok) throw new Error(body?.error?.message ?? `The link did not answer (${res.status}).`);
  return body as T;
}

const SAID: Record<Answer, string> = { got: "You said you got the message. Thank you.", bought: "You said you bought it. Thank you; they have been told." };

export function ReplyToMessagePage() {
  usePageTitle("Reply");
  const { token = "" } = useParams();
  const url = `/api/v1/public/external-reply/${encodeURIComponent(token)}`;
  const about = useQuery({
    queryKey: ["external-reply", token],
    queryFn: async () => readJson<{ workspace: string; item: string | null; answered: Answer | null }>(await fetch(url)),
    retry: false,
  });
  const answer = useMutation({
    mutationFn: async (a: Answer) =>
      readJson<{ answered: Answer }>(await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: a }) })),
  });
  const done = answer.data?.answered ?? about.data?.answered ?? null;
  return (
    <>
      <SkipToContent />
      <main id={MAIN_ID} tabIndex={-1} className="min-h-screen bg-canvas dark:bg-slate-950 px-4 py-16">
        <div className="mx-auto max-w-md rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 space-y-3" data-testid="reply-to-message">
          {about.isLoading && <p className="text-sm text-muted">Reading the link…</p>}
          {about.isError && <p className="text-sm text-ember-700 dark:text-ember-300">{(about.error as Error).message}</p>}
          {about.data && (
            <>
              <h1 className="text-lg font-semibold text-content dark:text-mortar-100 break-words" data-testid="reply-item">
                {about.data.item ?? "A message"}
              </h1>
              <p className="text-sm text-muted dark:text-slate-400">From {about.data.workspace}</p>
              {done ? (
                <p className="text-sm text-content dark:text-mortar-200" data-testid="reply-done">{SAID[done]}</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => answer.mutate("got")}
                    disabled={answer.isPending}
                    className="rounded-md border border-line dark:border-slate-600 px-4 py-2 text-sm text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800 disabled:opacity-60"
                    data-testid="reply-got"
                  >
                    Got it
                  </button>
                  <button
                    type="button"
                    onClick={() => answer.mutate("bought")}
                    disabled={answer.isPending}
                    className="rounded-md bg-cobble-600 px-4 py-2 text-sm font-medium text-white hover:bg-cobble-700 disabled:opacity-60"
                    data-testid="reply-bought"
                  >
                    Bought it
                  </button>
                </div>
              )}
              {answer.isError && <p className="text-sm text-ember-700 dark:text-ember-300">{(answer.error as Error).message}</p>}
            </>
          )}
        </div>
      </main>
    </>
  );
}
