// The filed row: where an inbox item went, in the place it was (#3789,
// lib/filedRows.ts). One filed item is a dimmed row with its picture, its
// name, "Filed to Yarn", Go to Yarn and Undo; several are one line, "Filed
// just now: 2 to Yarn, 1 to Pantry", each part a link. The first filing ever
// also says where that table lives in the menu.

import { Link } from "react-router-dom";
import { CheckCircle, RotateCcw, X } from "lucide-react";
import { EntityPhoto } from "@cobblr/platform-web";
import { filedNameOf, filedSummary, filedWords, type FiledRow } from "../lib/filedRows";
import { navTargetFor } from "../components/useNavModules";
import { useActiveOrgOptional } from "../auth/ActiveOrgContext";
import { rowPictures } from "../lib/rowPictures";
import { useDetailRoute, useListRoute } from "../lib/useDetailRoute";

function FiledThumb({ slug, row }: { slug: string; row: FiledRow }) {
  const resolved = rowPictures(slug, row.item, {});
  const first = resolved.pictures[0];
  return <EntityPhoto src={first ? resolved.src(first, "thumb") : null} alt="" size={48} className="rounded-md" imgClassName="opacity-70" placeholder={null} />;
}

const nameOf = (row: FiledRow) => filedNameOf(row.item);

export function FiledRowView({
  slug,
  row,
  onUndo,
  undoing,
  onDismiss,
}: {
  slug: string;
  row: FiledRow;
  onUndo: () => void;
  undoing: boolean;
  onDismiss: () => void;
}) {
  const recordRoute = useDetailRoute(slug);
  const listRoute = useListRoute(slug);
  const appMode = !!useActiveOrgOptional()?.activeOrg?.app_mode;
  const words = filedWords(row);
  // A record under a type opens the type's page with the record picked out:
  // the types and their records are one page.
  const to = row.under
    ? `${navTargetFor(`__instance__${row.under.instance}`, appMode)}${row.createdId ? `?highlight=${encodeURIComponent(row.createdId)}` : ""}`
    : ((row.kind && row.createdId ? recordRoute(row.kind, row.createdId) : null) ?? (row.kind ? listRoute(row.kind) : null));
  return (
    <div
      data-testid="filed-row"
      className="rounded-lg border border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-900/60 px-3 py-2.5"
    >
      <div className="flex items-center gap-3">
        <FiledThumb slug={slug} row={row} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-muted dark:text-slate-400">{nameOf(row)}</div>
          <div className="flex items-center gap-1 text-[13px] font-medium text-emerald-700 dark:text-emerald-400">
            <CheckCircle size={14} className="shrink-0" /> {words.headline}
          </div>
        </div>
        <button type="button" onClick={onDismiss} aria-label="Close" className="shrink-0 self-start p-1 text-faint hover:text-content">
          <X size={16} />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        {to && (
          <Link
            to={to}
            className="inline-flex min-h-9 items-center rounded-md bg-cobble-600 px-3 text-[13px] font-semibold text-white hover:bg-cobble-700"
          >
            {words.go}
          </Link>
        )}
        <button
          type="button"
          onClick={onUndo}
          disabled={undoing}
          className="inline-flex min-h-9 items-center gap-1 rounded-md border border-line dark:border-slate-600 px-3 text-[13px] text-content dark:text-mortar-100 disabled:opacity-50"
        >
          <RotateCcw size={13} /> Undo
        </button>
      </div>
      {row.firstEver && (
        <p data-testid="filed-row-first" className="mt-2 text-[12px] text-muted dark:text-slate-400">
          {row.destination} is new: find it any time in the menu.
        </p>
      )}
    </div>
  );
}

export function FiledSummaryView({ slug, rows, onDismiss }: { slug: string; rows: readonly FiledRow[]; onDismiss: () => void }) {
  const listRoute = useListRoute(slug);
  const parts = filedSummary(rows);
  const first = rows.find((r) => r.firstEver);
  return (
    <div
      data-testid="filed-summary"
      className="rounded-lg border border-line dark:border-slate-700 bg-subtle/60 dark:bg-slate-900/60 px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <CheckCircle size={15} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
        <p className="min-w-0 flex-1 text-[13px] text-content dark:text-mortar-100">
          Filed just now:{" "}
          {parts.map((p, i) => {
            const to = p.kind ? listRoute(p.kind) : null;
            const words = `${p.count} to ${p.destination}`;
            return (
              <span key={p.destination}>
                {i > 0 && ", "}
                {to ? (
                  <Link to={to} className="font-medium text-accent underline underline-offset-2">
                    {words}
                  </Link>
                ) : (
                  words
                )}
              </span>
            );
          })}
        </p>
        <button type="button" onClick={onDismiss} aria-label="Close" className="shrink-0 p-0.5 text-faint hover:text-content">
          <X size={16} />
        </button>
      </div>
      {first && (
        <p data-testid="filed-row-first" className="mt-1.5 pl-6 text-[12px] text-muted dark:text-slate-400">
          {first.destination} is new: find it any time in the menu.
        </p>
      )}
    </div>
  );
}
