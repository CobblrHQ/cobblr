// A view's inputs over its rows (#6897): "Servings ×" on a recipe, a batch
// size on a build list. Each value lives in the page's URL (`in.<name>`), so a
// scaled view is a link that reopens scaled, and changing one reads the view
// again with it. Nothing here writes a record: an input changes what is shown.
// The server bounds every value and says what it had to change; this shows
// those notes rather than the number that was typed.
import { useSearchParams } from "react-router-dom";
import { VIEW_INPUT_PARAM, type ViewInput, type ViewInputNote } from "@cobblr/platform-contract/view-inputs";

export function ViewInputsBar({ declared, values, notes }: { declared: ViewInput[]; values: Record<string, string | number>; notes: ViewInputNote[] }) {
  const [search, setSearch] = useSearchParams();
  if (!declared.length) return null;
  const set = (name: string, value: string) =>
    setSearch(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === "") next.delete(`${VIEW_INPUT_PARAM}${name}`);
        else next.set(`${VIEW_INPUT_PARAM}${name}`, value);
        return next;
      },
      { replace: true },
    );
  // What the person typed shows while they type; the server's bounded value
  // shows when the URL has none.
  const shown = (i: ViewInput) => search.get(`${VIEW_INPUT_PARAM}${i.name}`) ?? String(values[i.name] ?? "");
  return (
    <div className="space-y-1.5" data-testid="view-inputs">
      <div className="flex flex-wrap items-end gap-3">
        {declared.map((i) => (
          <label key={i.name} className="flex flex-col gap-1 text-xs text-muted dark:text-slate-400">
            <span>{i.label}</span>
            {i.type === "choice" ? (
              <select className="input min-w-[8rem]" data-testid={`view-input-${i.name}`} value={shown(i)} onChange={(e) => set(i.name, e.target.value)}>
                {(i.choices ?? []).map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input w-28"
                data-testid={`view-input-${i.name}`}
                type={i.type === "date" ? "date" : "text"}
                inputMode={i.type === "number" ? "decimal" : undefined}
                value={shown(i)}
                placeholder={i.type === "number" && i.min !== undefined && i.max !== undefined ? `${i.min} to ${i.max}` : undefined}
                onChange={(e) => set(i.name, e.target.value)}
              />
            )}
          </label>
        ))}
      </div>
      {notes.length > 0 && (
        <div role="status" className="text-xs text-amber-700 dark:text-amber-300" data-testid="view-input-notes">
          {notes.map((n) => (
            <p key={n.name}>{n.message}</p>
          ))}
        </div>
      )}
    </div>
  );
}
