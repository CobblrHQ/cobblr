// LocationChipPicker — locations as TAPPABLE CHIPS, not a dropdown.
//
// On mobile (the scanner, inbox triage on a phone) a dropdown is the wrong shape:
// you're standing in a room and want to tap it, not open a menu and scroll. This
// is the pattern companion app settled on — a "Rooms" header over a wrap of chips, one tap
// to pick, "+ New" to add — adapted to Cobblr's model where an area IS a location
// (kind="area"), so a chip sets a location id rather than a free-text tag.
//
// Areas (rooms/zones) and bins (containers) read as different things, so they show
// as separate sections. `kind` restricts to one: the camera's "assign a room"
// passes "area" and bins never appear.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin, Package, Plus } from "lucide-react";
import { api, type Location } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { QuickCreateLocation } from "./LocationPicker";

interface Props {
  value: string | null;
  onChange: (value: string | null) => void;
  /** Restrict to one kind. "area" = rooms/zones only (the camera's scan area);
   *  omit to show Rooms + Bins as two sections. */
  kind?: Location["kind"];
  /** Exclude one id (e.g. don't offer a location as its own parent). */
  excludeId?: string;
  className?: string;
}

// siblings: manual drag order (position), then NATURAL name (Bin 2 before Bin 10).
const cmp = (a: Location, b: Location) =>
  a.position - b.position || a.name.localeCompare(b.name, undefined, { numeric: true });

export function LocationChipPicker({ value, onChange, kind, excludeId, className }: Props) {
  const { activeSlug } = useActiveOrg();
  const [createOpen, setCreateOpen] = useState(false);

  const list = useQuery({
    queryKey: ["core-locations", activeSlug],
    queryFn: () => api.listLocations(activeSlug),
    enabled: !!activeSlug,
    staleTime: 60_000,
  });
  const all = (list.data?.items ?? []).filter((l) => l.id !== excludeId);
  const nameOf = (l: Location) => l.short_name?.trim() || l.name;

  const areas = kind === "container" ? [] : all.filter((l) => l.kind === "area").sort(cmp);
  const bins = kind === "area" ? [] : all.filter((l) => l.kind === "container").sort(cmp);

  const Chip = ({ l, icon }: { l: Location; icon: "area" | "bin" }) => {
    const active = value === l.id;
    return (
      <button
        type="button"
        // Tapping the active chip clears it — the same toggle a checkbox gives.
        onClick={() => onChange(active ? null : l.id)}
        className={
          // Theme-aware: this renders on the dark camera overlay AND in the inbox,
          // which follows the workspace light/dark theme.
          "text-sm px-2.5 py-1.5 rounded-full inline-flex items-center gap-1.5 transition " +
          (active
            ? "bg-emerald-500/20 text-emerald-700 ring-1 ring-emerald-500 dark:bg-emerald-500/25 dark:text-emerald-100 dark:ring-emerald-400"
            : "bg-subtle text-content hover:bg-cobble-100 dark:bg-slate-700/60 dark:text-slate-100 dark:hover:bg-slate-600")
        }
      >
        {icon === "area" ? <MapPin size={13} className="shrink-0" /> : <Package size={13} className="shrink-0" />}
        {nameOf(l)}
      </button>
    );
  };

  const Section = ({ title, items, icon }: { title: string; items: Location[]; icon: "area" | "bin" }) =>
    items.length === 0 ? null : (
      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-faint mb-1.5">{title}</div>
        <div className="flex flex-wrap gap-1.5">
          {items.map((l) => (
            <Chip key={l.id} l={l} icon={icon} />
          ))}
        </div>
      </div>
    );

  return (
    <div className={"space-y-3 " + (className ?? "")}>
      {areas.length === 0 && bins.length === 0 && (
        <div className="text-sm text-faint">No locations yet.</div>
      )}
      {/* One header only when both kinds are present, so a rooms-only list doesn't
          get a lone "Rooms" label. */}
      <Section title={bins.length ? "Rooms" : ""} items={areas} icon="area" />
      <Section title={areas.length ? "Bins" : ""} items={bins} icon="bin" />

      <div className="pt-1">
        <button
          type="button"
          onClick={() => setCreateOpen(true)}
          className="text-sm text-accent hover:underline inline-flex items-center gap-1"
        >
          <Plus size={14} /> New location…
        </button>
      </div>

      {createOpen && (
        <QuickCreateLocation
          slug={activeSlug}
          all={list.data?.items ?? []}
          defaultKind={kind}
          onClose={() => setCreateOpen(false)}
          onCreated={(loc) => {
            onChange(loc.id);
            setCreateOpen(false);
          }}
        />
      )}
    </div>
  );
}
