// Picker for a `person` field (#3787): anyone on the workspace's People list,
// member or not, plus "Someone else…" to add a name on the spot.
//
// The value is the list entry's id; nobody ever sees it. Members come first
// (they can be told about things), then everyone else, and a person who has
// since left still reads as themselves, marked so, rather than making the
// thing look unowned.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePlatformWeb } from "./context";
import type { PlatformPerson } from "./types";

const ADD = "__add_person__";

function usePeople() {
  const { api, orgSlug } = usePlatformWeb();
  return useQuery({
    queryKey: ["platform-people", orgSlug],
    queryFn: () => api.listPeople!(orgSlug),
    enabled: !!api.listPeople,
    staleTime: 60_000,
  });
}

const nameOf = (p: PlatformPerson) => (p.left ? `${p.name} (left)` : p.name);

/** How a stored person id reads, for a cell at rest. Null while loading or
 *  when the host has no People list; "Someone no longer listed" for an id the
 *  list does not know, never the id itself. */
export function usePersonName(value: unknown, enabled: boolean): string | null {
  const { api, orgSlug } = usePlatformWeb();
  const people = useQuery({
    queryKey: ["platform-people", orgSlug],
    queryFn: () => api.listPeople!(orgSlug),
    enabled: enabled && !!api.listPeople,
    staleTime: 60_000,
  });
  if (!enabled || value == null || value === "") return null;
  const hit = people.data?.items.find((p) => p.id === String(value));
  if (hit) return nameOf(hit);
  return people.isSuccess ? "Someone no longer listed" : null;
}

export function PersonSelect({
  value,
  onChange,
  label,
  className,
}: {
  value: unknown;
  onChange: (v: string | null) => void;
  /** The field's name, for a screen reader and voice control (#5912). */
  label: string;
  className?: string;
}) {
  const { api, orgSlug } = usePlatformWeb();
  const qc = useQueryClient();
  const people = usePeople();
  const current = value == null ? "" : String(value);
  const items = people.data?.items ?? [];
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);

  if (!api.listPeople) {
    const hit = items.find((p) => p.id === current);
    return (
      <div className={"input flex-1 bg-mortar-50/60 dark:bg-slate-800/60 cursor-default " + (className ?? "")}>
        {hit ? nameOf(hit) : <span className="text-faint dark:text-slate-600">—</span>}
      </div>
    );
  }

  const add = async () => {
    const n = name.trim();
    if (!n || !api.addPerson) return;
    setErr(null);
    try {
      const p = await api.addPerson(orgSlug, n);
      await qc.invalidateQueries({ queryKey: ["platform-people", orgSlug] });
      setAdding(false);
      setName("");
      onChange(p.id);
    } catch (e) {
      // Already on the list: pick them rather than refuse.
      const existing = items.find((p) => p.name.toLowerCase() === n.toLowerCase());
      if (existing) {
        setAdding(false);
        setName("");
        onChange(existing.id);
        return;
      }
      setErr(e instanceof Error ? e.message : "Couldn't add them.");
    }
  };

  if (adding) {
    return (
      <span className={"flex items-center gap-1 " + (className ?? "")}>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
            if (e.key === "Escape") setAdding(false);
          }}
          placeholder="Their name"
          aria-label="Their name"
          className="input flex-1 min-w-0"
          data-testid="person-add-name"
        />
        <button type="button" onClick={() => void add()} className="rounded-md border border-line dark:border-slate-700 text-content dark:text-mortar-200 hover:bg-subtle dark:hover:bg-slate-800 text-xs px-2 py-1 transition disabled:opacity-50" data-testid="person-add-save">
          Add
        </button>
        {err && <span className="text-[11px] text-ember-500">{err}</span>}
      </span>
    );
  }

  const members = items.filter((p) => p.member);
  const others = items.filter((p) => !p.member);
  const known = items.some((p) => p.id === current);
  return (
    <select
      aria-label={label}
      value={current}
      onChange={(e) => {
        if (e.target.value === ADD) {
          setAdding(true);
          return;
        }
        onChange(e.target.value === "" ? null : e.target.value);
      }}
      className={"input " + (className ?? "")}
      data-testid="person-select"
    >
      <option value="">Nobody</option>
      {current && !known && <option value={current}>{people.isSuccess ? "Someone no longer listed" : "…"}</option>}
      {members.length > 0 && (
        <optgroup label="Members">
          {members.map((p) => (
            <option key={p.id} value={p.id}>
              {nameOf(p)}
            </option>
          ))}
        </optgroup>
      )}
      {others.length > 0 && (
        <optgroup label="Other people">
          {others.map((p) => (
            <option key={p.id} value={p.id}>
              {nameOf(p)}
            </option>
          ))}
        </optgroup>
      )}
      {api.addPerson && <option value={ADD}>+ Someone else…</option>}
    </select>
  );
}

/** How a stored `member` user id reads at rest: the same promise as
 *  usePersonName, for the older member-only type. */
export function useMemberName(value: unknown, enabled: boolean): string | null {
  const { api, orgSlug } = usePlatformWeb();
  const members = useQuery({
    queryKey: ["platform-members", orgSlug],
    queryFn: () => api.listMembers!(orgSlug),
    enabled: enabled && !!api.listMembers,
    staleTime: 60_000,
  });
  if (!enabled || value == null || value === "") return null;
  const hit = members.data?.items.find((m) => m.user_id === String(value));
  if (hit) return hit.display_name;
  return members.isSuccess ? "Former member" : null;
}
