// ⌘K / Ctrl-K command palette (redesign B4): one keystroke to DO or FIND
// anything — actions first (scan, add, build, customize), then live entity
// results from the same cross-module search the header bar uses. The palette
// is additive: the header SearchBar stays for mouse-first discovery.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Camera, ChevronDown, ChevronRight, CornerDownLeft, FileSpreadsheet, FileText, LayoutGrid, Moon, Plus, ScanLine, Search, Sliders, Sun, Table2, Wand2 } from "lucide-react";
import { api } from "../lib/api";
import { scanInboxKeys } from "../lib/scan-inbox-keys";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { useTheme } from "../theme/ThemeContext";
import { useThemeToggle } from "../theme/useThemeToggle";
import { fuzzyMatch } from "../lib/fuzzy";
import { useAppCatalog, useModuleDoor } from "../lib/appCatalog";
import { appsMatching } from "@cobblr/platform-contract/app-catalog";
import { searchFeatures } from "../lib/feature-index";
import { useHostedPanels } from "../lib/useHostedPanels";
import { isFileHit, mergePaletteRows, paletteSectionHeader, PALETTE_RANK, tablesMatching, type PaletteRow, type PaletteTable } from "../lib/paletteRows";
import { tableOtherNames, type NounChoiceDecl } from "@cobblr/platform-contract/kind-label";
import { useLater, OverlayLayer, SnippetText, SearchInput } from "@cobblr/platform-web";
import { SearchIncomplete } from "./SearchIncomplete";
import { openSheetImport } from "../lib/sheet-import";

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
  { id: "import-sheet", label: "Bring your spreadsheet", hint: "Excel, CSV or a Google Sheets link", keywords: "import excel xlsx csv google sheets spreadsheet list migrate", icon: FileSpreadsheet, run: () => openSheetImport() },
  { id: "build", label: "Describe what you have", hint: "AI builds the setup", icon: Wand2, run: (n) => n("/build?mode=workspace") },
  { id: "customize", label: "Customize workspace", hint: "modules · fields · setups", icon: Sliders, run: (n) => n("/configuration") },
];

