// A workspace whose database was never made (#5146): said in words, with the
// one thing to press. Before, its dashboard drew with nothing in it and no word
// why, because every request behind it answered 503 tenant_unprovisioned.
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { clearWorkspaceUnfinished } from "../lib/workspace-unfinished";

const PRIMARY = "w-full rounded-md bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-4 py-2.5 transition disabled:opacity-60";

export function WorkspaceUnfinished({ slug, name }: { slug: string; name?: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.finishWorkspaceSetup(slug);
      clearWorkspaceUnfinished(slug);
      // Every query behind the shell failed while it was unfinished; start them again.
      window.location.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Setting it up did not finish. Try again in a few minutes.");
      setBusy(false);
    }
  };
  return (
    <div className="min-h-screen grid place-items-center bg-canvas text-content px-4 py-8" data-testid="workspace-unfinished">
      <div className="max-w-md w-full">
        <h1 className="text-2xl font-bold text-slate-700 dark:text-mortar-100">{name ? `${name} is not set up yet` : "This workspace is not set up yet"}</h1>
        <p className="mt-1.5 text-muted">
          When it was made, its storage did not finish being created, so nothing here can open yet. Nothing was lost: it is empty because nothing could be added. Finish setting it up now; it is also finished by itself the next time the server restarts.
        </p>
        <button type="button" onClick={() => void finish()} disabled={busy} className={"mt-5 " + PRIMARY}>
          {busy ? "Setting it up…" : "Finish setting it up"}
        </button>
        {error && (
          <p className="mt-2 text-sm text-ember-600 dark:text-ember-400" role="alert">
            {error}
          </p>
        )}
        <p className="mt-4 text-sm">
          <Link to="/" className="text-accent hover:underline">
            Go to another workspace
          </Link>
        </p>
      </div>
    </div>
  );
}
