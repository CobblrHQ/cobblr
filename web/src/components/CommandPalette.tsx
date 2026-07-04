// ⌘K / Ctrl-K command palette (redesign B4): one keystroke to DO or FIND
// anything — actions first (scan, add, build, customize), then live entity
// results from the same cross-module search the header bar uses. The palette
// is additive: the header SearchBar stays for mouse-first discovery.
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Camera, CornerDownLeft, Moon, Plus, ScanLine, Search, Sliders, Sun, Wand2 } from "lucide-react";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useTheme } from "../theme/ThemeContext";
import { fuzzyMatch } from "../lib/fuzzy";
import { searchFeatures } from "../lib/feature-index";

/** Anything (the mobile bar, the palette) can ask for the quick-add sheet. */
export const OPEN_ADD_SHEET_EVENT = "cobblr:open-add-sheet";
/** Programmatic opener (the full-sidebar foot's search button uses it — a
 *  centered palette beats a cramped popover anchored in a 208px column). */
export const OPEN_PALETTE_EVENT = "cobblr:open-palette";

interface ActionRow {
  id: string;
  label: string;
  hint?: string;
  /** Extra match terms not shown in the row — e.g. the theme toggle answers to
   *  "dark", "light", "night" whichever way it's currently set. */
  keywords?: string;
  icon: typeof Camera;
  run: (navigate: ReturnType<typeof useNavigate>) => void;
}

const ACTIONS: ActionRow[] = [
  { id: "scan", label: "Scan something", hint: "camera → barcode/photo", icon: Camera, run: (n) => n("/scan/camera") },
  { id: "add", label: "Add a thing", hint: "type it, we file it", icon: Plus, run: () => window.dispatchEvent(new CustomEvent(OPEN_ADD_SHEET_EVENT)) },
  { id: "inbox", label: "Open the scan inbox", hint: "review + file captures", icon: ScanLine, run: (n) => n("/scan") },
  { id: "build", label: "Describe what you have", hint: "AI builds the setup", icon: Wand2, run: (n) => n("/build?mode=workspace") },
  { id: "customize", label: "Customize workspace", hint: "modules · fields · setups", icon: Sliders, run: (n) => n("/configuration") },
];

