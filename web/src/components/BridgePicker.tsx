// Standardized edge-bridge picker — lists the workspace's connected bridges
// (default + named) with live online status and lets you pick one. Shared by any
// feature that routes over an edge bridge (sync connectors, digifab machines, …)
// so the experience is identical everywhere — not reinvented per module.
//
// value: the chosen bridge id, or null = the workspace's DEFAULT (no-id) bridge.
// You can also pick "Other id…" to type a bridge that isn't connected yet (e.g.
// you're configuring before starting it).

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type EdgeBridge } from "../lib/api";

const OTHER = "__other__";

function statusOf(b: EdgeBridge | undefined): { dot: string; text: string } {
  if (!b) return { dot: "bg-slate-400/60", text: "not connected" };
  return b.connected
    ? { dot: "bg-emerald-500", text: "online" }
    : { dot: "bg-slate-400/60", text: "offline" };
}

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
  const named = bridges.filter((b) => b.bridge !== null);

  // value matches a known bridge (default or a listed named one)?
  const isDefault = value === null;
  const matchesKnown = isDefault || named.some((b) => b.bridge === value);
  const [other, setOther] = useState(!matchesKnown && !isDefault);

  const selectVal = other ? OTHER : value ?? "";
  const selected = bridges.find((b) => (b.bridge ?? "") === (value ?? ""));
  const st = statusOf(selected);

  return (
    <div className="space-y-1.5">
      <select
        value={selectVal}
        onChange={(e) => {
          const v = e.target.value;
          if (v === OTHER) {
            setOther(true);
            onChange(value && !isDefault ? value : "");
          } else {
            setOther(false);
            onChange(v === "" ? null : v);
          }
        }}
        className="input"
      >
        <option value="">Default bridge{isDefault ? ` · ${st.text}` : ""}</option>
        {named.map((b) => (
          <option key={b.bridge} value={b.bridge!}>
            {b.bridge} · {b.connected ? "online" : "offline"}
          </option>
        ))}
        <option value={OTHER}>Other id…</option>
      </select>

      {other && (
        <input
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="bridge id (must match the bridge's installed BRIDGE_ID)"
          className="input"
        />
      )}

      {/* Live status of the current choice. */}
      <div className="flex items-center gap-1.5 text-[10px] text-faint dark:text-slate-500">
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${st.dot}`} />
        {other && value
          ? `"${value}" — ${selected ? st.text : "not connected yet (it'll attach when the bridge starts)"}`
          : isDefault
            ? `Your main bridge — ${st.text}`
            : `${value} — ${st.text}`}
        {bridges.length === 0 && !q.isLoading && (
          <span className="ml-1 italic">· no bridge is online yet</span>
        )}
      </div>
    </div>
  );
}
