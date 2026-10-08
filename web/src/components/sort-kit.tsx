// Drag-to-reorder for the app shell's lists (the sidebar nav, the workspace
// switcher), loaded after the first paint by useSortKit. dnd-kit is about 11 KB
// of gzipped script that every page used to download before drawing anything,
// for a gesture nobody makes until they choose to rearrange (#5016's budget).
// sort-kit-static.tsx draws the same rows without it until this arrives.
import type { CSSProperties, ReactNode } from "react";
import {
  DndContext,
  MouseSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { VERTICAL_DRAG } from "../lib/vertical-drag";
import { useDragClickGuard } from "./useDragClickGuard";
import type { SortKit } from "./sort-kit-static";

/** One list's drag. `hold`: the sidebar's rows are links, so a mouse must MOVE
 *  8px to drag (a click that does not travel still navigates) and a finger must
 *  HOLD 250ms (a finger that moves at once is scrolling the list). `pointer`:
 *  rows that drag by a grip handle start on the pointer. */
function Root({ grip, onDrop, children }: { grip: "hold" | "pointer"; onDrop: (activeId: string, overId: string) => void; children: ReactNode }) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
  );
  // A grip still needs 6px of travel, so a tap on it is not a drag.
  const pointer = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const onDragEnd = (e: DragEndEvent) => {
    if (e.over) onDrop(String(e.active.id), String(e.over.id));
  };
  return (
    <DndContext {...VERTICAL_DRAG} sensors={grip === "hold" ? sensors : pointer} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      {children}
    </DndContext>
  );
}

function Group({ ids, children }: { ids: string[]; children: ReactNode }) {
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      {children}
    </SortableContext>
  );
}

/** A whole row that drags (Notion-style). Its content gets the drag props, so
 *  the caller puts them on the element that should start a drag. */
function Row({ id, children }: { id: string; children: (handle: Record<string, unknown>) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  // A drag that reorders nothing still ends in a click. See useDragClickGuard.
  useDragClickGuard(isDragging);
  return (
    <div
      ref={setNodeRef}
      // Every row here is a link, and a browser drags a link NATIVELY: the
      // moment the pointer moves, the page starts a link-drag and the sortable
      // never sees another pointer event (2026-09-08). Refusing dragstart keeps
      // the pointer with the sortable.
      onDragStart={(e) => e.preventDefault()}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-60 cursor-grabbing" : undefined}
    >
      {children({ ...attributes, ...listeners })}
    </div>
  );
}

/** One child row inside a group, draggable among its own siblings. Each child
 *  carries its own listeners: inside its parent's, grabbing a child dragged the
 *  whole block (reported 2026-09-04). */
function Child({ id, children }: { id: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  useDragClickGuard(isDragging);
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onDragStart={(e) => e.preventDefault()}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? "opacity-60 cursor-grabbing" : undefined}
    >
      {children}
    </div>
  );
}

/** A row that drags by a grip handle only: `grip` gets the handle's props.
 *  Its content is buttons, not links, so there is no click to guard. */
function Handled({ id, children }: { id: string; children: (grip: Record<string, unknown> | null) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 };
  return (
    <div ref={setNodeRef} style={style}>
      {children({ ...attributes, ...listeners })}
    </div>
  );
}

export const sortKit: SortKit = { draggable: true, Root, Group, Row, Child, Handled };
