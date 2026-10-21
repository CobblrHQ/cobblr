import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, useLocation } from "react-router-dom";
import { MoreHorizontal } from "lucide-react";
import { PopoverLayer, useEscapeToClose } from "@cobblr/platform-web";
import { joinNavRow, splitNavRow } from "../lib/nav-order";
import { navTargetFor, stripNavStem } from "./useNavModules";

export type RowCollection = { name: string; displayName: string };
export type RowOverflow = { name: string; label: string; to: string };
export function NavRowMenu({ slug, label, members, candidates, overflow = [], onNavigate, className = "" }: { className?: string; slug: string; label: string; members: RowCollection[]; candidates: RowCollection[]; overflow?: RowOverflow[]; onNavigate?: () => void }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [joining, setJoining] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEscapeToClose(!!pos, panel, () => setPos(null));
  useEffect(() => {
    if (!pos) return;
    const dismiss = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) setPos(null); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [pos]);
  const choices = candidates.filter((c) => !members.some((m) => m.name === c.name));
  return <>
    <button title={`Arrange ${label}`} ref={trigger} type="button" aria-label={`Arrange ${label}`} aria-expanded={!!pos} className={"shrink-0 p-1 text-muted dark:text-slate-400 hover:text-accent " + className} onClick={() => {
      const rect = trigger.current?.getBoundingClientRect();
      setJoining(false);
      setPos(pos || !rect ? null : { left: rect.left, top: rect.bottom });
    }}><MoreHorizontal size={14} /></button>
    {pos && createPortal(<PopoverLayer ref={panel} role="menu" aria-label={`Arrange ${label}`} style={pos} className="w-52 rounded-md border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 shadow-lg py-1">
      {!joining && overflow.map((o) => <NavLink key={o.name} to={o.to} role="menuitem" onClick={() => { setPos(null); onNavigate?.(); }} className="block w-full whitespace-nowrap px-3 py-2 text-sm text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800">{o.label}</NavLink>)}
      {!joining && overflow.length > 0 && <div role="separator" className="my-1 border-t border-line dark:border-slate-700" />}
      {members.length > 1 && !joining && <button type="button" role="menuitem" className="w-full text-left px-3 py-2 text-sm text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800" onClick={() => { splitNavRow(slug, members.map((m) => m.name)); setPos(null); }}>Split</button>}
      {members.length < 3 && choices.length > 0 && !joining && <button type="button" role="menuitem" className="w-full text-left px-3 py-2 text-sm text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800" onClick={() => setJoining(true)}>Join with…</button>}
      {joining && choices.map((c) => <button key={c.name} type="button" role="menuitem" className="w-full text-left px-3 py-2 text-sm text-content dark:text-mortar-100 hover:bg-subtle dark:hover:bg-slate-800" onClick={() => {
        const names = [...members.map((m) => m.name), c.name];
        joinNavRow(slug, { key: `personal:${names.join(":")}`, label: members.length > 1 ? label : "", members: names });
        setPos(null);
      }}>{c.displayName}</button>)}
    </PopoverLayer>, document.body)}
  </>;
}
/** Which members to leave out, last first and never the active one, so the
 *  rest fit in `room` px; widths[i] is member i with its divider before it. */
export function overflowingMembers(widths: number[], divider: number, room: number, active: number): number[] {
  const shown = widths.map((_, i) => i);
  const need = () => shown.reduce((sum, i, at) => sum + (widths[i] ?? 0) - (at === 0 ? divider : 0), 0);
  const left: number[] = [];
  for (let i = widths.length - 1; i >= 0 && shown.length > 1 && need() > room + 0.5; i--) {
    if (i === active) continue;
    shown.splice(shown.indexOf(i), 1);
    left.unshift(i);
  }
  return left;
}
export function NavSplitRow({ slug, group, candidates, appMode = false, onNavigate, handle = {} }: { slug: string; group: { label: string; members: RowCollection[] }; candidates: RowCollection[]; appMode?: boolean; onNavigate?: () => void; handle?: Record<string, unknown> }) {
  const label = group.label || "Collections";
  const { pathname } = useLocation();
  const links = useRef<HTMLDivElement>(null);
  const ruler = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<number[]>([]);
  const names = group.members.map((m) => stripNavStem(m.displayName, group.label));
  const key = names.join("\n");
  useLayoutEffect(() => {
    const box = links.current, measure = ruler.current;
    if (!box || !measure) return;
    const fit = () => {
      const widths = [...measure.querySelectorAll<HTMLElement>("[data-member]")].map((el) => el.getBoundingClientRect().width);
      const divider = measure.querySelector<HTMLElement>("[data-divider]")?.getBoundingClientRect().width ?? 0;
      const active = [...box.querySelectorAll("a")].findIndex((a) => a.getAttribute("aria-current") === "page");
      const next = overflowingMembers(widths, divider, box.clientWidth, active);
      setHidden((was) => (was.join() === next.join() ? was : next));
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(fit);
    watch.observe(box);
    return () => watch.disconnect();
  }, [key, pathname]);
  const overflow = group.members.flatMap((mem, i) => (hidden.includes(i) ? [{ name: mem.name, label: names[i] ?? mem.displayName, to: navTargetFor(mem.name, appMode) }] : []));
  const firstShown = group.members.findIndex((_, i) => !hidden.includes(i));
  return <div role="group" aria-label={`${label} navigation row`} className="relative flex min-w-0 items-center rounded border border-line dark:border-slate-700">
    <span {...handle} title={label} className="shrink-0 whitespace-nowrap pl-2 text-[10px] uppercase text-faint dark:text-slate-500">{group.label || "⋮"}</span>
    <div ref={links} className="flex min-w-0 flex-1 items-center justify-end overflow-hidden">
      {group.members.map((mem, i) => <span key={mem.name} className={hidden.includes(i) ? "hidden" : "flex shrink-0 items-center"}>
        {i > firstShown && <span aria-hidden className="text-faint dark:text-slate-500">|</span>}
        <NavLink to={navTargetFor(mem.name, appMode)} aria-label={names[i]} onClick={onNavigate} className={({ isActive }) => "whitespace-nowrap px-1.5 py-2 text-sm transition " + (isActive ? "text-accent font-semibold bg-subtle dark:bg-slate-800" : "text-muted dark:text-slate-400 hover:text-accent")}>{names[i]}</NavLink>
      </span>)}
    </div>
    <div ref={ruler} aria-hidden className="invisible absolute left-0 top-0 flex h-0 w-0 overflow-hidden whitespace-nowrap text-sm font-semibold">
      <span data-divider>|</span>
      {group.members.map((mem, i) => <span key={mem.name} data-member className="flex shrink-0"><span>|</span><span className="px-1.5">{names[i]}</span></span>)}
    </div>
    <NavRowMenu slug={slug} label={label} members={group.members} candidates={candidates} overflow={overflow} onNavigate={onNavigate} />
  </div>;
}
