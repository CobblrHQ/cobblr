import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError, type TokensStillWorking } from "../lib/api";

/** After a new password: sessions ended, API tokens did not. Says which still work and offers to end them; leaving
 *  them is the default, since a bridge or an automation may depend on one. */
export function TokensStillWork({ tokens, onDone }: { tokens: TokensStillWorking; onDone: () => void }) {
  const [said, setSaid] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const end = useMutation({
    mutationFn: () => api.endMyApiTokens(),
    onSuccess: (r) => setSaid(r.message),
    onError: (e) => setFailed(e instanceof ApiError ? e.message : String(e)),
  });
  return (
    <div data-testid="tokens-still-work" className="rounded-lg border border-line dark:border-slate-700 bg-subtle dark:bg-slate-800 p-3 space-y-2 text-sm text-content dark:text-slate-200">
      <p>{said ?? tokens.message}</p>
      {!said && <p className="text-xs text-muted">Your other devices were signed out. API tokens keep working until you end them, so a bridge or an automation doesn't stop without warning.</p>}
      {failed && <p role="alert" className="text-xs text-ember-500">{failed}</p>}
      <div className="flex flex-wrap gap-2">
        {!said && (
          <button type="button" data-testid="tokens-end-too" disabled={end.isPending} onClick={() => end.mutate()} className="min-h-11 rounded border border-line dark:border-slate-600 px-3 py-1 text-sm text-content dark:text-slate-200 hover:border-accent disabled:opacity-50">
            {tokens.count === 1 ? "End it too" : "End them too"}
          </button>
        )}
        <button type="button" data-testid="tokens-keep" disabled={end.isPending} onClick={onDone} className="min-h-11 rounded bg-cobble-600 px-3 py-1 text-sm text-white disabled:opacity-50">
          {said ? "Done" : tokens.count === 1 ? "Keep it" : "Keep them"}
        </button>
      </div>
    </div>
  );
}
