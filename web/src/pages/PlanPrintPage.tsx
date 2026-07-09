// /print/:slug/locations/:id — a print-friendly floor plan. Chrome-less
// top-level route (the portal pattern): white paper, black lines, the
// location's plan(s) at full width — a house prints every floor stacked.
// Deliberately committed to LIGHT styling regardless of theme: this page's
// one job is paper.

import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { usePageTitle } from "@cobblr/platform-web";
import { api, type Location } from "../lib/api";
import {
  planOwnerOf,
  readBound,
  readRect,
  wallSegments,
  type FpBound,
} from "../lib/floorplanGeometry";

const pct = (v: number, total: number) => `${(v / total) * 100}%`;

export function PlanPrintPage() {
  const { slug, id } = useParams<{ slug: string; id: string }>();
  const locs = useQuery({
    queryKey: ["core-locations", slug],
    queryFn: () => api.listLocations(slug!),
    enabled: !!slug,
  });
  const items = useMemo(() => locs.data?.items ?? [], [locs.data]);
  const byId = useMemo(() => new Map(items.map((l) => [l.id, l] as const)), [items]);
  const root = id ? byId.get(id) : undefined;
  usePageTitle(root ? `${root.name} — plan` : "Plan");

  if (locs.isLoading) return <div style={{ padding: 24 }}>Loading…</div>;
  if (!root) return <div style={{ padding: 24 }}>Location not found.</div>;

  // A house prints every floor; a single-plan location prints itself.
  const rootBound = readBound(root.metadata);
  const plans: Location[] = rootBound
    ? [root]
    : items.filter((l) => l.parent_id === root.id && l.kind === "area" && readBound(l.metadata));

  return (
    <div
      style={{
        background: "#fff",
        color: "#111",
        minHeight: "100vh",
        padding: "32px 40px",
        fontFamily: "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
      }}
    >
      <style>{`@media print { .no-print { display: none !important; } }`}</style>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>{root.name}</h1>
        <span style={{ fontSize: 12, color: "#666" }}>
          {slug} · {new Date().toLocaleDateString()}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => window.print()}
          className="no-print"
          style={{
            font: "inherit",
            fontSize: 13,
            padding: "6px 14px",
            border: "1px solid #999",
            borderRadius: 6,
            background: "#f5f5f5",
            cursor: "pointer",
          }}
        >
          Print
        </button>
      </div>
      {plans.length === 0 && <p>No plan drawn for this location yet.</p>}
      {plans.map((p) => (
        <PrintPlan key={p.id} owner={p} items={items} byId={byId} multi={plans.length > 1} />
      ))}
    </div>
  );
}

function PrintPlan({
  owner,
  items,
  byId,
  multi,
}: {
  owner: Location;
  items: Location[];
  byId: Map<string, Location>;
  multi: boolean;
}) {
  const bound = readBound(owner.metadata) as FpBound;
  const placed = items
    .filter((l) => l.id !== owner.id && readRect(l.metadata) && planOwnerOf(l.id, byId) === owner.id)
    .map((l) => ({ loc: l, rect: readRect(l.metadata)! }));
  const rooms = placed.filter((p) => p.loc.kind === "area" && readBound(p.loc.metadata));
  const zones = placed.filter((p) => p.loc.kind === "area" && !readBound(p.loc.metadata));
  const boxes = placed.filter((p) => p.loc.kind !== "area");
  return (
    <div style={{ breakInside: "avoid", marginTop: multi ? 28 : 16 }}>
      {multi && <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>{owner.name}</h2>}
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: `${bound.w_mm} / ${bound.d_mm}`,
          border: "2px solid #333",
          borderRadius: 3,
        }}
      >
        {(bound.walls ?? []).map((w, wi) =>
          wallSegments(w).map((s, si) => {
            const vertical = s.x1 === s.x2;
            return (
              <div
                key={`${wi}-${si}`}
                style={{
                  position: "absolute",
                  background: "#333",
                  ...(vertical
                    ? { left: pct(s.x1, bound.w_mm), top: pct(s.y1, bound.d_mm), width: 3, height: pct(s.y2 - s.y1, bound.d_mm), transform: "translateX(-1.5px)" }
                    : { left: pct(s.x1, bound.w_mm), top: pct(s.y1, bound.d_mm), height: 3, width: pct(s.x2 - s.x1, bound.w_mm), transform: "translateY(-1.5px)" }),
                }}
              />
            );
          }),
        )}
        {zones.map(({ loc, rect }) => (
          <span
            key={loc.id}
            style={{
              position: "absolute",
              left: pct(rect.x_mm + rect.w_mm / 2, bound.w_mm),
              top: pct(rect.y_mm + rect.d_mm / 2, bound.d_mm),
              transform: "translate(-50%, -50%)",
              fontFamily: "ui-monospace, Menlo, monospace",
              fontSize: 10,
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "#999",
            }}
          >
            {loc.name}
          </span>
        ))}
        {rooms.map(({ loc, rect }) => (
          <div
            key={loc.id}
            style={{
              position: "absolute",
              left: pct(rect.x_mm, bound.w_mm),
              top: pct(rect.y_mm, bound.d_mm),
              width: pct(rect.w_mm, bound.w_mm),
              height: pct(rect.d_mm, bound.d_mm),
              border: "1px solid #777",
              borderRadius: 3,
            }}
          >
            <span style={{ position: "absolute", top: 2, left: 5, fontSize: 10, fontWeight: 600 }}>
              {loc.name}
            </span>
          </div>
        ))}
        {boxes.map(({ loc, rect }) => {
          const narrow = rect.d_mm > rect.w_mm * 1.4;
          return (
            <div
              key={loc.id}
              style={{
                position: "absolute",
                left: pct(rect.x_mm, bound.w_mm),
                top: pct(rect.y_mm, bound.d_mm),
                width: pct(rect.w_mm, bound.w_mm),
                height: pct(rect.d_mm, bound.d_mm),
                border: "1px solid #333",
                borderRadius: 2,
                background: rect.wall_mounted ? "#eee" : "#f8f8f8",
                overflow: "hidden",
                fontSize: 9.5,
                lineHeight: 1.2,
                padding: "1px 3px",
                ...(narrow ? { writingMode: "vertical-rl" as const } : {}),
              }}
            >
              {loc.short_name || loc.name}
            </div>
          );
        })}
      </div>
    </div>
  );
}
