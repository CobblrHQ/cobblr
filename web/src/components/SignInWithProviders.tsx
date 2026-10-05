// "Sign in with <provider>" on the sign-in page, for each provider the
// instance's operator set up (#4492). When password sign-in is off, these are
// the only way in and the page says so.
import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { api } from "../lib/api";
import { signInWith } from "../lib/oidc-sign-in";

/** The sign-in page renders before (and outside) the app's query cache, so
 *  this is a plain read. Unreadable: no buttons, and password sign-in shown. */
export function useSignInProviders() {
  const [data, setData] = useState<{ items: Array<{ slug: string; display_name: string }>; password_signin: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    // Through the promise, so even a call that throws only means no buttons.
    Promise.resolve()
      .then(() => api.oidcProviders())
      .then((d) => live && setData(d))
      .catch(() => {
        /* quiet: no providers to offer; the password form stays */
      });
    return () => {
      live = false;
    };
  }, []);
  return { items: data?.items ?? [], passwordOn: data ? data.password_signin : true, loaded: !!data };
}

export function SignInWithProviders({ items, onlyWay, next }: { items: Array<{ slug: string; display_name: string }>; onlyWay: boolean; next: string | null }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2 mb-3" data-testid="sign-in-with">
      {onlyWay && <p className="text-xs text-muted text-center">This Cobblr signs in through its own sign-in.</p>}
      {items.map((p) => (
        <button
          key={p.slug}
          type="button"
          data-testid="sign-in-with-provider"
          onClick={() => signInWith(p.slug, next)}
          className="w-full flex items-center justify-center gap-2 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-2 text-sm font-medium text-content hover:border-accent"
        >
          <KeyRound size={15} aria-hidden />
          Sign in with {p.display_name}
        </button>
      ))}
      {!onlyWay && <div className="text-center text-[11px] text-faint">or</div>}
    </div>
  );
}
