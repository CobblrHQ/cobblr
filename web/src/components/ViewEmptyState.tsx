// The empty state of a saved view, which is one of two different things.
//
// A fresh Bookshelf opened on its cover wall (Gallery, 0 books) and said "No
// matching books." with nothing to press; the create action lived on the Table
// tab, one guess away, and the Scan door was in the top bar (2026-09-13
// review, #2835). That sentence is right for a filter that excluded everything
// and wrong for a collection with nothing in it yet. The server says which
// (`collection_empty` on the view-data answer); this renders the right one.
//
// Empty collection: the kind's own words ("Add your first book"), the same
// create door the Table has (`?new=1` on the kind's list page opens its
// create form), and the Scan door. Filtered-empty: "No matching {plural}" and
// a way to see everything. One component, mounted by the saved-view body
// BEFORE the renderer switch, so every renderer (and any new one) gets it.
import { Camera, Plus } from "lucide-react";
import { Link } from "react-router-dom";

export interface ViewEmptyStateProps {
  /** "book", "books" — the kind's own words, never its id. */
  noun: string;
  plural: string;
  /** True when the collection has nothing at all; false when the view's
   *  filter excluded everything it has. Undefined while unknown reads as
   *  filtered, the sentence that is never wrong about the data. */
  collectionEmpty: boolean | undefined;
  /** Where "Add your first {noun}" goes: the kind's list page with `?new=1`.
   *  Null when the kind has no page of its own; the Scan door stays. */
  createTo: string | null;
  /** Where "See all {plural}" goes when the view's filter hid everything. */
  seeAllTo: string | null;
  /** The Scan door. The camera page unless the host says otherwise. */
  scanTo?: string;
}

/** The dashed panel every saved-view renderer shows for zero rows. */
export function ViewEmptyState({ noun, plural, collectionEmpty, createTo, seeAllTo, scanTo = "/scan/camera" }: ViewEmptyStateProps) {
  if (collectionEmpty) {
    return (
      <div
        data-testid="view-empty-collection"
        className="border-2 border-dashed border-line dark:border-slate-700 rounded-xl p-10 text-center space-y-3"
      >
        <h2 className="font-display text-xl font-bold text-content dark:text-mortar-100">Add your first {noun}</h2>
        <p className="text-sm text-muted dark:text-slate-400">
          {createTo ? `Nothing here yet. Add a ${noun} by hand, or scan one and it lands here.` : `Nothing here yet. Scan a ${noun} and it lands here.`}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {createTo && (
            <Link
              to={createTo}
              className="inline-flex items-center gap-1.5 rounded-md bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-4 py-2 transition"
            >
              <Plus size={15} /> Add a {noun}
            </Link>
          )}
          <Link
            to={scanTo}
            className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-700 px-4 py-2 text-sm text-accent hover:border-cobble-300 transition"
          >
            <Camera size={15} /> Scan a barcode
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div
      data-testid="view-empty-filtered"
      className="border-2 border-dashed border-line dark:border-slate-700 rounded-xl p-8 text-center space-y-2"
    >
      <p className="text-sm text-muted dark:text-slate-400 italic">No matching {plural}.</p>
      {seeAllTo && (
        <Link to={seeAllTo} className="inline-block text-sm text-accent hover:underline not-italic">
          See all {plural}
        </Link>
      )}
    </div>
  );
}
