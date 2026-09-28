// A table's title, and the one line under it saying what goes in it when the
// name does not say so on its own ("Supplies": markers, needles, safety eyes,
// stuffing, buttons). The line is the bundle's `hint` on the table.
export function TableTitle({ title, hint }: { title: string; hint?: string | null }) {
  return (
    <div className="min-w-0">
      <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title">{title}</h1>
      {hint ? (
        <p className="text-xs text-muted dark:text-slate-400 mt-0.5" data-testid="table-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
