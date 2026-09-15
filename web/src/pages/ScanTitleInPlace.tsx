// The card's title is the name: tap it to edit in place (#2982). The owner,
// on his desk: "I couldn't even edit the title directly and had to do it
// through the fields chip!" Enter saves through the same rename every other
// surface uses, Escape reverts, a tap elsewhere on the card still opens it.
import { useEffect, useRef, useState, type ReactNode } from "react";

export function ScanTitleInPlace({
  name,
  shown,
  onSave,
  className,
  title,
  dataLead,
  canEdit = true,
}: {
  /** The row's name, the value the box opens with. */
  name: string;
  /** What the title shows when not editing (the lead of a long name). */
  shown: ReactNode;
  onSave: (next: string) => void;
  className?: string;
  title?: string;
  /** Marks the span as a shortened lead (data-name-lead), for the tooltip rule. */
  dataLead?: boolean;
  canEdit?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) ref.current?.select();
  }, [editing]);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== name.trim()) onSave(next);
  };
  const revert = () => {
    setDraft(name);
    setEditing(false);
  };
  if (editing) {
    return (
      <input
        ref={ref}
        autoFocus
        aria-label="Edit the name"
        data-field="name"
        data-testid="title-edit"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={stop}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            revert();
          }
        }}
        onBlur={commit}
        className={"min-w-[12rem] max-w-full rounded border border-accent bg-surface dark:bg-slate-900 px-1.5 py-0.5 font-medium text-content dark:text-mortar-100 outline-none " + (className ?? "")}
      />
    );
  }
  return (
    <span
      role={canEdit ? "button" : undefined}
      tabIndex={canEdit ? 0 : undefined}
      aria-label={canEdit ? "Edit the name" : undefined}
      data-testid="title"
      data-name-lead={dataLead ? "" : undefined}
      title={title ?? (canEdit ? "Tap to edit the name" : undefined)}
      onClick={
        canEdit
          ? (e) => {
              stop(e);
              setDraft(name);
              setEditing(true);
            }
          : undefined
      }
      onKeyDown={
        canEdit
          ? (e) => {
              if (e.key === "Enter") {
                stop(e);
                setDraft(name);
                setEditing(true);
              }
            }
          : undefined
      }
      className={(className ?? "") + (canEdit ? " cursor-text rounded hover:bg-mortar-50 dark:hover:bg-slate-800 -mx-1 px-1" : "")}
    >
      {shown}
    </span>
  );
}
