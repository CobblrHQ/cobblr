// Codes management — find an item by its code, rename a list's prefix, and pick
// what a kind's codes group by. Opened from the Labels page. See
// docs/design-decisions/label-codes.md.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useToast } from "@cobblr/platform-web";
import { useLabels } from "./context";
import type { CodeGroup } from "./api";

const CARD = "flex items-center gap-2 rounded-lg border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 px-3 py-2";
const BTN = "rounded-md bg-slate-700 hover:bg-slate-600 text-mortar-50 text-xs font-medium px-2.5 py-1 transition disabled:opacity-40";

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

  const kinds = [...new Set((groups.data ?? []).map((g) => g.entity_kind))];

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
          placeholder="Find an item by its code — e.g. m1"
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
        <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-2">code prefixes</div>
        {groups.isLoading ? (
          <p className="text-sm text-muted dark:text-slate-400">Loading…</p>
        ) : (groups.data ?? []).length === 0 ? (
          <p className="text-sm text-muted dark:text-slate-400">
            No codes yet — print a label and its list gets a prefix automatically.
          </p>
        ) : (
          <div className="space-y-2">
            {(groups.data ?? []).map((g) => (
              <PrefixRow key={g.group_key} group={g} onRename={(prefix) => rename.mutate({ groupKey: g.group_key, prefix })} pending={rename.isPending} />
            ))}
          </div>
        )}
      </div>

      {kinds.length > 0 && (
        <div>
          <div className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 mb-2">grouping &amp; QR center</div>
          <p className="text-[11px] text-muted dark:text-slate-400 mb-2">
            Which field a kind's codes count by. <span className="font-mono">instance</span> gives each list its own line; try{" "}
            <span className="font-mono">category</span> to split one list by category. Only affects new codes. The{" "}
            <span className="font-medium">Code in QR center</span> switch decides whether the code is drawn inside the QR for
            that kind — turn it off for singular kinds (e.g. one Office) where the code adds nothing.
          </p>
          <div className="space-y-2">
            {kinds.map((k) => (
              <GroupByRow key={k} kind={k} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PrefixRow({ group, onRename, pending }: { group: CodeGroup; onRename: (prefix: string) => void; pending: boolean }) {
  const [val, setVal] = useState(group.prefix);
  const norm = val.trim().toLowerCase();
  const dirty = norm !== group.prefix && norm.length > 0;
  return (
    <div className={CARD}>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-content dark:text-mortar-100 truncate">{group.label ?? group.entity_kind}</div>
        <div className="text-[11px] font-mono text-faint dark:text-slate-500 truncate">
          {group.entity_kind} · {group.count} code{group.count === 1 ? "" : "s"}
        </div>
      </div>
      {group.frozen ? (
        <span
          className="text-xs font-mono px-2 py-1 rounded bg-subtle dark:bg-slate-800 text-muted dark:text-slate-400"
          title="Labels have already printed under this prefix, so it can't change. New groups can still be renamed before their first print."
        >
          {group.prefix} 🔒
        </span>
      ) : (
        <>
          <input
            value={val}
            onChange={(e) => setVal(e.target.value)}
            className="input !w-20 !py-1 text-sm font-mono text-center"
            maxLength={4}
          />
          <button className={BTN} disabled={!dirty || pending} onClick={() => onRename(norm)}>
            Save
          </button>
        </>
      )}
    </div>
  );
}

function GroupByRow({ kind }: { kind: string }) {
  const { api } = useLabels();
  const toast = useToast();
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ["labels-code-config", kind], queryFn: () => api.getCodeConfig(kind) });
  const [field, setField] = useState("");
  const current = field || cfg.data?.group_field || "instance";
  const overlayCenter = cfg.data?.overlay_center ?? true;
  const save = useMutation({
    mutationFn: (patch: { group_field?: string; overlay_center?: boolean }) => api.setCodeConfig(kind, patch),
    onSuccess: (_r, patch) => {
      toast.success(
        patch.overlay_center !== undefined
          ? patch.overlay_center
            ? "Code will show in the QR center — applies on the next print."
            : "Code hidden from the QR center — applies on the next print."
          : "Grouping updated — applies to new codes.",
      );
      void qc.invalidateQueries({ queryKey: ["labels-code-config", kind] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className={`${CARD} flex-wrap`}>
      <div className="flex-1 min-w-0 text-sm text-content dark:text-mortar-100 truncate">{kind}</div>
      <input
        value={current}
        onChange={(e) => setField(e.target.value)}
        className="input !w-40 !py-1 text-sm font-mono"
        placeholder="instance"
      />
      <button className={BTN} disabled={save.isPending || !current.trim()} onClick={() => save.mutate({ group_field: current.trim() || "instance" })}>
        Set
      </button>
      <button
        type="button"
        role="switch"
        aria-checked={overlayCenter}
        aria-label={`Show code in QR center for ${kind}`}
        disabled={save.isPending || cfg.isLoading}
        onClick={() => save.mutate({ overlay_center: !overlayCenter })}
        title="Draw the human-readable code inside the QR. Turn off for singular kinds (e.g. one Office) where the code adds nothing."
        className="inline-flex items-center gap-1.5 rounded-md border border-line dark:border-slate-600 px-2 py-1 text-[11px] text-muted dark:text-slate-400 hover:border-accent transition disabled:opacity-40"
      >
        <span className="whitespace-nowrap">Code in QR center</span>
        <span
          className={
            "inline-block h-3 w-6 rounded-full relative transition-colors " +
            (overlayCenter ? "bg-cobble-600" : "bg-slate-300 dark:bg-slate-600")
          }
        >
          <span
            className={
              "absolute top-[1px] h-2.5 w-2.5 rounded-full bg-white transition-all " +
              (overlayCenter ? "left-[13px]" : "left-[1px]")
            }
          />
        </span>
      </button>
    </div>
  );
}
