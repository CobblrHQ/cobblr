import { RecordFormModal, useToast } from "@cobblr/platform-web";
// The Locations page "Floor Plan" tab: pick a space up front and see its layout,
// instead of hunting into each location's detail page. Areas draw as a top-down
// floor plan; containers draw as a front elevation (drawers/shelves at true
// scale). Reuses the same <FloorPlan> editor the detail page mounts.

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Boxes, MapPin, Plus } from "lucide-react";
import { ApiError, api, type Location } from "../lib/api";
import { withBound } from "../lib/floorplanGeometry";
import { parseLength, type LengthUnit } from "../lib/lengthUnits";
import { useSelectedSpace } from "./placeItems/useSelectedSpace";
import { FloorPlan } from "./FloorPlan";
import { PlanFileButtons } from "./ImportPlanDialog";

/** Spaces worth a chip: every root AREA (a room/region), plus every CONTAINER
 *  that is either standalone (no parent) or has a layout of its own (a tool
 *  chest's face) — so a shelving unit is reachable up front without a chip per
 *  drawer: a drawer only placed on a face is reached by opening the face.
 *  Areas first, then containers; each group sorted by the user's sort_order
 *  then name. */
export { viewableSpaces } from "./placeItems/useSelectedSpace";

/** A room in one step: what it is called and how big it is, and it is drawn.
 *  Before, a person made a place in one form, found the plan, and sized it in
 *  another. */
function RoomForm({ slug, onMade }: { slug: string; onMade: (loc: Location) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState("");
  const [w, setW] = useState("");
  const [d, setD] = useState("");
  const unitOf = (t: string): LengthUnit => {
    const u = t.trim().toLowerCase().match(/(ft|feet|foot|in|mm|cm|m|'|")\s*$/)?.[1];
    return u === "in" || u === '"' ? "in" : u === "m" || u === "cm" || u === "mm" ? u : "ft";
  };
  const wmm = parseLength(w, "ft");
  const dmm = parseLength(d, "ft");
  const ready = !!name.trim() && !!wmm && !!dmm;
  const make = useMutation({
    mutationFn: () =>
      api.createLocation(slug, {
        name: name.trim(),
        parent_id: null,
        kind: "area",
        metadata: withBound({}, { w_mm: wmm!, d_mm: dmm!, unit: unitOf(w), view: "plan" }, "area"),
      }),
    onSuccess: (loc) => {
      void qc.invalidateQueries({ queryKey: ["core-locations", slug] });
      toast.success(`${name.trim()} is drawn. Add what stands in it next.`);
      onMade(loc as Location);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : String(e)),
  });
  const field = "min-w-0 rounded border border-line dark:border-slate-600 bg-surface dark:bg-slate-900 px-2 py-1.5 text-sm text-content dark:text-slate-200";
  return (
    <form
      data-testid="room-form"
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !make.isPending) make.mutate();
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What room is this? (e.g. Garage)" aria-label="Room name" autoFocus className={`${field} w-full`} />
      <div className="flex items-center gap-1.5">
        <input value={w} onChange={(e) => setW(e.target.value)} placeholder="width, e.g. 20ft" aria-label="Width" className={`${field} flex-1`} />
        <span className="text-faint text-sm">×</span>
        <input value={d} onChange={(e) => setD(e.target.value)} placeholder="depth, e.g. 12ft" aria-label="Depth" className={`${field} flex-1`} />
      </div>
      <p className="text-[11px] text-faint dark:text-slate-500">Roughly is fine: the size only sets the shape, and you can change it later.</p>
      <button
        type="submit"
        disabled={!ready || make.isPending}
        className="rounded bg-cobble-600 hover:bg-cobble-700 text-white px-3 py-1.5 text-sm transition disabled:opacity-50"
      >
        {make.isPending ? "Drawing…" : "Draw it"}
      </button>
    </form>
  );
}

export function LocationFloorPlanTab({
  items,
  slug,
  onCreate,
  newRoom = false,
  onNewRoomClosed,
}: {
  items: Location[];
  slug: string;
  onCreate?: () => void;
  /** Open the room form over the plan (the command palette's "Draw a room"). */
  newRoom?: boolean;
  onNewRoomClosed?: () => void;
}) {
  const [roomOpen, setRoomOpen] = useState(false);
  const showRoom = roomOpen || newRoom;
  const closeRoom = () => {
    setRoomOpen(false);
    onNewRoomClosed?.();
  };
  // The open room or container is the address's `space`, shared with Place
  // items, so the button between the two pages keeps it (#4557).
  const { areas, containers, active, choose: setSelectedId } = useSelectedSpace(items);
  const activeId = active?.id ?? null;

  if (!active) {
    return (
      <div className="rounded-xl border border-dashed border-line dark:border-slate-700 p-4 sm:p-6 text-sm text-muted dark:text-slate-400 max-w-md space-y-3">
        <p className="font-medium text-content dark:text-mortar-100">Draw your first room</p>
        <RoomForm slug={slug} onMade={(loc) => { setSelectedId(loc.id); onNewRoomClosed?.(); }} />
        {onCreate && (
          <button type="button" onClick={onCreate} className="text-xs text-accent hover:underline">
            Or start with a tool chest or a shelf instead
          </button>
        )}
        <p className="text-xs">Or bring a whole house in from a file another AI made:</p>
        <div className="flex flex-wrap gap-2">
          <PlanFileButtons slug={slug} exportId={null} exportName={null} />
        </div>
      </div>
    );
  }

  const chip = (l: Location) => (
    <button
      key={l.id}
      type="button"
      onClick={() => setSelectedId(l.id)}
      className={
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition " +
        (l.id === activeId
          ? "border-accent text-accent bg-cobble-50 dark:bg-cobble-900/30"
          : "border-line dark:border-slate-600 text-content dark:text-mortar-100 hover:border-accent hover:text-accent")
      }
    >
      {l.kind === "container" ? <Boxes size={13} /> : <MapPin size={13} />}
      {l.name}
    </button>
  );

  return (
    <div className="space-y-3">
      {showRoom && (
        <RecordFormModal open onClose={closeRoom} title="A new room">
          <RoomForm
            slug={slug}
            onMade={(loc) => {
              setSelectedId(loc.id);
              closeRoom();
            }}
          />
        </RecordFormModal>
      )}
      {(
        <div className="flex flex-wrap items-center gap-2">
          {areas.length > 0 && (
            <>
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500">area</span>
              {areas.map(chip)}
            </>
          )}
          {containers.length > 0 && (
            <>
              <span className="text-[10px] font-mono uppercase tracking-widest text-faint dark:text-slate-500 ml-1">container</span>
              {containers.map(chip)}
            </>
          )}
          <button
            type="button"
            onClick={() => setRoomOpen(true)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-line dark:border-slate-600 px-3 py-1 text-sm text-muted hover:border-accent hover:text-accent transition"
          >
            <Plus size={13} /> room
          </button>
          <span className="flex-1" />
          <PlanFileButtons slug={slug} exportId={active.kind === "area" ? active.id : null} exportName={active.name} />
        </div>
      )}
      {/* key resets the editor's per-space state when you switch chips. */}
      <FloorPlan key={active.id} room={active} slug={slug} />
    </div>
  );
}
