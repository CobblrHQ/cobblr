// A workspace address that matches no page says so. It used to land on Home
// without a word, so a mistyped or out-of-date link looked like the app had
// lost the page, or had ignored the click.
import { Link } from "react-router-dom";
import { Compass } from "lucide-react";

export function PageNotFound() {
  return (
    <div className="max-w-xl mx-auto mt-10 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-6 text-center">
      <Compass className="w-8 h-8 mx-auto text-faint mb-3" aria-hidden />
      <h1 className="text-lg font-semibold text-content dark:text-mortar-100 mb-1">There's no page here</h1>
      <p className="text-sm text-muted mb-4">The link may be mistyped or out of date. Nothing in this workspace has changed.</p>
      <Link to="/" className="inline-block px-4 py-2 text-sm rounded bg-cobble-600 hover:bg-cobble-700 text-white">
        Go to Home
      </Link>
    </div>
  );
}
