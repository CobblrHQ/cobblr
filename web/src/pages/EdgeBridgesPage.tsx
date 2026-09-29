// /configuration/edge — the edge-bridge pane of glass. GENERIC by design: a
// bridge is kernel infrastructure (one tunnel from your site), and modules are
// merely its consumers. So this page renders three data-driven sections and
// hardcodes no module anywhere:
//
//   · connected right now  — workspace bridges. The caller's personal agent
//                            (their /me/connections AI relay) is a FOOTNOTE
//                            under the list, named by its connection label —
//                            never a peer row: two rows both titled "main edge
//                            bridge" (workspace + a hardcoded personal title)
//                            read as a duplicate bridge nobody remembers
//                            setting up.
//   · set up a bridge      — mint the token + copy the run command, right here
//   · what can use it      — one card per REGISTERED edge consumer; a consumer
//                            whose module is off renders greyed with Enable, so
//                            enabling e.g. digifab later just attaches it to
//                            the bridge that's already connected.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Activity, Cable, CheckCircle2, ChevronRight, Plug, User, XCircle } from "lucide-react";
import { api, type EdgeBridge } from "../lib/api";
import { bridgeDisplayName } from "../lib/bridge-choice";
import { DriverPackages } from "../features/edge/DriverPackages";
import { useActiveOrg } from "../auth/ActiveOrgContext";
import { changeWorkspaceShape, useConfirm, usePageTitle, useToast } from "@cobblr/platform-web";
import { EdgeBridgeInstall } from "../components/EdgeBridgeInstall";
import { DesktopAppCard, useDesktopApp } from "../components/DesktopAppCard";

