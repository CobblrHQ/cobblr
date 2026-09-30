// Dragging a card to another column of a board (#4173): the one Trello gesture
// a board was missing. Dropping a card on a column sets the field the board is
// grouped by to that column's value, through the kind's own writer
// (useViewRecordEdit): shown at once, rolled back with a note when refused.
//
// Only a field with declared choices can be dragged across: its columns ARE
// its legal values, so a drop can never write something the field does not
// allow. "No value" clears it. A board grouped by anything else stays a view.
//
// A mouse drags after 6 px; a finger after holding for a quarter second (so a
// swipe still scrolls the board); a keyboard picks a card up with Space or
// Enter and moves it a column at a time with the arrows (columnCoordinates).
import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { swallowNextClick } from "../../lib/swallow-click";
import { stepDay } from "../../lib/view-dates";

type BoardRow = { kind: string; id: string; title: string };

interface BoardDragCtx {
  enabled: boolean;
}
const Ctx = createContext<BoardDragCtx>({ enabled: false });

/** The keyboard's step: from the column the card is over to the next one
 *  left or right, by their drawn positions. Pure, so it is tested without a
 *  browser. */
export function nextColumnCenter(
  columns: Array<{ id: string; left: number; top: number; width: number; height: number }>,
  overId: string | null,
  direction: "left" | "right",
): { x: number; y: number } | null {
  const sorted = [...columns].sort((a, b) => a.left - b.left);
  const at = sorted.findIndex((c) => c.id === overId);
  const target = sorted[direction === "right" ? (at < 0 ? 0 : at + 1) : at - 1];
  if (!target) return null;
  return { x: target.left + target.width / 2, y: target.top + Math.min(target.height / 2, 40) };
}

export const columnCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  if (event.code !== "ArrowRight" && event.code !== "ArrowLeft") return undefined;
  event.preventDefault();
  const columns = [...context.droppableRects.entries()].map(([id, r]) => ({ id: String(id), left: r.left, top: r.top, width: r.width, height: r.height }));
  const next = nextColumnCenter(columns, context.over ? String(context.over.id) : null, event.code === "ArrowRight" ? "right" : "left");
  return next ?? undefined;
};

/** A calendar's keyboard step: the drop targets are days ("YYYY-MM-DD"),
 *  ←/→ a day and ↑/↓ a week from the day the entry is over. */
export const dayCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code)) return undefined;
  event.preventDefault();
  const over = context.over ? String(context.over.id) : null;
  const from = over ?? (context.active?.data.current?.column as string | undefined) ?? null;
  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) return undefined;
  const r = context.droppableRects.get(stepDay(from, event.code as "ArrowLeft"));
  return r ? { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 20) } : undefined;
};

export function BoardDnd({
  enabled,
  label,
  onMove,
  keys = columnCoordinates,
  children,
}: {
  enabled: boolean;
  /** How the arrow keys move a picked-up card: between columns by default. */
  keys?: KeyboardCoordinateGetter;
  /** A column's words, for what a screen reader is told. */
  label: (column: string) => string;
  onMove: (row: BoardRow, toColumn: string) => void;
  children: ReactNode;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keys }),
  );
  const announcements: Announcements = useMemo(
    () => ({
      onDragStart: ({ active }) => `Picked up ${(active.data.current?.row as BoardRow | undefined)?.title ?? "the card"}. Use the arrow keys to move it, Space to put it down.`,
      onDragOver: ({ over }) => (over ? `Over ${label(String(over.id))}.` : "Not over a column."),
      onDragEnd: ({ active, over }) => (over ? `${(active.data.current?.row as BoardRow | undefined)?.title ?? "The card"} moved to ${label(String(over.id))}.` : "Put back."),
      onDragCancel: () => "Put back where it was.",
    }),
    [label],
  );
  const value = useMemo(() => ({ enabled }), [enabled]);
  if (!enabled) return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
  const onDragEnd = (e: DragEndEvent) => {
    const row = e.active.data.current?.row as BoardRow | undefined;
    const from = e.active.data.current?.column as string | undefined;
    const to = e.over ? String(e.over.id) : null;
    if (!row || !to || to === from) return;
    onMove(row, to);
  };
  return (
    <Ctx.Provider value={value}>
      <DndContext sensors={sensors} onDragStart={() => swallowNextClick()} onDragEnd={onDragEnd} accessibility={{ announcements }}>
        {children}
      </DndContext>
    </Ctx.Provider>
  );
}

/** A column a card can be dropped on (when the board can be dragged). */
export function useBoardColumn(column: string) {
  const { enabled } = useContext(Ctx);
  const drop = useDroppable({ id: column, disabled: !enabled });
  return { ref: drop.setNodeRef, over: enabled && drop.isOver };
}

/** A card that can be picked up (when the board can be dragged). */
export function useBoardCard(row: BoardRow, column: string) {
  const { enabled } = useContext(Ctx);
  const drag = useDraggable({ id: `${row.kind}:${row.id}`, data: { row, column }, disabled: !enabled });
  return {
    enabled,
    ref: drag.setNodeRef,
    props: enabled ? { ...drag.attributes, ...drag.listeners } : {},
    style: drag.transform ? { transform: `translate3d(${drag.transform.x}px, ${drag.transform.y}px, 0)`, zIndex: 50, position: "relative" as const } : undefined,
    dragging: drag.isDragging,
  };
}
