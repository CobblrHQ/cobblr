// /try/join/:token — the link a kept trial's address receives when another
// sandbox asks to be kept with it. Opening it is the yes: the sandbox becomes
// another workspace of that account, and the link signs the address in.
import { productName } from "@cobblr/platform-web";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { setToken } from "../lib/api";

export function TryJoinPage() {
  const { token = "" } = useParams();
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    void (async () => {
      try {
        const res = await fetch("/api/v1/try/join", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const body = (await res.json().catch(() => null)) as { token?: string; slug?: string; error?: { message?: string } } | null;
        if (!res.ok || !body?.token || !body.slug) {
          setError(body?.error?.message ?? "We could not add that sandbox.");
          return;
        }
        setToken(body.token);
        try {
          localStorage.removeItem("cobblr.sandboxExpiresAt");
        } catch {
          /* private mode */
        }
        // replace(): the one-time link must not sit in history.
        window.location.replace(`/w/${body.slug}`);
      } catch {
        setError(`We could not reach ${productName()}.`);
      }
    })();
  }, [token]);
  return (
    <div className="min-h-screen grid place-items-center bg-canvas text-content px-4" data-testid="try-join">
      <div className="max-w-sm text-center">
        {error ? (
          <>
            <h1 className="text-xl font-bold">That link did not work</h1>
            <p className="mt-2 text-sm text-muted" data-testid="try-join-error">{error}</p>
            <a href="/login" className="mt-4 inline-block text-sm text-accent hover:underline">Sign in</a>
          </>
        ) : (
          <p className="text-sm text-muted">Adding the sandbox to your account…</p>
        )}
      </div>
    </div>
  );
}