export function CommandPalette() {
  const later = useLater();
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
    if (open) later.after("focus", 0, () => inputRef.current?.focus());
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
  // What was scanned and not yet filed: in no table, so the table search
  // above cannot find it. Each labelled with where it is headed.
  const waiting = useQuery({
    queryKey: scanInboxKeys.search(activeSlug, debounced),
    queryFn: () => api.listScanInbox(activeSlug, { q: debounced, limit: 8 }),
    enabled: open && !!activeSlug && debounced.length >= 2,
    staleTime: 15_000,
  });
  // Files wait behind one "Files (N)" row until asked for.
  const [filesOpen, setFilesOpen] = useState(false);
  useEffect(() => setFilesOpen(false), [debounced]);

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
  const { apps } = useAppCatalog(open);
  const appHits = useMemo(() => appsMatching(q, apps, 4), [q, apps]);
  const door = useModuleDoor();
  // The person's own tables, by name or by any other word the table offers,
  // so someone who calls them notions finds Supplies. Same reads (and cache)
  // as the navigation.
  const instancesQ = useQuery({ queryKey: ["instances", activeSlug], queryFn: () => api.listInstances(activeSlug!), enabled: open && !!activeSlug, staleTime: 30_000 });
  const overridesQ = useQuery({ queryKey: ["entity-kind-overrides", activeSlug], queryFn: () => api.listOverrides(activeSlug!), enabled: open && !!activeSlug, staleTime: 30_000 });
  const tableHits = useMemo(() => {
    const tables: PaletteTable[] = (instancesQ.data?.items ?? [])
      .filter((i) => !i.is_default)
      .map((i) => {
        const o = (overridesQ.data?.items ?? []).find((x) => x.target_kind === "instance" && x.target_id === `${i.module_name}:${i.instance_name}`);
        const label = o?.display_label ?? i.display_name;
        const noun = ((o?.config ?? {}) as { noun?: NounChoiceDecl | null }).noun;
        return { label, route: `/${i.instance_name}`, otherNames: tableOtherNames(label, noun) };
      });
    return tablesMatching(q, tables);
  }, [q, instancesQ.data, overridesQ.data]);
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
    const tableRows: PaletteRow[] = tableHits.map((t) => ({
      key: `table-${t.route}`,
      kind: "table",
      label: t.label,
      hint: t.hint,
      icon: Table2,
      run: () => { navigate(t.route); close(); },
    }));
    // Every module, on, hidden from the sidebar, or off: one search away
    // whatever its state (#3883). A hidden one also offers its row back; an
    // off one offers to turn it on, or to ask an admin to.
    const appRows: PaletteRow[] = appHits.flatMap((a): PaletteRow[] => {
      const base = { kind: "app" as const, icon: LayoutGrid, dedupeKey: `route:${a.route}` };
      if (a.state === "off") {
        return [
          door.canTurnOn
            ? { ...base, key: `app-on-${a.name}`, label: `Turn on ${a.label}`, hint: "off in this workspace", run: () => { door.turnOn(a); close(); } }
            : { ...base, key: `app-ask-${a.name}`, label: `Ask an admin to turn on ${a.label}`, hint: "off in this workspace", run: () => { door.ask(a); close(); } },
        ];
      }
      const open: PaletteRow = { ...base, key: `app-${a.name}`, label: `Open ${a.label}`, hint: a.state === "hidden" ? "hidden from your sidebar" : "app", run: () => { door.open(a); close(); } };
      if (a.state !== "hidden") return [open];
      return [open, { kind: "app", icon: LayoutGrid, key: `app-show-${a.name}`, label: `Show ${a.label} in the sidebar`, hint: "this device", run: () => door.showInSidebar(a) }];
    });
    const featureRows: PaletteRow[] = [...featureHits, ...panelHits].map((f) => ({
      key: `feature-${f.route}-${f.label}`,
      kind: "feature",
      label: f.label,
      hint: f.hint,
      icon: Sliders,
      dedupeKey: `route:${f.route}`,
      run: () => { navigate(f.route); close(); },
    }));
    const found = debounced.length >= 2 ? hits.data?.items ?? [] : [];
    const hitRow = (h: (typeof found)[number], kind: "entity" | "file"): PaletteRow => ({
      key: `${kind}-${h.kind}-${h.id}`,
      kind,
      label: h.title,
      hint: kind === "file" ? undefined : h.subtitle ?? h.kind,
      ...(h.snippet ? { snippet: h.snippet } : {}),
      icon: kind === "file" ? FileText : Search,
      dedupeKey: `${h.kind}:${h.id}`,
      run: () => { navigate(h.detailUrl ?? `/search?q=${encodeURIComponent(q.trim())}`); close(); },
    });
    // Your things are the records you keep; a file named after one is not it.
    const entityRows = found.filter((h) => !isFileHit(h)).slice(0, 8).map((h) => hitRow(h, "entity"));
    const files = found.filter(isFileHit);
    const fileRows: PaletteRow[] = files.length
      ? [
          {
            key: "files-toggle",
            kind: "files",
            label: `Files (${files.length})`,
            icon: filesOpen ? ChevronDown : ChevronRight,
            // Opens the section in place; the palette stays open.
            run: () => setFilesOpen((v) => !v),
          },
          ...(filesOpen ? files.map((h) => hitRow(h, "file")) : []),
        ]
      : [];
    const inboxRows: PaletteRow[] = (debounced.length >= 2 ? waiting.data?.items ?? [] : []).map((it) => ({
      key: `inbox-${it.id}`,
      kind: "inbox",
      label: it.suggested_name ?? it.barcode_text ?? "Unnamed scan",
      hint: it.resolved_destination?.label ? `→ ${it.resolved_destination.label}` : "not routed yet",
      icon: ScanLine,
      run: () => { navigate(`/scan?item=${encodeURIComponent(it.id)}`); close(); },
    }));
    return mergePaletteRows([
      { rank: PALETTE_RANK.exact, rows: exactRows },
      { rank: PALETTE_RANK.table, rows: tableRows },
      { rank: PALETTE_RANK.entity, rows: entityRows },
      { rank: PALETTE_RANK.inbox, rows: inboxRows },
      { rank: PALETTE_RANK.files, rows: fileRows },
      { rank: PALETTE_RANK.app, rows: appRows },
      { rank: PALETTE_RANK.feature, rows: featureRows },
      { rank: PALETTE_RANK.action, rows: actionRows },
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, tableHits, appHits, door, featureHits, panelHits, exactHits.data, hits.data, waiting.data, filesOpen, debounced, q, navigate]);
  const total = rows.length;

  function runSelected(i: number) {
    rows[i]?.run();
  }

  if (!open || !activeSlug) return null;
  return createPortal(
    <OverlayLayer className="z-[110] bg-black/40 flex items-start justify-center pt-[12vh] px-4" onClick={() => setOpen(false)}>
      <div
        className="w-full max-w-lg rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line dark:border-slate-700 pr-3">
          {/* The palette's own row: no box of its own, the sheet is the box.
              Esc empties it first, then closes the palette. */}
          <SearchInput
            ref={inputRef}
            value={q}
            onChange={(v) => { setQ(v); setSel(0); }}
            placeholder="Do or find anything…"
            aria-label="Do or find anything"
            wrapperClassName="flex-1 min-w-0"
            className="!h-12 !rounded-none !border-0 !bg-transparent"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, total - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              if (e.key === "Enter" && total > 0) { e.preventDefault(); runSelected(sel); }
            }}
          />
          <kbd className="shrink-0 rounded border border-line dark:border-slate-700 px-1.5 py-0.5 text-[10px] font-mono text-faint">esc</kbd>
        </div>
        {debounced.length >= 2 && (hits.data?.kinds_failed?.length ?? 0) > 0 && (
          <div className="px-2 pt-1.5"><SearchIncomplete compact failed={hits.data?.kinds_failed} /></div>
        )}
        <ul className="max-h-80 overflow-y-auto py-1">
          {rows.map((r, i) => {
            const Icon = r.icon;
            // A section header where a section starts. The list is rank-sorted,
            // so sections stay contiguous: your things, the scan inbox, files,
            // pages & settings.
            const header = paletteSectionHeader(r, rows[i - 1], q.trim().length > 0);
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
                    <Icon size={15} className={(r.kind === "entity" || r.kind === "file" || r.kind === "inbox" ? "text-faint" : "text-accent") + " shrink-0"} />
                    <span className="flex-1 min-w-0">
                      <span className="block truncate">{r.label}</span>
                      {r.snippet && (
                        <span className="block truncate text-[11px] text-muted dark:text-slate-400" data-testid="palette-snippet">
                          <SnippetText text={r.snippet} q={q} />
                        </span>
                      )}
                    </span>
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
    </OverlayLayer>,
    document.body,
  );
}