export function EdgeBridgesPage({ embedded = false }: { embedded?: boolean } = {}) {
  usePageTitle("Edge bridges");
  const { activeSlug } = useActiveOrg();
  const slug = activeSlug ?? "";
  const toast = useToast();
  const qc = useQueryClient();

  const status = useQuery({
    queryKey: ["edge-status", slug],
    queryFn: () => api.getEdgeStatus(slug),
    enabled: !!slug,
    refetchInterval: 10_000,
  });
  // Direct bridges live on the same endpoint as the tunnel picker's list.
  const directQ = useQuery({
    queryKey: ["edge-bridges", slug],
    queryFn: () => api.listEdgeBridges(slug),
    enabled: !!slug,
    refetchInterval: 30_000,
  });
  const consumers = useQuery({
    queryKey: ["edge-consumers", slug],
    queryFn: () => api.getEdgeConsumers(slug),
    enabled: !!slug,
    staleTime: 30_000,
  });
  const enableMut = useMutation({
    mutationFn: (name: string) => changeWorkspaceShape(qc, slug, () => api.enableModule(slug, name)),
    onSuccess: () => {
      toast.success("Enabled - it can use your bridge now.");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't enable it"),
  });

  const agents = status.data?.agents ?? [];
  const direct = directQ.data?.direct ?? [];
  // Every bridge this workspace has, online or not, by name (#3904).
  const tunnel = directQ.data?.bridges ?? [];
  const hasDesktopApp = !!useDesktopApp().data;
  const personal = status.data?.personal?.connected ?? false;
  const personalBacks = status.data?.personal?.backs ?? [];

  return (
    <div className={embedded ? "space-y-6" : "max-w-3xl mx-auto space-y-6"}>
      <div>
        {!embedded && (
          <h1 className="font-display text-2xl font-extrabold text-content dark:text-mortar-100 page-title flex items-center gap-2">
            <Cable size={22} className="text-accent" /> Edge bridges
          </h1>
        )}
        <p className="text-sm text-muted dark:text-slate-400 mt-1">
          A bridge is a small program on your own network that connects Cobblr to things the cloud can't reach.
          Set one up once - everything that needs your site attaches to it.
        </p>
      </div>

      {/* Connected right now */}
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Activity size={15} className="text-accent" />
          <h2 className="text-sm font-semibold text-content dark:text-mortar-100 flex-1">Connected right now</h2>
          <span className="text-[11px] text-faint dark:text-slate-500">auto-refreshes</span>
        </div>
        {tunnel.length === 0 && direct.length === 0 && !hasDesktopApp ? (
          <>
            <p className="text-sm text-faint dark:text-slate-400">
              No bridge is connected in this workspace. Set one up below - the moment it dials in, it appears here.
            </p>
            {/* The card offers to look for a desktop app on THIS computer, and
                it only looks when asked. So it has to be reachable here too:
                left in the list branch alone it was unreachable in exactly the
                case it matters, a workspace with nothing connected yet. */}
            <ul className="space-y-1.5 mt-2">
              <DesktopAppCard />
            </ul>
          </>
        ) : (
          <ul className="space-y-1.5">
            {tunnel.map((b) => (
              <BridgeRow
                key={b.bridge ?? "first"}
                slug={slug}
                bridge={b}
                agent={agents.find((a) => a.bridge === b.bridge)}
              />
            ))}
            {direct.map((d) => {
              // The honest bit: this says whether COBBLR'S SERVER has reached it.
              // Whether this browser can is a different question — the Labels
              // page talks to a bridge directly — and they really do disagree
              // (a bridge on a tailnet host, a laptop on another network). So
              // the row says which one it is measuring rather than showing a
              // green dot that means one thing here and another there.
              const everOk = !!d.last_ok_at;
              return (
                <li key={d.origin} className="flex items-center gap-3 rounded-lg border border-line dark:border-slate-800 px-3 py-2 text-sm">
                  {everOk
                    ? <CheckCircle2 size={15} className="text-emerald-500 shrink-0" />
                    : <XCircle size={15} className="text-faint shrink-0" />}
                  <span className="font-medium text-content dark:text-mortar-100">{d.label}</span>
                  <span className="text-[10px] uppercase tracking-wider text-muted dark:text-slate-400 border border-line dark:border-slate-700 rounded-full px-2 py-0.5">
                    direct
                  </span>
                  <span className="text-xs text-faint dark:text-slate-400 flex-1 truncate">
                    <span className="font-mono">{d.origin}</span>
                    {" · "}{d.instances} {d.instances === 1 ? "machine" : "machines"}
                    {d.auth === "none" ? " · no token" : d.auth === "mixed" ? " · some machines have no token" : ""}
                    {everOk
                      ? " · Cobblr reached it"
                      : " · Cobblr hasn't reached it yet"}
                  </span>
                  <Link
                    to="/configuration/print"
                    className="text-xs text-accent hover:underline shrink-0"
                  >
                    machines
                  </Link>
                </li>
              );
            })}
            <DesktopAppCard />
          </ul>
        )}
        {/* The caller's personal AI connection is NOT a workspace bridge — it
            follows their account and serves only them. A footnote, not a row:
            as a peer row (previously hardcoded "main edge bridge") it read as
            a duplicate bridge nobody remembered setting up. */}
        {personal && (
          <p className="flex items-start gap-1.5 border-t border-line dark:border-slate-800 pt-2 mt-2 text-xs text-faint dark:text-slate-400">
            <User size={13} className="text-accent shrink-0 mt-0.5" />
            <span>
              Separate from workspace bridges: your personal connection
              {personalBacks.length > 0 ? (
                <> <span className="font-medium text-muted dark:text-slate-300">{personalBacks.join(", ")}</span></>
              ) : null}{" "}
              also reaches this workspace. It follows your account - only you can use it, and it shows only for you. Manage it in{" "}
              <Link to="/me/connections" className="text-accent hover:underline">Your connections</Link>.
            </span>
          </p>
        )}
      </section>

      {/* Set up a bridge — right here, no module required */}
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Plug size={15} className="text-accent" />
          <h2 className="text-sm font-semibold text-content dark:text-mortar-100">Set up a bridge</h2>
        </div>
        <EdgeBridgeInstall slug={slug} />
      </section>

      {/* What can use it — data-driven from the consumer registry */}
      <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-2">
        <h2 className="text-sm font-semibold text-content dark:text-mortar-100">What can use your bridge</h2>
        {(consumers.data?.consumers ?? []).length === 0 ? (
          <p className="text-sm text-faint dark:text-slate-400">Nothing registered yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {(consumers.data?.consumers ?? []).map((c) => (
              <li
                key={`${c.module}:${c.label}`}
                className={
                  "rounded-lg border px-3 py-2.5 " +
                  (c.enabled
                    ? "border-line dark:border-slate-800"
                    : "border-dashed border-line dark:border-slate-800 opacity-70")
                }
              >
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-content dark:text-mortar-100">{c.label}</div>
                    <div className="text-xs text-muted dark:text-slate-400">{c.description}</div>
                  </div>
                  {c.enabled ? (
                    <Link
                      to={c.href}
                      className="shrink-0 inline-flex items-center gap-1 rounded-md border border-line dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-content dark:text-mortar-100 hover:border-accent transition"
                    >
                      Manage <ChevronRight size={12} />
                    </Link>
                  ) : (
                    <button
                      type="button"
                      disabled={enableMut.isPending}
                      onClick={() => enableMut.mutate(c.module)}
                      className="shrink-0 rounded-md bg-cobble-600 hover:bg-cobble-700 disabled:opacity-50 text-white text-xs font-medium px-2.5 py-1"
                    >
                      {enableMut.isPending && enableMut.variables === c.module ? "Enabling…" : "Enable"}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* What a bridge can be TAUGHT, as opposed to which modules attach to it.
          Hidden until one exists — the component decides, so a declaration made
          earlier stays reachable if the bridge later goes away. */}
      <section>
        <DriverPackages slug={slug} hasBridge={agents.length > 0} />
      </section>
    </div>
  );
}

/** One bridge, as a person recognises it: its name (renamable), whether it is
 *  online, and what it runs on. Offline bridges stay listed: a bridge that
 *  stopped is the one somebody comes here looking for. */
function BridgeRow({
  slug,
  bridge,
  agent,
}: {
  slug: string;
  bridge: EdgeBridge;
  agent?: { queued: number; in_flight: number; parked: boolean };
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(bridgeDisplayName(bridge));
  const rename = useMutation({
    mutationFn: () => api.renameEdgeBridge(slug, bridge.bridge, name.trim()),
    onSuccess: () => {
      setEditing(false);
      void qc.invalidateQueries({ queryKey: ["edge-bridges", slug] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't rename it"),
  });
  const confirm = useConfirm();
  const disconnect = useMutation({
    mutationFn: () => api.disconnectEdgeBridge(slug, bridge.bridge),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["edge-bridges", slug] });
      toast.success(
        r.also_cut.length
          ? `Disconnected. ${r.also_cut.join(", ")} used the same key and ${r.also_cut.length === 1 ? "was" : "were"} cut off too.`
          : "Disconnected. Its key no longer works.",
      );
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't disconnect it"),
  });
  const seen = bridge.last_seen ? new Date(bridge.last_seen) : null;
  const ago = seen ? Math.max(0, Math.round((Date.now() - seen.getTime()) / 1000)) : null;
  return (
    <li data-testid="bridge-row" className="flex items-center gap-3 rounded-lg border border-line dark:border-slate-800 px-3 py-2 text-sm">
      {bridge.connected ? <CheckCircle2 size={15} className="text-emerald-500 shrink-0" /> : <XCircle size={15} className="text-red-500 shrink-0" />}
      <span className="flex-1 min-w-0">
        {editing ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) rename.mutate();
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} className="input py-0.5 text-sm" autoFocus aria-label="Bridge name" />
            <button type="submit" disabled={!name.trim() || rename.isPending} className="text-xs text-accent underline">
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)} className="text-xs text-muted">
              Cancel
            </button>
          </form>
        ) : (
          <>
            <span className="font-medium text-content dark:text-mortar-100">{bridgeDisplayName(bridge)}</span>{" "}
            <button type="button" onClick={() => setEditing(true)} className="text-[11px] text-muted underline hover:text-accent">
              Rename
            </button>
            {bridge.can_disconnect && (
              <button
                type="button"
                disabled={disconnect.isPending}
                onClick={async () => {
                  const ok = await confirm({
                    title: `Disconnect ${bridgeDisplayName(bridge)}?`,
                    message:
                      "Its key stops working at once, so it can no longer reach Cobblr or anything through it. To use that machine again, set it up as a new bridge.",
                    confirmLabel: "Disconnect",
                    destructive: true,
                  });
                  if (ok) disconnect.mutate();
                }}
                className="ml-2 text-[11px] text-muted underline hover:text-ember-600"
              >
                Disconnect
              </button>
            )}
          </>
        )}
        <span className="block text-xs text-faint dark:text-slate-400">
          {bridge.connected
            ? `online · heard from ${ago ?? 0}s ago`
            : seen
              ? `offline since ${seen.toLocaleString()}`
              : "offline"}
          {agent && agent.queued > 0 ? ` · ${agent.queued} queued` : ""}
          {bridge.hostname ? ` · on ${bridge.hostname}` : ""}
          {bridge.version ? ` · version ${bridge.version}` : ""}
        </span>
        <span data-testid="bridge-reach" className="block text-xs text-faint dark:text-slate-400">
          {bridge.allowlist?.length
            ? `Reaches only ${bridge.allowlist.join(", ")} (set on the bridge)`
            : "Reaches the addresses you add in Cobblr"}
        </span>
      </span>
    </li>
  );
}
