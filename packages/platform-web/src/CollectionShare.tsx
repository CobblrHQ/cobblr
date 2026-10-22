import { useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { currentTickedRows } from "./ticked-rows";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Share2 } from "lucide-react";
import { useFlowHost, usePlatformWeb } from "./context";
import { headerButton } from "./CollectionHeader";
import { BackdropLayer, PopoverLayer } from "./fixed-layers";
import { useEscapeToClose } from "./useEscapeToClose";

export function CollectionShare({ kind, title, ids, selectionList }: { kind: string; title: ReactNode; ids?: readonly string[]; selectionList?: string }) {
  const { pathname, search } = useLocation();
  const { api, orgSlug } = usePlatformWeb();
  const { openFlow } = useFlowHost();
  const shares = useQuery({ queryKey: ["record-shares", orgSlug, kind], queryFn: () => api.recordShares!(orgSlug, kind), enabled: !!api.recordShares });
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = () => { setAnchor(null); trigger.current?.focus(); };
  useEscapeToClose(!!anchor, menu, close);
  const open = () => { close(); openFlow("platform:share-list", { kind, ids: [...(ids ?? currentTickedRows(pathname, search, selectionList))], title: typeof title === "string" ? title : "this list" }); };
  const people = shares.data?.shared_with ?? [];
  // Drawn while the answer comes, and pressable once it has: arriving late at
  // the end of the header's row, it pushed Group by along under a finger
  // (#7781). Only a workspace that may not be shared onward takes it away.
  if (shares.data?.can_share === false) return null;
  const asking = shares.isLoading;
  return <>
    <button type="button" data-testid="collection-share" disabled={asking} className={`${headerButton()} max-sm:hidden disabled:opacity-60`} onClick={open}><Share2 size={14} aria-hidden />Share</button>
    <button title="More list actions" ref={trigger} type="button" aria-label="More list actions" aria-haspopup="menu" aria-expanded={!!anchor} data-testid="collection-more" disabled={asking} className={`${headerButton()} sm:hidden disabled:opacity-60`} onClick={() => setAnchor(trigger.current?.getBoundingClientRect() ?? null)}><MoreHorizontal size={16} aria-hidden /></button>
    {anchor && <><BackdropLayer className="z-[60]" onClick={close} /><PopoverLayer ref={menu} role="menu" aria-label="List actions" style={{ left: anchor.left, top: anchor.bottom + 4, width: 180 }} className="z-[61] rounded-lg border border-line bg-surface p-1 shadow-xl dark:border-slate-600">
      <button type="button" role="menuitem" className="flex w-full items-center gap-2 rounded px-3 py-2 text-sm text-content hover:bg-subtle" onClick={open}><Share2 size={14} aria-hidden />Share</button>
    </PopoverLayer></>}
    {people.length > 0 && <button type="button" data-testid="collection-shared-with" onClick={open} className="text-xs text-muted hover:underline">Shared with {people.length === 1 ? people[0]!.to : `${people.length} people`}</button>}
    {shares.error && <span className="text-xs text-ember-600 dark:text-ember-400">{(shares.error as Error).message}</span>}
  </>;
}
