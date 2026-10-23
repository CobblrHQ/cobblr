import { useRecordRuns } from "./record-runs";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface RecordActionDescriptor { id: string; group: string; primary?: boolean; label: string; description: string; badge?: string }
interface Surface { items: RecordActionDescriptor[]; declare: (item: RecordActionDescriptor) => () => void; targets: Map<string, HTMLElement>; setTarget: (id: string, target: HTMLElement | null) => void }
const Context = createContext<Surface | null>(null);
export function useRecordActionContributions() {
  const [items, setItems] = useState<RecordActionDescriptor[]>([]);
  const [targets, setTargets] = useState(new Map<string, HTMLElement>());
  const declare = useCallback((item: RecordActionDescriptor) => {
      setItems((old) => [...old.filter((i) => i.id !== item.id), item]);
      return () => setItems((old) => old.filter((i) => i.id !== item.id));
    }, []);
  const setTarget = useCallback((id: string, target: HTMLElement | null) => setTargets((old) => {
      if (old.get(id) === target || (!target && !old.has(id))) return old;
      const next = new Map(old); if (target) next.set(id, target); else next.delete(id); return next;
    }), []);
  return useMemo<Surface>(() => ({ items, targets, declare, setTarget }), [items, targets, declare, setTarget]);
}
export const RecordActionProvider = Context.Provider;

export function RecordActionItem({ children, action, ...item }: RecordActionDescriptor & {
  children: ReactNode;
  /** The action it runs: drawn, and listed in a menu, only where it runs (#7922). */
  action?: string;
}) {
  const surface = useContext(Context);
  const declare = surface?.declare;
  const key = JSON.stringify(item);
  const runs = useRecordRuns()(action ?? "");
  // Descriptor changes follow the record; the button and its dialogs stay in
  // their owning component, even when the menu holding the button closes.
  useEffect(() => (runs ? declare?.(JSON.parse(key) as RecordActionDescriptor) : undefined), [declare, key, runs]);
  if (!runs) return null;
  if (!surface) return <>{children}</>;
  const target = surface.targets.get(item.id);
  return target ? createPortal(children, target) : null;
}

export function RecordActionSlot({ id }: { id: string }) {
  const surface = useContext(Context)!;
  const setTarget = surface.setTarget;
  const ref = useMemo(() => (target: HTMLDivElement | null) => setTarget(id, target), [id, setTarget]);
  return <div ref={ref} className="[&>button]:w-full [&>button]:justify-start [&>a]:w-full [&>span]:w-full" />;
}
