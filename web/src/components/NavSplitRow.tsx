import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink } from "react-router-dom";
import { MoreHorizontal } from "lucide-react";
import { PopoverLayer, useEscapeToClose } from "@cobblr/platform-web";
import { joinNavRow, splitNavRow } from "../lib/nav-order";
import { navTargetFor, stripNavStem } from "./useNavModules";

export type RowCollection = { name: string; displayName: string };
export function NavRowMenu({ slug, label, members, candidates, className = "" }: { className?: string; slug: string; label: string; members: RowCollection[]; candidates: RowCollection[] }) {
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
export function NavSplitRow({ slug, group, candidates, appMode = false, onNavigate, handle = {} }: { slug: string; group: { label: string; members: RowCollection[] }; candidates: RowCollection[]; appMode?: boolean; onNavigate?: () => void; handle?: Record<string, unknown> }) {
  const label = group.label || "Collections";
  return <div role="group" aria-label={`${label} navigation row`} className="flex min-w-0 items-center rounded border border-line dark:border-slate-700">
    <span {...handle} title={label} className="min-w-0 truncate pl-2 text-[10px] font-mono uppercase text-faint dark:text-slate-500">{group.label || "⋮"}</span>
    {group.members.map((mem, i) => <span key={mem.name} className="flex shrink-0 items-center">
      {i > 0 && <span aria-hidden className="text-faint dark:text-slate-500">|</span>}
      <NavLink to={navTargetFor(mem.name, appMode)} aria-label={stripNavStem(mem.displayName, group.label)} onClick={onNavigate} className={({ isActive }) => "whitespace-nowrap px-1.5 py-2 text-sm transition " + (isActive ? "text-accent font-semibold bg-subtle dark:bg-slate-800" : "text-muted dark:text-slate-400 hover:text-accent")}>{stripNavStem(mem.displayName, group.label)}</NavLink>
    </span>)}
    <NavRowMenu slug={slug} label={label} members={group.members} candidates={candidates} />
  </div>;
}
