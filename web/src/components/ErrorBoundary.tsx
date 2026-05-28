// Catches render/lifecycle errors in its subtree and shows a fallback
// instead of unmounting the whole React tree (white screen). Reset by
// changing its `key` — the routed boundary is keyed on the pathname, so
// navigating away from a crashed page recovers. Also catches lazy-chunk
// load failures, which a Suspense fallback alone does not.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Shown in the fallback copy ("page" / "app") and the console tag. */
  scope?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[error-boundary:${this.props.scope ?? "app"}]`, error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const scope = this.props.scope ?? "page";
    return (
      <div className="m-6 max-w-2xl rounded-xl border border-ember-200 dark:border-ember-800 bg-ember-50/60 dark:bg-slate-900 p-6">
        <h2 className="text-lg font-semibold text-ember-700 dark:text-ember-300">
          Something broke on this {scope}.
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-mortar-200">
          The rest of the app is still running. Try again, or head back to the dashboard.
        </p>
        <pre className="mt-3 max-h-40 overflow-auto rounded bg-white/70 dark:bg-slate-800 p-2 text-[11px] font-mono text-slate-500">
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
            className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-600 dark:border-slate-600 dark:text-slate-300"
          >
            Dashboard
          </a>
        </div>
      </div>
    );
  }
}
