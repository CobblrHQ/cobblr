// /bring?file=<link>: a sandbox's "Continue on Cobblr" lands here. Signed in,
// the file comes straight in: into the person's own workspace when it is
// still empty (a sign-up's first one), otherwise into a new one. No .zip to
// find a home for on a phone, no restore to look for in settings (#4217).
import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../auth/AuthContext";
import { dropBring } from "../lib/bring-pending";

type State = { kind: "working"; line: string } | { kind: "error"; message: string };

export function BringPage({ file }: { file: string | null }) {
  const { orgs } = useAuth();
  const [state, setState] = useState<State>({ kind: "working", line: "Bringing in your sandbox…" });
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    if (!file) {
      setState({ kind: "error", message: "There is no file to bring in here. Open the link from your email again." });
      return;
    }
    void (async () => {
      try {
        // Their only workspace, still empty (a fresh sign-up's): fill that one.
        const first = orgs?.length === 1 ? orgs[0]?.slug : undefined;
        if (first) {
          try {
            await api.restoreFromLink(first, file);
            dropBring();
            window.location.replace(`/w/${first}`);
            return;
          } catch (err) {
            if (!(err instanceof ApiError && err.status === 409)) throw err;
          }
        }
        // Otherwise a workspace of its own, so nothing already there is touched.
        setState({ kind: "working", line: "Making a new workspace for it…" });
        const made = await api.createOrg("My sandbox");
        await api.restoreFromLink(made.slug, file, { replace: true });
        dropBring();
        window.location.replace(`/w/${made.slug}`);
      } catch (err) {
        dropBring();
        setState({ kind: "error", message: err instanceof ApiError ? err.message : "We could not bring that file in. Try the link again." });
      }
    })();
  }, [file, orgs]);
  return (
    <div className="min-h-screen grid place-items-center bg-canvas text-content px-4" data-testid="bring">
      <div className="max-w-sm text-center">
        {state.kind === "error" ? (
          <>
            <h1 className="text-xl font-bold">That did not come in</h1>
            <p className="mt-2 text-sm text-muted" data-testid="bring-error">{state.message}</p>
            <a href="/" className="mt-4 inline-block text-sm text-accent hover:underline">Go to your workspace</a>
          </>
        ) : (
          <p className="text-sm text-muted" data-testid="bring-working">{state.line}</p>
        )}
      </div>
    </div>
  );
}
