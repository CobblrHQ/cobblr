// The page a /t/<token> link lands on: the whole no-account entrance.
//
// The visitor pressed one button on the homepage and arrived here. This
// exchanges the token for a session, stores it, and sends them into the
// workspace. They type nothing and see this for about a second.
//
// It is a full page rather than a redirect handled in App because the exchange
// can fail in ways a person has to be able to read — most often "your hour is
// up", which is not an error so much as the thing we told them would happen.
import { useEffect, useState } from "react";
import { setToken } from "../lib/api";

type State =
  | { kind: "working" }
  | { kind: "gone"; reason: string }
  | { kind: "error"; message: string };

/** The token is the last path segment of /t/<token>. */
function tokenFromPath(): string {
  const m = /^\/t\/([A-Za-z0-9_-]+)/.exec(window.location.pathname);
  return m?.[1] ?? "";
}

export function SandboxLanding() {
  const [state, setState] = useState<State>({ kind: "working" });

  useEffect(() => {
    const token = tokenFromPath();
    if (!token) {
      setState({ kind: "gone", reason: "That link is missing its token." });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/v1/try/redeem?token=${encodeURIComponent(token)}`, {
          headers: { Accept: "application/json" },
        });
        if (cancelled) return;
        if (res.status === 410) {
          setState({
            kind: "gone",
            reason:
              "Sandboxes only last an hour, on purpose - nothing you did is still sitting on our server.",
          });
          return;
        }
        if (!res.ok) {
          setState({ kind: "error", message: "We could not open that sandbox." });
          return;
        }
        const body = (await res.json()) as { token: string; slug: string; expires_at: string };
        setToken(body.token);
        // Remember when it ends so the app can show the countdown without
        // asking the server on every render. Per-browser and disposable, like
        // the sandbox itself.
        try {
          localStorage.setItem("cobblr.sandboxExpiresAt", body.expires_at);
        } catch {
          /* private mode: the countdown just will not show */
        }
        // replace(), not assign(): the token URL must not sit in history where
        // a back button returns to a page that redeems again.
        window.location.replace(`/w/${body.slug}/`);
      } catch {
        if (!cancelled) setState({ kind: "error", message: "We could not reach Cobblr." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "working") {
    return (
      <div className="min-h-screen grid place-items-center bg-canvas text-content">
        <div className="text-center">
          <p className="font-mono text-xs uppercase tracking-widest text-faint">setting up your sandbox</p>
          <p className="mt-2 text-lg">One moment.</p>
        </div>
      </div>
    );
  }

  const heading = state.kind === "gone" ? "Your hour is up." : "Something went wrong.";
  const body = state.kind === "gone" ? state.reason : state.message;

  return (
    <div className="min-h-screen grid place-items-center bg-canvas text-content px-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold text-slate-700 dark:text-mortar-100">{heading}</h1>
        <p className="mt-2 text-muted">{body}</p>
        <div className="mt-6 flex flex-wrap gap-3 justify-center">
          <a
            href="/api/v1/try"
            className="rounded-md bg-cobble-600 hover:bg-cobble-700 text-white font-medium px-4 py-2 transition"
          >
            Start another
          </a>
          <a
            href="/"
            className="rounded-md border border-line dark:border-slate-700 px-4 py-2 hover:bg-subtle transition"
          >
            Make an account
          </a>
        </div>
      </div>
    </div>
  );
}
