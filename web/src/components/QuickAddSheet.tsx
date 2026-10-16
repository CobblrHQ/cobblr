// "Add a thing" from anywhere: the palette's row (and anything else that
// fires OPEN_ADD_SHEET_EVENT) opens this, the same capture as the dashboard's
// "Just add it". The row fired its event into nothing until this listened
// (#4199). It stays open after an add, so a second thing is one more line,
// and says where the first one went.
import { productName } from "@cobblr/platform-web";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Modal, NewFromTemplateButton } from "@cobblr/platform-web";
import { FreeformAdd } from "./FreeformAdd";
import { useAddByWords } from "../lib/useAddByWords";
import { OPEN_ADD_SHEET_EVENT, hostGone, hostLoaded } from "./palette-events";

export function QuickAddSheet({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState<string[]>([]);
  const add = useAddByWords(slug);
  useEffect(() => {
    const onOpen = () => {
      setAdded([]);
      setOpen(true);
    };
    window.addEventListener(OPEN_ADD_SHEET_EVENT, onOpen);
    if (hostLoaded(OPEN_ADD_SHEET_EVENT)) onOpen();
    return () => {
      window.removeEventListener(OPEN_ADD_SHEET_EVENT, onOpen);
      hostGone(OPEN_ADD_SHEET_EVENT);
    };
  }, []);

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Add a thing" size="sm">
      <p className="text-xs text-muted dark:text-slate-400 mb-3">
        Type what you&rsquo;ve got. {productName()} finds or builds the right home and files it.
      </p>
      <FreeformAdd slug={slug} placeholder="e.g. a box of screws, a cordless drill" add={add} autoFocus onAdded={(t) => setAdded((a) => [...a, t])} />
      <NewFromTemplateButton onOpen={() => setOpen(false)} />
      {added.length > 0 && (
        <p className="mt-3 text-xs text-muted dark:text-slate-400" data-testid="quick-add-landed">
          {added.length === 1 ? <>&ldquo;{added[0]}&rdquo; is</> : <>{added.length} things are</>} in the{" "}
          <Link to="/scan" onClick={() => setOpen(false)} className="text-accent hover:underline">
            scan inbox
          </Link>{" "}
          while {productName()} finds {added.length === 1 ? "its" : "their"} home.
        </p>
      )}
    </Modal>
  );
}
