// Catches render/lifecycle errors in its subtree and shows a fallback
// instead of unmounting the whole React tree (white screen). Reset by
// changing its `key` — the routed boundary is keyed on the pathname, so
// navigating away from a crashed page recovers. Also catches lazy-chunk
// load failures, which a Suspense fallback alone does not.

import { Component, type ErrorInfo, type ReactNode } from "react";
import { dropStaleBuild } from "../lib/staleBuild";

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

/** Reload once for a stale-chunk error; returns true if a reload was kicked off.
 *  The reload follows dropping the app's cached copy and its service worker
 *  (#4813): an installed app's worker answers a plain reload with the same
 *  stale build, so the guard would trip and show the error page. */
function reloadForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
    if (Date.now() - last < RELOAD_GUARD_MS) return false; // already tried — don't loop
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    /* sessionStorage unavailable (private mode) — fall through and reload anyway */
  }
  void dropStaleBuild().finally(() => window.location.reload());
  return true;
}

/** "Get the latest version": the same steps, whatever the loop guard says. */
async function getLatestVersion(): Promise<void> {
  await dropStaleBuild();
  window.location.reload();
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
  private dropOnline: (() => void) | null = null;

  componentWillUnmount(): void {
    this.dropOnline?.();
  }

  static getDerivedStateFromError(error: Error): State {
    // Surface a calm "updating" state for stale-chunk errors instead of the
    // scary fallback — the reload is fired in componentDidCatch.
    return { error, reloading: isChunkLoadError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[error-boundary:${this.props.scope ?? "app"}]`, error, info.componentStack);
    if (isChunkLoadError(error) && typeof navigator !== "undefined" && navigator.onLine === false) {
      // Offline the code cannot arrive, and a reload would only trade the page
      // for the browser's own offline error (#6482). Say so, and try again once
      // the device is back.
      this.setState({ reloading: false });
      const again = () => this.setState({ error: null, reloading: false });
      window.addEventListener("online", again, { once: true });
      this.dropOnline = () => window.removeEventListener("online", again);
      return;
    }
    if (isChunkLoadError(error)) {
      // The boot guard (web/public/boot-guard.js) owns what a failed load does,
      // at the start and for a page: retry soon, then after a backoff, then say
      // so with Retry (#5966). Without it (a test), reload once as before.
      const guard = (window as { __cobblrLoadFailed?: (o: { app: true }) => "retrying" | "failed" }).__cobblrLoadFailed;
      const kicked = guard ? guard({ app: true }) === "retrying" : reloadForStaleChunk();
      // Gave up: show the plain message and its Retry.
      if (!kicked) this.setState({ reloading: false });
    }
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    if (this.state.reloading) {
      return (
        <div className="m-6 max-w-2xl rounded-xl border border-line bg-surface/70 p-6 text-sm text-muted dark:border-slate-700 dark:bg-slate-900">
          Loading again…
        </div>
      );
    }
    // A page whose code did not arrive (a network blip, or a deploy that
    // replaced it): what to do about it, never the raw error.
    if (isChunkLoadError(this.state.error)) {
      return (
        <div role="alert" data-testid="load-failed" className="m-6 max-w-md rounded-xl border border-line bg-surface p-6 text-center dark:border-slate-700 dark:bg-slate-900">
          <p className="text-lg font-semibold text-content dark:text-mortar-100">Couldn&apos;t load this page.</p>
          <p className="mt-1 text-sm text-muted dark:text-slate-400">Check your connection, then try again.</p>
          <button
            type="button"
            data-testid="get-latest-version"
            onClick={() => {
              try {
                sessionStorage.removeItem("cobblr:load-retries");
              } catch {
                /* private mode */
              }
              void getLatestVersion();
            }}
            className="mt-4 rounded-md bg-cobble-600 px-4 py-2 text-sm font-medium text-white hover:bg-cobble-700"
          >
            Retry
          </button>
        </div>
      );
    }
    const scope = this.props.scope ?? "page";
    return (
      <div
        data-testid="app-error-boundary"
        className="m-6 max-w-2xl rounded-xl border border-ember-200 dark:border-ember-800 bg-ember-50/60 dark:bg-slate-900 p-6"
      >
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
