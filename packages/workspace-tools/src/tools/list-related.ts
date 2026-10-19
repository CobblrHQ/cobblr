import { pairingResultPresentation } from "@cobblr/platform-contract/pairing-presentation";
import { z } from "zod";
import { apiErrorMessage, toolFail, toolOk } from "../api.js";
import { LOCATION_KIND, PLACED_IN, type WorkspaceTool, moduleIsOff, placementAsked } from "../tool-kit.js";

const tool: WorkspaceTool = {
  name: "list_related",
  description:
    "List links to a record, including project, build inputs and placed_in contents. Locations include sub-locations; query a bin for its contents. Kind and id list all links.",
  mode: "read",
  paging: { by: "one-call", why: "every link of ONE record, both directions, in one call" },
  params: {
    kind: z.string().describe("The record's entity kind id"),
    id: z.string().describe("The record's id"),
    relationship: z.string().optional().describe("Only links of this relationship kind"),
    direction: z
      .enum(["out", "in", "both"])
      .optional()
      .describe("out = links this record points at, in = links pointing at it (default both)"),
  },
  execute: async (api, args) => {
    const kind = String(args.kind ?? "");
    const id = String(args.id ?? "");
    if (!kind || !id) return toolFail("kind and id are required");
    const rel =
      typeof args.relationship === "string" && args.relationship.trim()
        ? `&relationship_kind=${encodeURIComponent(args.relationship.trim())}`
        : "";
    const dir = args.direction === "out" || args.direction === "in" ? args.direction : "both";
    type PairingRow = {
      id: string;
      source_kind: string;
      source_id: string;
      target_kind: string;
      target_id: string;
      relationship_kind: string;
      notes?: string | null;
      metadata?: { result?: unknown } | null;
    };
    const fetchSide = async (side: "out" | "in") => {
      const who = side === "out" ? "source" : "target";
      const res = await api.request(
        "GET",
        `/pairings?${who}_kind=${encodeURIComponent(kind)}&${who}_id=${encodeURIComponent(id)}${rel}`,
      );
      if (res.status >= 400) throw new Error(apiErrorMessage(res, "couldn't list pairings"));
      return ((res.body.items as PairingRow[] | undefined) ?? []).map((p) => {
        const result = pairingResultPresentation(p.metadata?.result);
        return {
          relationship: p.relationship_kind,
          direction: side,
          kind: side === "out" ? p.target_kind : p.source_kind,
          id: side === "out" ? p.target_id : p.source_id,
          ...(p.notes ? { notes: p.notes } : {}),
          ...(result ? { title: result.label, href: result.href, ...(result.open_label ? { open_label: result.open_label } : {}) } : {}),
          pairing_id: p.id,
        };
      });
    };
    // Placement is the platform's "what is inside what", its own table and
    // not a pairing. A tool that promises what is stored in a location and
    // reads pairings alone answers "empty" for every bin a person filled by
    // placing things in it, which is how they fill bins.
    const wantsPlacement = placementAsked(args.relationship);
    type Placed = { kind: string; id: string; title?: string };
    const placedRow = (side: "out" | "in", e: Placed) => ({
      relationship: PLACED_IN,
      direction: side,
      kind: e.kind,
      id: e.id,
      ...(typeof e.title === "string" && e.title ? { title: e.title } : {}),
    });
    // A workspace without placement (or locations) has nothing inside
    // anything: that module being off is the one failure that is an empty
    // answer. Any other (a 500, a refusal, a lost connection) is a read that
    // did not happen, and "nothing there" would describe a full bin as
    // empty (#7146).
    const unread = (res: { status: number; body: Record<string, unknown> }, what: string) => {
      if (res.status < 400 || moduleIsOff(res)) return null;
      return new Error(apiErrorMessage(res, `couldn't read ${what}`));
    };
    const contents = async () => {
      const res = await api.request(
        "GET",
        `/modules/core-placement/contents?container_kind=${encodeURIComponent(kind)}&container_id=${encodeURIComponent(id)}`,
      );
      const failed = unread(res, "what is inside it");
      if (failed) throw failed;
      if (res.status >= 400) return [];
      return ((res.body?.items as Placed[] | undefined) ?? []).map((e) => placedRow("in", e));
    };
    const containerOf = async () => {
      const res = await api.request(
        "GET",
        `/modules/core-placement/of?containee_kind=${encodeURIComponent(kind)}&containee_id=${encodeURIComponent(id)}`,
      );
      const failed = unread(res, "where it is");
      if (failed) throw failed;
      if (res.status >= 400) return [];
      const c = res.body?.container as Placed | null | undefined;
      return c ? [placedRow("out", c)] : [];
    };
    // Locations nest through core-locations' own parent_id, which placement
    // does not carry, so a garage's contents were only what was placed
    // straight into it and never its shelves and bins: "what's in the
    // garage?" read "The Garage is empty" over a shelf and two full bins
    // (2026-09-20). The tree is one read of the locations list.
    const tree = async (): Promise<Array<ReturnType<typeof placedRow>>> => {
      if (kind !== LOCATION_KIND) return [];
      const res = await api.request("GET", "/modules/core-locations/locations");
      const failed = unread(res, "the locations inside it");
      if (failed) throw failed;
      if (res.status >= 400) return [];
      type Loc = { id: string; name?: string; parent_id?: string | null };
      const rows = (res.body?.items as Loc[] | undefined) ?? [];
      const me = rows.find((r) => r.id === id);
      const parent = me?.parent_id ? rows.find((r) => r.id === me.parent_id) : undefined;
      const asPlaced = (r: Loc): Placed => ({ kind: LOCATION_KIND, id: r.id, ...(r.name ? { title: r.name } : {}) });
      return [
        ...(dir !== "out" ? rows.filter((r) => r.parent_id === id).map((r) => placedRow("in", asPlaced(r))) : []),
        ...(dir !== "in" && parent ? [placedRow("out", asPlaced(parent))] : []),
      ];
    };
    try {
      const items = (
        await Promise.all([
          dir !== "in" ? fetchSide("out") : Promise.resolve([]),
          dir !== "out" ? fetchSide("in") : Promise.resolve([]),
          // Whatever direction was asked for. A pairing's direction is
          // arbitrary and worth narrowing; a placement has one meaning,
          // and a model asks a thing for its links pointing IN when it
          // means "what is it in" (the live bench, 2026-09-16: the CubePro
          // asked IN, the Garage asked OUT, both told "nothing").
          wantsPlacement ? containerOf() : Promise.resolve([]),
          wantsPlacement ? contents() : Promise.resolve([]),
          wantsPlacement ? tree() : Promise.resolve([]),
        ])
      ).flat();
      return toolOk({ items });
    } catch (err) {
      return toolFail(err instanceof Error ? err.message : "couldn't list pairings");
    }
  },
};

export default tool;
