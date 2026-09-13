// The sign-in surfaces could not learn what this deployment allows. Say so
// and offer to ask again; never draw a form the server may refuse.
export function AuthConfigUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      data-testid="auth-config-unavailable"
      className="space-y-3 rounded-xl border border-line dark:border-slate-700 p-5 bg-white dark:bg-slate-900 text-center"
    >
      <p className="text-sm text-content dark:text-mortar-100">
        <strong>Couldn't reach Cobblr</strong> to check how signing in works here.
      </p>
      <p className="text-xs text-muted dark:text-slate-400">Check your connection, then try again.</p>
      <button
        type="button"
        onClick={onRetry}
        className="w-full rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2.5 transition"
      >
        Try again
      </button>
    </div>
  );
}
