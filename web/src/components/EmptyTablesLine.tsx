import { Link } from "react-router-dom";
import { MetaParts } from "./MetaParts";

/** The home page's one quiet line for tables that are switched on and hold
 *  nothing yet. "Still empty" is true of one table or five, so the line never
 *  has to agree in number; a tile's own label is lower case ("purchases"), and a
 *  name in a sentence starts with a capital; `first` drops "also" when no card sits above it. */
export function EmptyTablesLine({ tables, first }: { tables: ReadonlyArray<readonly [label: string, to: string]>; first: boolean }) {
  return (
    <p className="mt-2 text-xs text-faint dark:text-slate-500">
      {first ? "Switched on, still empty:" : "Also switched on, still empty:"}{" "}
      <MetaParts
        parts={tables.map(([label, to]) => (
          <Link key={label} to={to} className="hover:text-accent underline decoration-dotted underline-offset-2">
            {label.charAt(0).toUpperCase() + label.slice(1)}
          </Link>
        ))}
      />
    </p>
  );
}
