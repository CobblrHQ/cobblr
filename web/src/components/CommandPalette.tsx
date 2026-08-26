// ⌘K / Ctrl-K command palette (redesign B4): one keystroke to DO or FIND
// anything — actions first (scan, add, build, customize), then live entity
// results from the same cross-module search the header bar uses. The palette
// is additive: the header SearchBar stays for mouse-first discovery.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Camera, CornerDownLeft, Moon, Plus, ScanLine, Search, Sliders, Sun, Wand2 } from "lucide-react";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useTheme } from "../theme/ThemeContext";
import { useThemeToggle } from "../theme/useThemeToggle";
import { fuzzyMatch } from "../lib/fuzzy";
import { searchFeatures } from "../lib/feature-index";
import { useHostedPanels } from "../lib/useHostedPanels";
import { mergePaletteRows, PALETTE_RANK, type PaletteRow, type PaletteRowKind } from "../lib/paletteRows";
import { OverlayFlag } from "@cobblr/platform-web";

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

/** Header shown above each kind-group. `action` has none — commands lead the
 *  list without a label, as they did before the merge. */
const SECTION_HEADER: Record<PaletteRowKind, string | null> = {
  exact: "best match",
  action: null,
  feature: "features & settings",
  entity: "your things",
};

export function CommandPalette() {
  const { activeSlug } = useActiveOrg();
  const { theme } = useTheme();
  const toggleTheme = useThemeToggle();
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
  // Hosted panels (billing + managed connectors) are RUNTIME data from the
  // overlay, so they can't join the static feature index — merged here instead.
  // Label-only matching: the overlay sends no description; open core renders
  // none of these, so a self-hosted palette is unchanged.
  const { panels } = useHostedPanels();
  const panelHits = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return panels
      .filter((p) => p.label.toLowerCase().includes(needle))
      .slice(0, 3)
      .map((p) => ({
        label: p.label,
        hint: "Cloud",
        route: `/configuration/x/${p.id}`,
        keywords: p.label.toLowerCase(),
      }));
  }, [q, panels]);

  // Exact identifier + token hits (surface: "palette"): typing a part's serial
  // surfaces that part ABOVE fuzzy name matches. Same registry the scanner uses.
  const exactHits = useQuery({
    queryKey: ["palette-resolve", activeSlug, debounced],
    queryFn: () => api.resolveOnSurface(activeSlug!, debounced, "palette"),
    enabled: open && !!activeSlug && debounced.length >= 2,
    staleTime: 15_000,
  });
  const exactCandidates =
    exactHits.data?.outcome === "resolved"
      ? [exactHits.data.candidate]
      : exactHits.data?.outcome === "ambiguous"
        ? exactHits.data.candidates
        : [];

  // One merged, rank-ordered list — the index arithmetic is gone. Each source
  // contributes rows with a rank; mergePaletteRows sorts + dedupes (a fuzzy hit
  // for an entity already shown as an exact hit is dropped). See paletteRows.ts.
  const rows = useMemo<PaletteRow[]>(() => {
    const close = () => setOpen(false);
    const exactRows: PaletteRow[] = exactCandidates.map((c) => ({
      key: `exact-${c.entity_kind}-${c.entity_id}`,
      kind: "exact",
      label: c.label,
      hint: c.sublabel ?? c.entity_kind,
      icon: Search,
      dedupeKey: `${c.entity_kind}:${c.entity_id}`,
      run: () => { navigate(c.detail_path); close(); },
    }));
    const actionRows: PaletteRow[] = actions.map((a) => ({
      key: `action-${a.id}`,
      kind: "action",
      label: a.label,
      hint: a.hint,
      icon: a.icon,
      run: () => { a.run(navigate); close(); },
    }));
    const featureRows: PaletteRow[] = [...featureHits, ...panelHits].map((f) => ({
      key: `feature-${f.route}-${f.label}`,
      kind: "feature",
      label: f.label,
      hint: f.hint,
      icon: Sliders,
      run: () => { navigate(f.route); close(); },
    }));
    const entityRows: PaletteRow[] = (debounced.length >= 2 ? hits.data?.items ?? [] : [])
      .slice(0, 8)
      .map((h) => ({
        key: `entity-${h.kind}-${h.id}`,
        kind: "entity",
        label: h.title,
        hint: h.subtitle ?? h.kind,
        icon: Search,
        dedupeKey: `${h.kind}:${h.id}`,
        run: () => { navigate(h.detailUrl ?? `/search?q=${encodeURIComponent(q.trim())}`); close(); },
      }));
    return mergePaletteRows([
      { rank: PALETTE_RANK.exact, rows: exactRows },
      { rank: PALETTE_RANK.action, rows: actionRows },
      { rank: PALETTE_RANK.feature, rows: featureRows },
      { rank: PALETTE_RANK.entity, rows: entityRows },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, featureHits, panelHits, exactHits.data, hits.data, debounced, q, navigate]);
  const total = rows.length;

  function runSelected(i: number) {
    rows[i]?.run();
  }

  if (!open || !activeSlug) return null;
  return createPortal(
    <div className="fixed inset-0 z-[110] bg-black/40 flex items-start justify-center pt-[12vh] px-4" onClick={() => setOpen(false)}>
      <OverlayFlag />
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
          {rows.map((r, i) => {
            const Icon = r.icon;
            // A section header when the kind-group changes — the list is
            // rank-sorted, so kinds stay contiguous (an exact hit leads, then
            // commands, features, your things). No index arithmetic.
            const header = i === 0 || rows[i - 1]!.kind !== r.kind ? SECTION_HEADER[r.kind] : null;
            return (
              <Fragment key={r.key}>
                {header && (
                  <li className="px-3 pt-2 pb-1 text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">
                    {header}
                  </li>
                )}
                <li>
                  <button
                    type="button"
                    onMouseEnter={() => setSel(i)}
                    onClick={() => runSelected(i)}
                    className={"w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition " + (sel === i ? "bg-subtle dark:bg-slate-800 text-content dark:text-mortar-100" : "text-content dark:text-mortar-200")}
                  >
                    <Icon size={15} className={(r.kind === "entity" ? "text-faint" : "text-accent") + " shrink-0"} />
                    <span className="flex-1 min-w-0 truncate">{r.label}</span>
                    {r.hint && <span className="text-[11px] text-faint dark:text-slate-500 shrink-0">{r.hint}</span>}
                    {sel === i && <CornerDownLeft size={13} className="text-faint shrink-0" />}
                  </button>
                </li>
              </Fragment>
            );
          })}
          {total === 0 && <li className="px-3 py-4 text-sm text-faint dark:text-slate-500">Nothing matches.</li>}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
