// Catches render/lifecycle errors in its subtree and shows a fallback
// instead of unmounting the whole React tree (white screen). Reset by
// changing its `key` — the routed boundary is keyed on the pathname, so
// navigating away from a crashed page recovers. Also catches lazy-chunk
// load failures, which a Suspense fallback alone does not.

import { Component, type ErrorInfo, type ReactNode } from "react";

// A lazy route chunk can 404 when a deploy lands while the tab is open: the
// loaded index.html references chunk hashes the freshly-deployed container no
// longer serves. The fix is simply to reload index.html (which lists the new
// hashes). We detect that class of error and auto-reload ONCE — guarded so a
// genuinely-broken chunk can't spin the page in a reload loop.
const CHUNK_LOAD_ERROR =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|dynamically imported module/i;

function isChunkLoadError(error: Error): boolean {
  return error?.name === "ChunkLoadError" || CHUNK_LOAD_ERROR.test(error?.message ?? "");
}

const RELOAD_GUARD_KEY = "cobblr:chunk-reload-at";
const RELOAD_GUARD_MS = 10_000;

/** Reload once for a stale-chunk error; returns true if a reload was kicked off. */
function reloadForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
    if (Date.now() - last < RELOAD_GUARD_MS) return false; // already tried — don't loop
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    /* sessionStorage unavailable (private mode) — fall through and reload anyway */
  }
  window.location.reload();
  return true;
}

interface Props {
  children: ReactNode;
  /** Shown in the fallback copy ("page" / "app") and the console tag. */
  scope?: string;
}
interface State {
  error: Error | null;
  reloading: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reloading: false };

  static getDerivedStateFromError(error: Error): State {
    // Surface a calm "updating" state for stale-chunk errors instead of the
    // scary fallback — the reload is fired in componentDidCatch.
    return { error, reloading: isChunkLoadError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[error-boundary:${this.props.scope ?? "app"}]`, error, info.componentStack);
    if (isChunkLoadError(error)) {
      const kicked = reloadForStaleChunk();
      // Reload was suppressed by the loop guard — show the real fallback.
      if (!kicked) this.setState({ reloading: false });
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    if (this.state.reloading) {
      return (
        <div className="m-6 max-w-2xl rounded-xl border border-line bg-surface/70 p-6 text-sm text-muted dark:border-slate-700 dark:bg-slate-900">
          Updating to the latest version…
        </div>
      );
    }
    const scope = this.props.scope ?? "page";
    return (
      <div className="m-6 max-w-2xl rounded-xl border border-ember-200 dark:border-ember-800 bg-ember-50/60 dark:bg-slate-900 p-6">
        <h2 className="text-lg font-semibold text-ember-700 dark:text-ember-300">
          Something broke on this {scope}.
        </h2>
        <p className="mt-1 text-sm text-content dark:text-mortar-200">
          The rest of the app is still running. Try again, or head back to the dashboard.
        </p>
        <pre className="mt-3 max-h-40 overflow-auto rounded bg-surface/70 dark:bg-slate-800 p-2 text-[11px] font-mono text-muted">
          {this.state.error.message}
        </pre>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded bg-cobble-600 px-3 py-1.5 text-sm text-white hover:bg-cobble-700"
          >
            Try again
          </button>
          <a
            href="/"
            className="rounded border border-line px-3 py-1.5 text-sm text-content dark:border-slate-600 dark:text-slate-300"
          >
            Dashboard
          </a>
        </div>
      </div>
    );
  }
}
