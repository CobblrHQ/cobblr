// Codes management — find an item by its code; per KIND, its instances nested
// inside, each with its own prefix and its own "show the code in the QR" toggle.
// Opened from the Labels page. See docs/design-decisions/label-codes.md.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useToast } from "@cobblr/platform-web";
import { useLabels } from "./context";
import type { CodeGroup } from "./api";

const BTN = "rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-2.5 py-1 transition disabled:opacity-40";
const NESTED = "flex items-center gap-2 rounded-md border border-line/60 dark:border-slate-700/60 bg-subtle/40 dark:bg-slate-800/40 px-2.5 py-1.5";

export function CodesPanel() {
  const { api, orgSlug } = useLabels();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const groups = useQuery({
    queryKey: ["labels-code-groups", orgSlug],
    queryFn: () => api.listCodeGroups().then((r) => r.groups),
  });

  const [q, setQ] = useState("");
  const search = useMutation({
    mutationFn: (code: string) => api.resolveCode(code),
    onSuccess: (hit) => {
      if (hit.detail_url) navigate(hit.detail_url);
      else toast.success(`${hit.code} → ${hit.title ?? hit.entity_kind}`);
    },
    onError: () => toast.error("No item has that code."),
  });

  const rename = useMutation({
    mutationFn: ({ groupKey, prefix }: { groupKey: string; prefix: string }) => api.renameCodePrefix(groupKey, prefix),
    onSuccess: () => {
      toast.success("Prefix updated.");
      void qc.invalidateQueries({ queryKey: ["labels-code-groups"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  // Commit a SUGGESTED list's prefix (create its row) before any print, or opt it
  // out with a blank prefix. Separate from rename because a suggestion has no row
  // to rename yet.
  const seed = useMutation({
    mutationFn: ({ groupKey, prefix }: { groupKey: string; prefix: string }) => api.seedGroup(groupKey, prefix),
    onSuccess: (_r, { prefix }) => {
      toast.success(prefix.trim() ? "Code saved." : "List opted out of a code.");
      void qc.invalidateQueries({ queryKey: ["labels-code-groups"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const overlay = useMutation({
    mutationFn: ({ groupKey, on }: { groupKey: string; on: boolean }) => api.setGroupOverlay(groupKey, on),
    onSuccess: (_r, { on }) => {
      toast.success(on ? "Code will show in the QR — applies on the next print." : "Code hidden from the QR — applies on the next print.");
      void qc.invalidateQueries({ queryKey: ["labels-code-groups"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  // One card per KIND (Machines, Locations, …), each with its instances nested.
  const byKind = useMemo(() => {
    const m = new Map<string, { kindLabel: string; groups: CodeGroup[] }>();
    for (const g of groups.data ?? []) {
      const e = m.get(g.entity_kind) ?? { kindLabel: g.kind_label, groups: [] };
      e.groups.push(g);
      m.set(g.entity_kind, e);
    }
    return [...m.entries()];
  }, [groups.data]);

  const pending = rename.isPending || overlay.isPending;

  return (
    <div className="space-y-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) search.mutate(q.trim());
        }}
        className="flex items-center gap-2"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          // vocab-lint-ok: codes span every kind (parts, machines, locations), so a neutral generic noun is correct here
          placeholder="Find an item by its short code (e.g. m1)"
          className="input flex-1 !py-1.5 text-sm"
          autoFocus
        />
        <button
          type="submit"
          className="rounded-md bg-cobble-600 hover:bg-cobble-500 text-white text-sm font-medium px-3 py-1.5 transition disabled:opacity-40"
          disabled={search.isPending || !q.trim()}
        >
          Go
        </button>
      </form>

      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-1.5">codes by kind</div>
        <p className="text-[11px] text-muted dark:text-slate-400 mb-2.5">
          <span className="font-medium text-content dark:text-mortar-100">Find an item by its short human-readable code</span> (like{" "}
          <span className="font-mono">p1</span>): type it in the box above, no scanning needed. Each list's code starts with a{" "}
          <span className="font-medium">prefix</span> (the <span className="font-mono">p</span> in <span className="font-mono">p1</span>); set it in the small text box on the list's row, or clear that box to give the list no code.{" "}
          <span className="font-medium text-content dark:text-mortar-100">Optionally show that code in the middle of the QR label</span>, per list, with the toggles below.
        </p>
        {groups.isLoading ? (
          <p className="text-sm text-muted dark:text-slate-400">Loading…</p>
        ) : byKind.length === 0 ? (
          <p className="text-sm text-muted dark:text-slate-400">
            No labelable lists yet. Add a machine, part, or location and it shows up here with a suggested code.
          </p>
        ) : (
          <div className="space-y-3">
            {byKind.map(([kind, { kindLabel, groups: kindGroups }]) => (
              <KindCard
                key={kind}
                kindLabel={kindLabel}
                groups={kindGroups}
                onRename={(groupKey, prefix) => {
                  // A suggested list has no row yet: Save COMMITS it (seed). A
                  // committed one renames. Same button, routed by suggested.
                  const g = (groups.data ?? []).find((x) => x.group_key === groupKey);
                  (g?.suggested ? seed : rename).mutate({ groupKey, prefix });
                }}
                onToggleOverlay={(groupKey, on) => overlay.mutate({ groupKey, on })}
                pending={pending}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** A kind (the OUTER level). If it's just itself (no named sub-lists), its
 *  controls sit inline on its own row (so "Location · Code in QR · c"). If it has
 *  named lists (Machine → 3D Printers), it's a header with those lists nested. */
function KindCard({
  kindLabel,
  groups,
  onRename,
  onToggleOverlay,
  pending,
}: {
  kindLabel: string;
  groups: CodeGroup[];
  onRename: (groupKey: string, prefix: string) => void;
  onToggleOverlay: (groupKey: string, on: boolean) => void;
  pending: boolean;
}) {
  // How many items are coded, kept as a hover on the name rather than a label —
  // it's metadata, not what the row IS (the author, 2026-07-22: "what does '1 code' mean").
  const coded = (g: CodeGroup) =>
    g.suggested
      ? "Suggested code, not saved yet. Save to lock it in, change it, or clear the box to skip a code for this list."
      : g.prefix == null
        ? "No code — this list is opted out, so its letter is free for another list."
        : `${g.count} item${g.count === 1 ? "" : "s"} coded so far`;
  // A lone whole-kind group (no named instance) is the kind itself: show its
  // controls inline on the card row rather than a nameless "N codes" child.
  const solo = groups.length === 1 && (!groups[0]!.group_label || groups[0]!.group_label === kindLabel);

  if (solo) {
    const g = groups[0]!;
    return (
      <div className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 flex items-center gap-2 px-3 py-2.5">
        <div className="flex-1 min-w-0 text-sm font-semibold text-content dark:text-mortar-100 truncate" title={coded(g)}>
          {kindLabel}
        </div>
        <GroupControls group={g} name={kindLabel} onRename={(p) => onRename(g.group_key, p)} onToggleOverlay={(on) => onToggleOverlay(g.group_key, on)} pending={pending} />
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900">
      <div className="px-3 py-2 border-b border-line dark:border-slate-700">
        <div className="text-sm font-semibold text-content dark:text-mortar-100 truncate">{kindLabel}</div>
      </div>
      <div className="p-2 space-y-1.5">
        {groups.map((g) => {
          const name = g.group_label && g.group_label !== kindLabel ? g.group_label : "Other";
          return (
            <div key={g.group_key} className={NESTED}>
              <div className="flex-1 min-w-0 text-sm text-content dark:text-mortar-100 truncate" title={coded(g)}>
                {name}
              </div>
              <GroupControls group={g} name={name} onRename={(p) => onRename(g.group_key, p)} onToggleOverlay={(on) => onToggleOverlay(g.group_key, on)} pending={pending} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The right-hand controls for one code group: the per-group QR-center toggle, and
 *  the prefix (a lock once printed, otherwise an editable rename). Shared by the
 *  inline (solo-kind) row and the nested (per-list) rows. */
function GroupControls({
  group,
  name,
  onRename,
  onToggleOverlay,
  pending,
}: {
  group: CodeGroup;
  name: string;
  onRename: (prefix: string) => void;
  onToggleOverlay: (on: boolean) => void;
  pending: boolean;
}) {
  const [val, setVal] = useState(group.prefix ?? "");
  const norm = val.trim().toLowerCase();
  const isSuggested = !!group.suggested;
  const committed = !isSuggested && group.prefix != null; // a saved, real code
  // Save/commit rules: a SUGGESTED list Saves to COMMIT its prefix (or blank to
  // skip a code); a COMMITTED list renames (or blank to remove + free the letter);
  // an opted-out list re-enables when you type one. The QR toggle only means
  // anything once a code is actually committed (there's a row to set it on).
  const willOptOut = norm.length === 0 && (committed || isSuggested);
  const dirty = isSuggested ? norm.length > 0 || willOptOut : (norm.length > 0 && norm !== group.prefix) || willOptOut;
  return (
    <div className="flex items-center gap-2 shrink-0">
      <button
        type="button"
        role="switch"
        aria-checked={committed && group.overlay_center}
        aria-label={`Show the code in the QR for ${name}`}
        disabled={pending || !committed}
        onClick={() => onToggleOverlay(!group.overlay_center)}
        title={
          committed
            ? "Draw this list's human-readable code inside its QR. Turn off where the code adds nothing (a clean QR)."
            : isSuggested
              ? "Save this list's code first, then you can show it in the QR."
              : "This list has no code to draw. Give it a prefix first."
        }
        className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-2 py-1 text-[11px] text-muted dark:text-slate-400 hover:border-accent transition disabled:opacity-40"
      >
        <span className="whitespace-nowrap hidden sm:inline">Code in QR</span>
        <span className={"inline-block h-3 w-6 rounded-full relative transition-colors " + (committed && group.overlay_center ? "bg-cobble-600" : "bg-slate-300 dark:bg-slate-600")}>
          <span className={"absolute top-[1px] h-2.5 w-2.5 rounded-full bg-white transition-all " + (committed && group.overlay_center ? "left-[13px]" : "left-[1px]")} />
        </span>
      </button>

      {group.frozen ? (
        <span
          className="text-xs font-mono px-2 py-1 rounded bg-subtle dark:bg-slate-800 text-muted dark:text-slate-400"
          title="Labels have been printed under this prefix, so it can't change - a sticker out in the world still reads this code."
        >
          {group.prefix} 🔒
        </span>
      ) : (
        <>
          <input
            value={val}
            onChange={(e) => setVal(e.target.value)}
            placeholder={committed || isSuggested ? undefined : "none"}
            title={
              isSuggested
                ? `Suggested code (not saved). Save to lock in ${norm || group.prefix}1, ${norm || group.prefix}2, …, change it, or clear to skip a code here.`
                : norm
                  ? `Codes here read ${norm}1, ${norm}2, … Change it any time before the first print.`
                  : committed
                    ? "Clear this and Save to remove the code for this list (frees the letter for another list)."
                    : "This list has no code. Type a prefix to give it one."
            }
            className={"input !w-16 !py-1 text-sm font-mono text-center " + (isSuggested ? "border-dashed text-muted dark:text-slate-400" : "")}
            maxLength={4}
          />
          <button
            className={BTN}
            disabled={!dirty || pending}
            onClick={() => onRename(norm)}
            title={
              willOptOut
                ? "Skip a code for this list (frees the letter for another list)"
                : isSuggested
                  ? "Save this suggested code so it's locked in"
                  : undefined
            }
          >
            {willOptOut ? (isSuggested ? "Skip" : "Remove") : "Save"}
          </button>
        </>
      )}
    </div>
  );
}
