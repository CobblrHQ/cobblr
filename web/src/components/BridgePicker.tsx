// Standardized edge-bridge picker — lists the workspace's connected bridges
// (default + named) with live online status and lets you pick one. Shared by any
// feature that routes over an edge bridge (sync connectors, digifab machines, …)
// so the experience is identical everywhere — not reinvented per module.
//
// value: the chosen bridge id, or null = the workspace's DEFAULT (no-id) bridge.
// null is a CHOICE, not "nothing picked": read it through bridgeChosen
// (lib/bridge-choice.ts) so a form never greys out on the default (#3904).
// A bridge that is not installed yet is chosen by the name it will be given.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type EdgeBridge } from "../lib/api";
import { bridgeDisplayName } from "../lib/bridge-choice";

const NOT_YET = "__not_yet__";
const DEFAULT = "__default__";

function statusOf(b: EdgeBridge | undefined): { dot: string; text: string } {
  if (!b) return { dot: "bg-slate-400/60", text: "not connected yet" };
  return b.connected
    ? { dot: "bg-emerald-500", text: "online" }
    : { dot: "bg-slate-400/60", text: "offline" };
}

/**
 * Which bridge a connection goes through, said the way a person would.
 *
 * - No bridge in this workspace: one line, "No bridge yet", and the way to
 *   set one up. Nothing to pick.
 * - One bridge (most people): no picker at all. It is chosen for you and the
 *   line says so, by its name and whether it is online.
 * - Several: pick one by name. An id is never shown; a bridge that is not
 *   installed yet is chosen by the name you will give it.
 *
 * `value` is the bridge's channel id, null for the workspace's first bridge
 * (a real choice; see bridgeChosen).
 */
export function BridgePicker({
  slug,
  value,
  onChange,
}: {
  slug: string;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const q = useQuery({
    queryKey: ["edge-bridges", slug],
    queryFn: () => api.listEdgeBridges(slug),
    enabled: !!slug,
    refetchInterval: 8000, // keep the online dot fresh
  });
  const bridges = q.data?.bridges ?? [];
  const only = bridges.length === 1 ? bridges[0]! : null;

  // One bridge: it is the choice. Said once, never asked.
  useEffect(() => {
    if (only && value !== only.bridge) onChange(only.bridge);
  }, [only, value, onChange]);

  const known = value === null ? bridges.some((b) => b.bridge === null) || bridges.length === 0 : bridges.some((b) => b.bridge === value);
  const [notYet, setNotYet] = useState(!known && value !== null);

  if (q.isLoading) return <div className="text-[11px] text-faint">Checking your bridges…</div>;

  if (bridges.length === 0) {
    return (
      <div data-testid="bridge-none" className="flex items-center gap-1.5 text-[11px] text-muted dark:text-slate-400">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-400/60" />
        No bridge yet.{" "}
        <Link to="/configuration/devices" className="underline text-accent">
          Set one up
        </Link>
      </div>
    );
  }

  if (only) {
    const st = statusOf(only);
    return (
      <div data-testid="bridge-only" className="flex items-center gap-1.5 text-[11px] text-muted dark:text-slate-400">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${st.dot}`} />
        Through <strong className="font-medium text-content dark:text-mortar-100">{bridgeDisplayName(only)}</strong> · {st.text}
      </div>
    );
  }

  const selected = bridges.find((b) => b.bridge === value);
  const st = statusOf(selected);
  return (
    <div className="space-y-1.5">
      <select
        value={notYet ? NOT_YET : value ?? DEFAULT}
        onChange={(e) => {
          const v = e.target.value;
          if (v === NOT_YET) {
            setNotYet(true);
            onChange(value && !bridges.some((b) => b.bridge === value) ? value : "");
          } else {
            setNotYet(false);
            onChange(v === DEFAULT ? null : v);
          }
        }}
        className="input"
        aria-label="Which bridge"
      >
        {bridges.map((b) => (
          <option key={b.bridge ?? DEFAULT} value={b.bridge ?? DEFAULT}>
            {bridgeDisplayName(b)} · {b.connected ? "online" : "offline"}
          </option>
        ))}
        <option value={NOT_YET}>A bridge I haven't installed yet…</option>
      </select>

      {notYet && (
        <input
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="the name you will give it when you install it"
          className="input"
        />
      )}

      <div className="flex items-center gap-1.5 text-[10px] text-faint dark:text-slate-500">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${st.dot}`} />
        {notYet
          ? value
            ? `"${value}" joins as soon as it is installed and online.`
            : "Name it the same when you install it."
          : `${selected ? bridgeDisplayName(selected) : "That bridge"} · ${st.text}`}
      </div>
    </div>
  );
}
