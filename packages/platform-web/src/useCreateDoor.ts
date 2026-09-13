// `?new=1` on a kind's list page opens its create form. One hook, so every
// list page reads the door the same way and a surface that is not the list
// page (a saved view's empty state, a dashboard card) can send someone
// straight to "add your first one" without knowing which form that is.
//
// The list page owns the form; the hook only opens it on arrival and strips
// the param when it closes, so the URL is clean again and a host that showed
// the list page BECAUSE of the param (an instance page over a picked view)
// can return to what it was showing.
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";

export const CREATE_PARAM = "new";

/** Opens the create form when the URL says `?new=1`; returns a close() that
 *  clears the param. Call the returned function from the form's own onClose. */
export function useCreateDoor(open: () => void): () => void {
  const [params, setParams] = useSearchParams();
  const wants = params.get(CREATE_PARAM) === "1";
  // Open once per arrival, not on every re-render while the param sits there.
  const opened = useRef(false);
  useEffect(() => {
    if (wants && !opened.current) {
      opened.current = true;
      open();
    }
    if (!wants) opened.current = false;
  }, [wants, open]);
  return () => {
    if (!params.has(CREATE_PARAM)) return;
    const next = new URLSearchParams(params);
    next.delete(CREATE_PARAM);
    setParams(next, { replace: true });
  };
}
