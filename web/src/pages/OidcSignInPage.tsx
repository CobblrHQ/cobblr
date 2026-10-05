// /sign-in/oidc: where the instance's own sign-in provider sends the browser
// back (#4492). The api has already checked the provider's answer; it hands
// this page a one-time code (traded here for a session, by POST, so no token
// rides in a URL) or the reason it signed nobody in.
import { useEffect, useState } from "react";
import { usePageTitle } from "@cobblr/platform-web";
import { api, ApiError, setToken } from "../lib/api";
import { redeemOnce } from "../lib/redeem-once";
import { rememberSignedInWith, takeNext } from "../lib/oidc-sign-in";

export function OidcSignInPage() {
  usePageTitle("Signing in");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (!code) {
      setError(params.get("message") || (params.get("error") === "provider_off" ? "That way of signing in is turned off here." : "That sign-in did not finish. Try again."));
      return;
    }
    void redeemOnce(code, () => api.oidcRedeem({ code }))
      .then((res) => {
        setToken(res.token);
        if (res.signed_in_with) rememberSignedInWith(res.signed_in_with);
        // A full load, so the app reads the new session from the start.
        window.location.href = takeNext();
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "That sign-in did not finish. Try again."));
  }, []);
  return (
    <div className="min-h-screen flex items-center justify-center p-6 text-center">
      {error ? (
        <div className="space-y-2 max-w-sm" data-testid="oidc-sign-in-error">
          <div className="text-sm text-ember-600 dark:text-ember-400">{error}</div>
          <a href="/" className="text-xs text-accent underline">
            Back to sign in
          </a>
        </div>
      ) : (
        <div className="text-sm text-muted">Signing you in…</div>
      )}
    </div>
  );
}
