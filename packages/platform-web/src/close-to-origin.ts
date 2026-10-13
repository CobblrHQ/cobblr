// Closing a record that has an address of its own goes back to where it was
// opened from, and Back never opens it again (#6266).
//
// A record opened from a floor plan's drawer (/locations/<drawer> to
// /instances/hand-tools/items/<id>) closed by navigating FORWARD to its
// collection: the drawer was gone, and the record was now the entry before the
// collection, so Back opened the record again. Each page's Close named its
// list and pushed it. The one rule: when the record was reached from a page of
// this app, Close steps back to that page, as it was; when the record's
// address was the first page (a link from outside), Close replaces
// it with the fallback, so there is nothing behind to open it again.
// lint:closes-go-back-to-where-they-came-from holds every record close to it.
import { useCallback } from "react";
import { useLocation, useNavigate, type To } from "react-router-dom";

/** A Close for a record with its own address: back to where it was opened
 *  from, or, when nothing of this app is behind it, to `fallback` in its
 *  place. React Router keys the first page it drew "default"; every page
 *  reached from another has a key of its own. */
export function useCloseToOrigin(fallback: To): () => void {
  const navigate = useNavigate();
  const cameFromThisApp = useLocation().key !== "default";
  return useCallback(() => {
    if (cameFromThisApp) navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, fallback, cameFromThisApp]);
}