export function CommandPalette() {
  const { activeSlug } = useActiveOrg();
  const { theme, toggle: toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQ("");
        setSel(0);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    const onOpenEvt = () => setOpen(true);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenEvt);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenEvt);
    };
  }, []);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const hits = useQuery({
    queryKey: ["palette-search", activeSlug, debounced],
    queryFn: () => api.search(activeSlug, debounced),
    enabled: open && !!activeSlug && debounced.length >= 2,
    staleTime: 15_000,
  });

  // Preference actions live here (not in the static ACTIONS) because they flip
  // app state instead of navigating — and they need the live theme. Shown in
  // the default list too, so dark mode is DISCOVERABLE, not just findable: the author
  // couldn't locate the toggle (it's in the account menu, and the sidebar icon
  // is hidden on skinned workspaces). Keywords answer to "dark"/"light"/"night"
  // regardless of the current setting.
  const prefActions = useMemo<ActionRow[]>(
    () => [
      {
        id: "theme",
        label: theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
        hint: "theme",
        keywords: "dark light night mode theme color scheme appearance display",
        icon: theme === "dark" ? Sun : Moon,
        run: () => toggleTheme(),
      },
    ],
    [theme, toggleTheme],
  );
  const allActions = useMemo(() => [...ACTIONS, ...prefActions], [prefActions]);
  const actions = useMemo(
    () =>
      q.trim()
        ? allActions.filter((a) => fuzzyMatch(`${a.label} ${a.hint ?? ""} ${a.keywords ?? ""}`, q.trim().toLowerCase()))
        : allActions,
    [q, allActions],
  );
  const featureHits = useMemo(() => searchFeatures(q, 6), [q]);
  const entityHits = (debounced.length >= 2 ? hits.data?.items ?? [] : []).slice(0, 8);
  const total = actions.length + featureHits.length + entityHits.length;

  function runSelected(i: number) {
    if (i < actions.length) actions[i]!.run(navigate);
    else if (i < actions.length + featureHits.length) navigate(featureHits[i - actions.length]!.route);
    else {
      const h = entityHits[i - actions.length - featureHits.length];
      if (h) navigate(h.detailUrl ?? `/search?q=${encodeURIComponent(q.trim())}`);
    }
    setOpen(false);
  }

  if (!open || !activeSlug) return null;
  return createPortal(
    <div className="fixed inset-0 z-[110] bg-black/40 flex items-start justify-center pt-[12vh] px-4" onClick={() => setOpen(false)}>
      <div
        className="w-full max-w-lg rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line dark:border-slate-700 px-3">
          <Search size={15} className="text-faint shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setSel(0); }}
            placeholder="Do or find anything…"
            className="w-full bg-transparent py-3 text-sm text-content dark:text-mortar-100 outline-none"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, total - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              if (e.key === "Enter" && total > 0) { e.preventDefault(); runSelected(sel); }
            }}
          />
          <kbd className="shrink-0 rounded border border-line dark:border-slate-700 px-1.5 py-0.5 text-[10px] font-mono text-faint">esc</kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto py-1">
          {actions.map((a, i) => (
            <li key={a.id}>
              <button
                type="button"
                onMouseEnter={() => setSel(i)}
                onClick={() => runSelected(i)}
                className={"w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition " + (sel === i ? "bg-subtle dark:bg-slate-800 text-content dark:text-mortar-100" : "text-content dark:text-mortar-200")}
              >
                <a.icon size={15} className="text-accent shrink-0" />
                <span className="flex-1 min-w-0 truncate">{a.label}</span>
                {a.hint && <span className="text-[11px] text-faint dark:text-slate-500 shrink-0">{a.hint}</span>}
                {sel === i && <CornerDownLeft size={13} className="text-faint shrink-0" />}
              </button>
            </li>
          ))}
          {featureHits.length > 0 && (
            <li className="px-3 pt-2 pb-1 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">features &amp; settings</li>
          )}
          {featureHits.map((f, j) => {
            const i = actions.length + j;
            return (
              <li key={`feat-${f.route}-${f.label}`}>
                <button
                  type="button"
                  onMouseEnter={() => setSel(i)}
                  onClick={() => runSelected(i)}
                  className={"w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition " + (sel === i ? "bg-subtle dark:bg-slate-800 text-content dark:text-mortar-100" : "text-content dark:text-mortar-200")}
                >
                  <Sliders size={13} className="text-accent shrink-0" />
                  <span className="flex-1 min-w-0 truncate">{f.label}</span>
                  <span className="text-[11px] text-faint dark:text-slate-500 shrink-0">{f.hint}</span>
                </button>
              </li>
            );
          })}
          {entityHits.length > 0 && (
            <li className="px-3 pt-2 pb-1 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">your things</li>
          )}
          {entityHits.map((h, j) => {
            const i = actions.length + featureHits.length + j;
            return (
              <li key={`${h.kind}-${h.id}`}>
                <button
                  type="button"
                  onMouseEnter={() => setSel(i)}
                  onClick={() => runSelected(i)}
                  className={"w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition " + (sel === i ? "bg-subtle dark:bg-slate-800 text-content dark:text-mortar-100" : "text-content dark:text-mortar-200")}
                >
                  <Search size={13} className="text-faint shrink-0" />
                  <span className="flex-1 min-w-0 truncate">{h.title}</span>
                  <span className="text-[11px] text-faint dark:text-slate-500 shrink-0">{h.subtitle ?? h.kind}</span>
                </button>
              </li>
            );
          })}
          {total === 0 && <li className="px-3 py-4 text-sm text-faint dark:text-slate-500">Nothing matches.</li>}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
